import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { positiveNumberEnv, loadMcpServers } = await import("./config");

const KEY = "TEST_POSITIVE_NUMBER_ENV";

afterEach(() => {
  delete process.env[KEY];
});

describe("positiveNumberEnv", () => {
  test("unset or empty falls back", () => {
    expect(positiveNumberEnv(KEY, 42)).toBe(42);
    process.env[KEY] = "";
    expect(positiveNumberEnv(KEY, 42)).toBe(42);
  });

  test("accepts positive values, including fractional ones", () => {
    for (const [raw, want] of [
      ["1", 1],
      ["24", 24],
      ["3600000", 3600000],
      ["0.5", 0.5],
    ] as const) {
      process.env[KEY] = raw;
      expect(positiveNumberEnv(KEY, 42)).toBe(want);
    }
  });

  // Each reached TEMP_RETENTION_MS as NaN or <= 0, which the reaper read as delete-all.
  test("rejects values that would make the reaper delete everything", () => {
    for (const raw of ["bogus", "0", "-1", "-0.5", "NaN", "Infinity", " "]) {
      process.env[KEY] = raw;
      expect(positiveNumberEnv(KEY, 42)).toBe(42);
    }
  });

  // parseInt("12abc") is 12 and silently accepts a typo'd value; Number rejects it.
  test("rejects trailing garbage instead of truncating to a number", () => {
    process.env[KEY] = "12abc";
    expect(positiveNumberEnv(KEY, 42)).toBe(42);
  });
});

// A broken mcp-config.ts used to be indistinguishable from an absent one: the import was
// wrapped in `.catch(() => null)`, so a syntax error started the bot with no MCP servers
// and printed nothing. Each outcome now has to announce itself, so the log distinguishes
// them — hence the console capture rather than a bare return-value check.
describe("loadMcpServers", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctb-mcp-config-"));
  let n = 0;
  // A directory of its own per case, not just a distinct filename. Observed here: when
  // several modules are created inside one directory during a run and imported in turn,
  // only the first resolves — the rest fail with "Cannot find module" whatever they
  // contain. Sharing a directory made the unparseable case pass on that resolver failure
  // instead of the parse failure it claims to test, since both produce the same
  // "failed to load" line.
  const write = async (source: string) => {
    const path = `${dir}/case-${n++}/mcp-config.ts`;
    await Bun.write(path, source);
    return path;
  };

  const capture = async (path: string) => {
    const lines: string[] = [];
    const { log, error } = console;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      return { servers: await loadMcpServers(path), said: lines.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a valid config is loaded and counted", async () => {
    const path = await write(
      `export const MCP_SERVERS = { "ask-user": { command: "bun", args: ["x"] } };`
    );
    const { servers, said } = await capture(path);
    expect(Object.keys(servers)).toEqual(["ask-user"]);
    expect(said).toContain("Loaded 1 MCP servers");
  });

  test("an absent config says so and yields none", async () => {
    const { servers, said } = await capture(`${dir}/definitely-not-here.ts`);
    expect(servers).toEqual({});
    expect(said).toContain("No mcp-config.ts found");
  });

  // The case that was silent. It must not read as "no config file".
  test("an unparseable config is reported as a failure, not as absence", async () => {
    const path = await write(`export const MCP_SERVERS = { oops`);
    const { servers, said } = await capture(path);
    expect(servers).toEqual({});
    expect(said).toContain("failed to load");
    expect(said).not.toContain("No mcp-config.ts found");
    // Pins that the import got far enough to parse. A resolver failure reports the same
    // "failed to load" line, which is how this test passed while proving nothing.
    expect(said).toContain("BuildMessage");
  });

  // Likewise a config that parses but exports the wrong name.
  test("a config exporting no MCP_SERVERS is reported, not silently empty", async () => {
    const path = await write(`export const SERVERS = {};`);
    const { servers, said } = await capture(path);
    expect(servers).toEqual({});
    expect(said).toContain("exports no MCP_SERVERS");
  });
});
