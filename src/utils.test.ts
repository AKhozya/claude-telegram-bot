import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
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
// write to the real /tmp/claude-telegram-audit.log. A fresh process also resets the
// once-per-process chmod flag, which is the only way to exercise both cases.
const writeTwoAuditLines = async (): Promise<number> => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `const { auditLog } = await import("${import.meta.dir}/utils.ts");
       await auditLog(1, "tester", "TEXT", "hunter2", "ok");
       await auditLog(1, "tester", "TEXT", "again");`,
    ],
    {
      env: { ...process.env, AUDIT_LOG_PATH: AUDIT_PATH },
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
  });

  test("tightens a log an older build left world-readable", async () => {
    writeFileSync(AUDIT_PATH, "");
    chmodSync(AUDIT_PATH, 0o644); // writeFileSync's mode is subject to umask; this is not

    expect(await writeTwoAuditLines()).toBe(0);
    expect(statSync(AUDIT_PATH).mode & 0o777).toBe(0o600);
  });
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
