import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installPollHeartbeat, beat } from "./poll-heartbeat";
import type { Api } from "grammy";

// Captures the transformer exactly as grammY would receive it, so the tests
// drive the real signature rather than a re-implementation of it.
function capture() {
  let transformer: any;
  const api = {
    config: { use: (t: any) => (transformer = t) },
  } as unknown as Pick<Api, "config">;
  return {
    api,
    call: (method: string, prev: any) =>
      transformer(prev, method, {}, undefined),
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poll-heartbeat-"));
  file = join(dir, "heartbeat");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("installPollHeartbeat", () => {
  test("successful getUpdates writes the heartbeat and passes the result through", async () => {
    const { api, call } = capture();
    installPollHeartbeat(api, file);
    const res = { ok: true, result: [] };
    await expect(call("getUpdates", async () => res)).resolves.toBe(res);
    expect(existsSync(file)).toBe(true);
    expect(Number(readFileSync(file, "utf-8"))).toBeGreaterThan(0);
  });

  test("other methods never write, even when successful", async () => {
    const { api, call } = capture();
    installPollHeartbeat(api, file);
    await call("sendMessage", async () => ({ ok: true, result: {} }));
    expect(existsSync(file)).toBe(false);
  });

  test("an unsuccessful getUpdates result does not write", async () => {
    const { api, call } = capture();
    installPollHeartbeat(api, file);
    await call("getUpdates", async () => ({ ok: false, error_code: 502 }));
    expect(existsSync(file)).toBe(false);
  });

  test("a rejecting getUpdates does not write and the rejection propagates", async () => {
    const { api, call } = capture();
    installPollHeartbeat(api, file);
    const boom = new Error("socket");
    await expect(
      call("getUpdates", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(existsSync(file)).toBe(false);
  });
});

describe("beat", () => {
  test("writes a timestamp", () => {
    beat(file);
    expect(Number(readFileSync(file, "utf-8"))).toBeGreaterThan(0);
  });

  test("an unwritable path is swallowed, not thrown", () => {
    expect(() => beat(join(dir, "missing-dir", "heartbeat"))).not.toThrow();
  });
});
