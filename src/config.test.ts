import { afterEach, describe, expect, test } from "bun:test";

const { positiveNumberEnv } = await import("./config");

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
