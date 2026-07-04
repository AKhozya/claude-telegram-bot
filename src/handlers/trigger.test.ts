import { describe, expect, test } from "bun:test";

// config.ts (pulled in transitively) reads these at module-eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { secretMatches } = await import("./trigger");

describe("secretMatches", () => {
  test("rejects wrong secret", () => {
    expect(secretMatches("wrong", "right-secret")).toBe(false);
  });
  test("rejects different-length secret without throwing", () => {
    expect(secretMatches("x", "right-secret")).toBe(false);
    expect(secretMatches("", "right-secret")).toBe(false);
  });
  test("accepts exact match", () => {
    expect(secretMatches("right-secret", "right-secret")).toBe(true);
  });
  test("rejects same-length wrong secret", () => {
    expect(secretMatches("wrong-secret", "right-secret")).toBe(false);
  });
});
