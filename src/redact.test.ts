import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { inspect } from "node:util";
import { installConsoleRedaction } from "./redact";

const TOKEN = "8430599999:AAtestTOKENtestTOKENtestTOKEN";

// installConsoleRedaction binds whatever console method is current, so a spy
// installed BEFORE it captures what would have reached the terminal. Every
// method is restored afterwards — a leaked patch would garble later tests.
const METHODS = ["log", "error", "warn", "info", "debug"] as const;
let saved: Partial<Record<(typeof METHODS)[number], any>>;
let printed: unknown[][];

beforeEach(() => {
  saved = {};
  printed = [];
  for (const m of METHODS) {
    saved[m] = console[m];
    console[m] = (...args: unknown[]) => {
      printed.push(args);
    };
  }
});

afterEach(() => {
  for (const m of METHODS) {
    console[m] = saved[m];
  }
});

describe("installConsoleRedaction", () => {
  test("a plain string containing the secret is redacted", () => {
    installConsoleRedaction([TOKEN]);
    console.error(`https://api.telegram.org/bot${TOKEN}/getUpdates failed`);
    const out = printed[0]![0] as string;
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("<redacted>");
  });

  test("a secret buried deep in an error chain is redacted (the Bun fetch `path` leak)", () => {
    installConsoleRedaction([TOKEN]);
    // Mirrors the observed shape (HttpError -> inner fetch error -> path) plus
    // a cause link. Bun renders error chains at any depth, so this pins the
    // error-shaped leak; the plain-object test below pins the depth option.
    const inner = new Error("Was there a typo in the url or port?");
    (inner as any).path = `https://api.telegram.org/bot${TOKEN}/getUpdates`;
    (inner as any).code = "FailedToOpenSocket";
    const mid = new Error("fetch failed");
    (mid as any).cause = inner;
    const outer = new Error("Network request for 'getUpdates' failed!");
    (outer as any).error = mid;
    console.error("[grammY runner] Error while fetching updates:", outer);
    const flat = printed[0]!.map(String).join(" ");
    expect(flat).not.toContain(TOKEN);
    expect(flat).toContain("<redacted>");
    expect(flat).toContain("FailedToOpenSocket");
  });

  test("a secret nested in a plain object past inspect's default depth is redacted", () => {
    installConsoleRedaction([TOKEN]);
    // Depth 4: default-depth inspect collapses this to [Object] before the
    // secret is reachable, so only the depth-unlimited scan sees it.
    console.error({ a: { b: { c: { d: `url with ${TOKEN}` } } } });
    const out = printed[0]![0] as string;
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("<redacted>");
  });

  test("clean arguments pass through untouched, preserving identity", () => {
    installConsoleRedaction([TOKEN]);
    const obj = { nested: { fine: "no secrets here" } };
    console.log("hello", obj);
    expect(printed[0]![0]).toBe("hello");
    expect(printed[0]![1]).toBe(obj);
  });

  test("all secrets in the list are redacted, empty entries ignored", () => {
    installConsoleRedaction([TOKEN, "", "trigger-secret-value"]);
    console.warn(`${TOKEN} and trigger-secret-value`);
    const out = printed[0]![0] as string;
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("trigger-secret-value");
  });

  test("an argument whose custom inspect hook throws is replaced, never thrown", () => {
    installConsoleRedaction([TOKEN]);
    const evil = {
      [inspect.custom]() {
        throw new Error("hook-boom");
      },
    };
    expect(() => console.error("context:", evil)).not.toThrow();
    expect(String(printed[0]![1])).toContain("unprintable");
  });

  test("an all-empty secret list leaves console methods unpatched", () => {
    const before = console.error;
    installConsoleRedaction(["", ""]);
    expect(console.error).toBe(before);
  });

  test("every console method is covered", () => {
    installConsoleRedaction([TOKEN]);
    for (const m of METHODS) {
      console[m](`leak ${TOKEN}`);
    }
    expect(printed).toHaveLength(METHODS.length);
    for (const args of printed) {
      expect(args[0] as string).not.toContain(TOKEN);
    }
  });
});
