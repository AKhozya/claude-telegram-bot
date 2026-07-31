import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  constants,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  utimesSync,
  lutimesSync,
  lstatSync,
  statSync,
  chmodSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "fs";

const AUDIT_PATH = `/tmp/audit-mode-test-${process.pid}.log`;
process.env.AUDIT_LOG_PATH = AUDIT_PATH;

const { reapTempDir } = await import("./utils");

const HOUR = 60 * 60 * 1000;

// mtime is set explicitly rather than by sleeping — the reaper takes `now` for exactly this.
const age = (path: string, hoursAgo: number) => {
  const t = (Date.now() - hoursAgo * HOUR) / 1000;
  utimesSync(path, t, t);
};

// The JSON branch writes the message and response unredacted, so a world-readable log
// hands any local user whatever was pasted into Telegram.
//
// Each case runs in a subprocess: AUDIT_LOG_PATH is read once at config module-eval and
// bun test shares one module registry across files, so an in-process call here would
// write to the real /tmp/claude-telegram-audit.log.
// `prelude` runs before the import, which is the only way to reach the checks that would
// otherwise need a file belonging to another user: the subprocess can lie about its own uid.
const writeTwoAuditLines = async (
  prelude = "",
  env: Record<string, string> = {}
): Promise<number> => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `${prelude}
       const { auditLog } = await import("${import.meta.dir}/utils.ts");
       await auditLog(1, "tester", "TEXT", "hunter2", "ok");
       await auditLog(1, "tester", "TEXT", "again");`,
    ],
    {
      env: { ...process.env, AUDIT_LOG_PATH: AUDIT_PATH, ...env },
      stdout: "ignore",
      stderr: "inherit",
    }
  );
  return await proc.exited;
};

describe("audit log permissions", () => {
  // Unconditional: a failed assertion would otherwise strand the log on disk, and the
  // case that fails is the one that leaves it readable.
  beforeEach(() => rmSync(AUDIT_PATH, { force: true }));
  afterEach(() => rmSync(AUDIT_PATH, { force: true }));

  test("creates the log 0600, not the umask default 0644", async () => {
    expect(await writeTwoAuditLines()).toBe(0);
    expect(statSync(AUDIT_PATH).mode & 0o777).toBe(0o600);
    // A first run has no file to inspect, and reading that as "not private" would redact
    // every record on every fresh install while still producing a 0600 log.
    expect(readFileSync(AUDIT_PATH, "utf8")).toContain("hunter2");
  });

  test("tightens a log an older build left world-readable", async () => {
    writeFileSync(AUDIT_PATH, "");
    chmodSync(AUDIT_PATH, 0o644); // writeFileSync's mode is subject to umask; this is not

    expect(await writeTwoAuditLines()).toBe(0);
    expect(statSync(AUDIT_PATH).mode & 0o777).toBe(0o600);
    // The payload only counts as safe once the file it lands in is.
    expect(readFileSync(AUDIT_PATH, "utf8")).toContain("hunter2");
  });

  // The attack a chmod cannot stop: a local user leaves a symlink at the log path pointing
  // at a file they own. `chmod` follows it and reports success, having tightened THEIR
  // file, which they can loosen again whenever they like, and the append follows it too —
  // so every message typed into Telegram lands where they can read it. Refusing to open a
  // symlink is what stops it; nothing is written, here or anywhere.
  test("writes nothing at all through a symlink left at the log path", async () => {
    const target = `${AUDIT_PATH}.target`;
    rmSync(target, { force: true });
    writeFileSync(target, "");
    symlinkSync(target, AUDIT_PATH);
    try {
      // Exit 0 with an empty target, not a crash: the bot must keep serving. Paired with
      // the two cases above, which write "hunter2" through this same helper, an empty
      // file means declined rather than never attempted.
      expect(await writeTwoAuditLines()).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("");
      // And declined rather than worked around: replacing the link with a fresh log would
      // leave the target empty too, and would be a different bug wearing this test's pass.
      expect(lstatSync(AUDIT_PATH).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(AUDIT_PATH, { force: true });
      rmSync(target, { force: true });
    }
  });

  // A FIFO is the one path that is openable for writing and still not somewhere a record
  // may go — a regular file that fails the check has to belong to another user, which no
  // test here can arrange. This one keeps a reader open, so the write end opens at once
  // and the refusal has to come from the check rather than from the open.
  test("writes nothing into a FIFO left at the log path", async () => {
    rmSync(AUDIT_PATH, { force: true });
    expect(Bun.spawnSync(["mkfifo", AUDIT_PATH]).exitCode).toBe(0);
    const reader = openSync(AUDIT_PATH, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      expect(await writeTwoAuditLines()).toBe(0);
      // EAGAIN is the empty pipe. Anything else means a record went down it.
      const buf = Buffer.alloc(4096);
      let read = 0;
      try {
        read = readSync(reader, buf, 0, buf.length, null);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("EAGAIN");
      }
      expect(buf.subarray(0, read).toString()).toBe("");
    } finally {
      closeSync(reader);
      rmSync(AUDIT_PATH, { force: true });
    }
  });

  // The attack the chmod repair cannot undo. A local user hard-links the 0644 log, opens
  // their name for reading while it is still readable, and waits: `fchmod` changes the
  // inode's mode but not their descriptor, so every record appended afterwards is theirs.
  // The second link is the trace, and refusing the inode is what stops the write.
  test("writes nothing into a log that has a second name", async () => {
    const other = `${AUDIT_PATH}.link`;
    rmSync(other, { force: true });
    writeFileSync(AUDIT_PATH, "");
    chmodSync(AUDIT_PATH, 0o644);
    linkSync(AUDIT_PATH, other);
    const eavesdropper = openSync(other, constants.O_RDONLY);
    try {
      expect(await writeTwoAuditLines()).toBe(0);
      expect(readFileSync(AUDIT_PATH, "utf8")).toBe("");
    } finally {
      closeSync(eavesdropper);
      rmSync(other, { force: true });
    }
  });

  // Ownership cannot be tested with a file belonging to somebody else, but it can be tested
  // with a process that reports somebody else's uid. Same comparison, other side.
  test.each([
    ["the log belongs to another user", "process.getuid = () => 999999;"],
    ["there is no getuid to ask", "process.getuid = undefined;"],
  ])("writes nothing when %s", async (_name, prelude) => {
    writeFileSync(AUDIT_PATH, "");
    chmodSync(AUDIT_PATH, 0o600);
    expect(await writeTwoAuditLines(prelude)).toBe(0);
    expect(readFileSync(AUDIT_PATH, "utf8")).toBe("");
  });

  // The whole point of holding a descriptor rather than re-opening the path: the record
  // must land in the inode that was checked. `JSON.stringify` runs after the check and
  // before the write, so hooking it swaps the path underneath at exactly the wrong moment.
  test("writes into the inode it checked, not whatever the path points at by then", async () => {
    const decoy = `${AUDIT_PATH}.decoy`;
    rmSync(decoy, { force: true });
    const prelude = `const { renameSync, writeFileSync } = await import("node:fs");
       const real = JSON.stringify;
       JSON.stringify = (...a) => {
         JSON.stringify = real;
         renameSync("${AUDIT_PATH}", "${decoy}");
         writeFileSync("${AUDIT_PATH}", "", { mode: 0o600 });
         return real(...a);
       };`;
    try {
      expect(await writeTwoAuditLines(prelude, { AUDIT_LOG_JSON: "true" })).toBe(0);
      // The first record follows the descriptor to the renamed inode; the second opens the
      // replacement fresh. A path-based write would put both in the replacement.
      expect(readFileSync(decoy, "utf8")).toContain("hunter2");
    } finally {
      rmSync(decoy, { force: true });
    }
  });

  // Without O_NONBLOCK this open waits for a reader that never arrives, and the bot stops
  // on its first audit write. The deadline is what makes that a failure rather than a
  // suite that never finishes, and the test's own timeout has to outlast it.
  test("does not block on a FIFO nobody is reading", async () => {
    rmSync(AUDIT_PATH, { force: true });
    expect(Bun.spawnSync(["mkfifo", AUDIT_PATH]).exitCode).toBe(0);
    const proc = Bun.spawn(
      ["bun", "-e", `const { auditLog } = await import("${import.meta.dir}/utils.ts");
       await auditLog(1, "tester", "TEXT", "hunter2", "ok");`],
      { env: { ...process.env, AUDIT_LOG_PATH: AUDIT_PATH }, stdout: "ignore", stderr: "ignore" }
    );
    try {
      const outcome = await Promise.race([
        proc.exited,
        Bun.sleep(5000).then(() => "still running"),
      ]);
      expect(outcome).toBe(0);
    } finally {
      proc.kill();
      rmSync(AUDIT_PATH, { force: true });
    }
  }, 20000);
});

describe("reapTempDir", () => {
  const dir = `/tmp/reaper-test-${process.pid}`;
  const fresh = () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  };

  test("removes entries past the retention window, keeps newer ones", async () => {
    fresh();
    writeFileSync(`${dir}/old.mp4`, "x");
    writeFileSync(`${dir}/new.mp4`, "x");
    age(`${dir}/old.mp4`, 30);
    age(`${dir}/new.mp4`, 1);

    expect(await reapTempDir(dir, 24 * HOUR)).toBe(1);
    expect(existsSync(`${dir}/old.mp4`)).toBe(false);
    expect(existsSync(`${dir}/new.mp4`)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("removes stale directories, not just files (pdf_/archive_ render dirs)", async () => {
    fresh();
    mkdirSync(`${dir}/pdf_123`);
    writeFileSync(`${dir}/pdf_123/page-1.png`, "x");
    age(`${dir}/pdf_123`, 30);

    expect(await reapTempDir(dir, 24 * HOUR)).toBe(1);
    expect(existsSync(`${dir}/pdf_123`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("never removes .keep, which is what makes TEMP_DIR exist", async () => {
    fresh();
    writeFileSync(`${dir}/.keep`, "");
    age(`${dir}/.keep`, 500);

    expect(await reapTempDir(dir, 24 * HOUR)).toBe(0);
    expect(existsSync(`${dir}/.keep`)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // lstat, not stat: a stale LINK pointing at a fresh file must still go, and removing
  // it must unlink the link only. Note `lutimesSync`/`lstatSync` throughout — the
  // follow-the-link variants would age and inspect the target instead.
  test("ages a stale symlink by the link itself and leaves its target intact", async () => {
    fresh();
    const target = `${dir}/target.txt`;
    writeFileSync(target, "x"); // fresh
    symlinkSync(target, `${dir}/link`);
    lutimesSync(`${dir}/link`, (Date.now() - 30 * HOUR) / 1000, (Date.now() - 30 * HOUR) / 1000);

    expect(await reapTempDir(dir, 24 * HOUR)).toBe(1);
    expect(() => lstatSync(`${dir}/link`)).toThrow(); // link gone
    expect(existsSync(target)).toBe(true); // target untouched
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing directory is survivable, not a throw", async () => {
    expect(await reapTempDir(`/tmp/does-not-exist-${process.pid}`, HOUR)).toBe(0);
  });

  // `now - mtime < NaN` is false for every entry, so the skip-if-young branch was never
  // taken and the sweep deleted everything.
  test("refuses to sweep on a non-positive or NaN age instead of deleting everything", async () => {
    for (const bad of [NaN, 0, -1, Infinity]) {
      fresh();
      writeFileSync(`${dir}/fresh.mp4`, "x");
      writeFileSync(`${dir}/old.mp4`, "x");
      age(`${dir}/old.mp4`, 500);

      expect(await reapTempDir(dir, bad)).toBe(0);
      expect(existsSync(`${dir}/fresh.mp4`)).toBe(true);
      expect(existsSync(`${dir}/old.mp4`)).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
