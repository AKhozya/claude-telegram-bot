/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, typing indicator.
 */

import type { Context } from "grammy";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  TEMP_DIR,
  TEMP_REAP_INTERVAL_MS,
  TEMP_RETENTION_MS,
} from "./config";

// ============== Audit Logging ==============

/**
 * Everything an audit record must not be written through.
 *
 * `O_NOFOLLOW` is the load-bearing one. Under AUDIT_LOG_JSON a record carries the whole
 * Telegram message and Claude's whole reply, untruncated, and the default path is in a
 * shared `/tmp`. A local user who leaves a symlink there collects every record; a chmod
 * does not stop that, because it follows the link and tightens a file its owner can
 * loosen again. Refusing to open a symlink at all is what stops it.
 *
 * `O_NONBLOCK` guards a cheaper attack on the same path: a FIFO left at it. Opening one
 * for writing waits for a reader, and waits forever if none comes — the bot would hang on
 * its first audit write. With this flag that open fails ENXIO instead. It changes nothing
 * for the regular file this is meant to be.
 */
const AUDIT_OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

/**
 * Is this descriptor safe to write a message body into? Tighten it first if not.
 *
 * Every question is asked of the open descriptor, never of the path. Checking the path and
 * then appending to it is two different lookups: an attacker who wins the gap between them
 * gets the record anyway. `fstat` and `fchmod` here cannot be redirected, and the answer is
 * recomputed per record rather than cached, so one safe moment does not authorize the rest
 * of the process's life.
 *
 * The chmod is attempted whenever anything above comes back wrong, which is usually a 0644
 * log left by a build that predates this. That repair has a limit: it changes the inode's
 * mode and cannot revoke a descriptor somebody already holds on it, so a log that was ever
 * readable stays readable to whoever opened it in time. Rotating such a file aside would
 * close that, and is left to the operator rather than done to their log.
 *
 * `nlink === 1` is that limit's one detectable form. A second name for the inode is what an
 * attacker makes to keep their handle alive across a rotation of this path, and it is the
 * only trace they leave; without a link they can simply open a 0644 log and the chmod is
 * again too late. Refusing an inode that has one is cheap and catches the durable variant.
 *
 * A missing `getuid` needs no branch of its own: `stat.uid === undefined` is false, so the
 * comparison already calls it unsafe. `isFile` rejects what O_NONBLOCK let through — a
 * device node at this path opens fine.
 *
 * Mode bits are not the whole story: an extended ACL can grant access this cannot see.
 */
async function isPrivate(handle: fs.FileHandle): Promise<boolean> {
  const check = async () => {
    const stat = await handle.stat();
    const uid = process.getuid?.();
    return (
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.uid === uid &&
      (stat.mode & 0o077) === 0
    );
  };
  if (await check()) return true;
  try {
    await handle.chmod(0o600);
  } catch (error) {
    console.error("Failed to restrict audit log permissions:", error);
  }
  return check();
}

async function writeAuditLog(event: AuditEvent): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    // Throws on a symlink, which is the point — see AUDIT_OPEN_FLAGS. The mode applies
    // only when this call creates the file; `isPrivate` handles one that already exists.
    handle = await fs.open(AUDIT_LOG_PATH, AUDIT_OPEN_FLAGS, 0o600);
    if (!(await isPrivate(handle))) {
      // Nothing is written, not even the metadata. A record here would go to a file
      // someone else can read, and would still be missing from the log its operator
      // believes they have.
      console.error(
        `Audit log ${AUDIT_LOG_PATH} is not private - dropping this record`
      );
      return;
    }

    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      content = lines.join("\n") + "\n";
    }

    // Through the descriptor that was checked, not the path that was checked. `writeFile`
    // rather than `write`: the latter reports a short write in `bytesWritten` and leaves
    // the rest to the caller, and half a record would run into the next one.
    await handle.writeFile(content);
  } catch (error) {
    console.error("Failed to write audit log:", error);
  } finally {
    // Deferred write errors surface here, so a swallowed close loses a record silently.
    await handle
      ?.close()
      .catch((error) => console.error("Failed to close audit log:", error));
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await writeAuditLog(event);
}


export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Typing Indicator ==============

export function startTypingIndicator(ctx: Context): { stop: () => void } {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        console.debug("Typing indicator failed:", error);
      }
      await Bun.sleep(4000);
    }
  };

  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Temp Files ==============

/**
 * A temp dir nobody else will pick. The random suffix is load-bearing: Date.now() alone
 * collides on concurrent same-ms uploads, and the loser's cleanup deletes the winner's
 * files. Exported for the collision test.
 */
export function uniqueTempDir(prefix: string): string {
  return `${TEMP_DIR}/${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============== Temp Reaper ==============

/**
 * `lstat`, not `stat`: a symlink must be aged by the link itself, or one pointing at a
 * fresh file keeps a stale entry alive forever. `rm` on a symlink unlinks the link,
 * never the target.
 *
 * dir/age/clock are injectable so the test does not have to wait an hour.
 */
export async function reapTempDir(
  dir: string = TEMP_DIR,
  maxAgeMs: number = TEMP_RETENTION_MS,
  now: number = Date.now()
): Promise<number> {
  // Behind config validation, because the failure mode is deletion: a NaN age makes the
  // keep-if-young test false for every entry, sweeping the whole directory.
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    console.error(`Temp reaper: refusing to sweep ${dir} with maxAgeMs=${maxAgeMs}`);
    return 0;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    console.warn(`Temp reaper: cannot read ${dir}:`, error);
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (name === ".keep") continue; // the marker that makes TEMP_DIR exist
    const path = `${dir}/${name}`;
    try {
      const info = await fs.lstat(path);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await fs.rm(path, { recursive: true, force: true });
      removed++;
    } catch (error) {
      console.debug(`Temp reaper: skipped ${path}:`, error);
    }
  }
  if (removed > 0) {
    console.log(`Temp reaper: removed ${removed} stale entries from ${dir}`);
  }
  return removed;
}

export function startTempReaper(
  intervalMs: number = TEMP_REAP_INTERVAL_MS
): { stop: () => void } {
  // Sweep once at boot too: a pod that restarts more often than the interval would
  // otherwise never reach a tick, and restarts are exactly when /tmp is already dirty.
  void reapTempDir();
  const timer = setInterval(() => void reapTempDir(), intervalMs);
  timer.unref?.(); // a pending sweep must never hold the process open on shutdown
  return { stop: () => clearInterval(timer) };
}

