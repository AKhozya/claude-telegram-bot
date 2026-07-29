import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  utimesSync,
  lutimesSync,
  lstatSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "fs";

// config.ts (pulled in transitively) reads these at module-eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { reapTempDir } = await import("./utils");

const HOUR = 60 * 60 * 1000;

// mtime is set explicitly rather than by sleeping — the reaper takes `now` for exactly this.
const age = (path: string, hoursAgo: number) => {
  const t = (Date.now() - hoursAgo * HOUR) / 1000;
  utimesSync(path, t, t);
};

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
});
