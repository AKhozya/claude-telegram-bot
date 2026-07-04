import { describe, expect, test } from "bun:test";

// config.ts (pulled in transitively via ./session) reads these at module-eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { writeJsonAtomic } = await import("./session");

describe("writeJsonAtomic", () => {
  test("writes parseable JSON and leaves no tmp residue", async () => {
    const target = `${process.env.TMPDIR || "/tmp"}/atomic-test-${process.pid}.json`;
    await writeJsonAtomic(target, { sessions: [{ id: 1 }] });
    const parsed = JSON.parse(await Bun.file(target).text());
    expect(parsed.sessions[0].id).toBe(1);

    const residue = await Array.fromAsync(
      new Bun.Glob(`atomic-test-${process.pid}.json.*.tmp`).scan({
        cwd: process.env.TMPDIR || "/tmp",
      })
    );
    expect(residue.length).toBe(0);
  });

  test("concurrent writes to the same path don't clobber each other's tmp file", async () => {
    const target = `${process.env.TMPDIR || "/tmp"}/atomic-test-concurrent-${process.pid}.json`;
    await Promise.all([
      writeJsonAtomic(target, { sessions: [{ id: "a" }] }),
      writeJsonAtomic(target, { sessions: [{ id: "b" }] }),
    ]);
    // Whichever write won the rename race, the file must be intact valid JSON.
    const parsed = JSON.parse(await Bun.file(target).text());
    expect(["a", "b"]).toContain(parsed.sessions[0].id);
  });
});
