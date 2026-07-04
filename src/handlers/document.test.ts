import { test, expect } from "bun:test";

// config.ts (pulled in transitively via document.ts) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { pdfHasUsableText, sortPdfPagePaths } = await import("./document");

test("image/scanned PDF (form-feeds + whitespace only) has no usable text", () => {
  // pdftotext on an image PDF emits page-break \f and nothing else.
  expect(pdfHasUsableText("\f   \n  \f  \n\t")).toBe(false);
});

test("empty extraction has no usable text", () => {
  expect(pdfHasUsableText("")).toBe(false);
});

test("a real text layer counts as usable", () => {
  expect(pdfHasUsableText("This is a real document with actual text.\f")).toBe(true);
});

test("near-empty text (stray watermark char) falls back to vision", () => {
  expect(pdfHasUsableText("\f A \f")).toBe(false);
});

test("sortPdfPagePaths orders by page number, not lexicographically", () => {
  // pdftocairo can emit unpadded names; lexicographic would put page-10 before page-2.
  const shuffled = ["page-10.png", "page-2.png", "page-1.png", "page-11.png"];
  expect(sortPdfPagePaths(shuffled)).toEqual([
    "page-1.png",
    "page-2.png",
    "page-10.png",
    "page-11.png",
  ]);
});

test("sortPdfPagePaths does not mutate its input", () => {
  const input = ["page-2.png", "page-1.png"];
  sortPdfPagePaths(input);
  expect(input).toEqual(["page-2.png", "page-1.png"]);
});
