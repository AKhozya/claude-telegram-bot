import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// config.ts (pulled in transitively via document.ts) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { pdfHasUsableText, sortPdfPagePaths, isUnsafeMemberName, stripSymlinks } =
  await import("./document");

const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

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

// ── #4 archive hardening: zip-slip / tar traversal + symlink-follow exfil ──
test("isUnsafeMemberName flags absolute, ~ and .. traversal members", () => {
  expect(isUnsafeMemberName("/etc/passwd")).toBe(true);
  expect(isUnsafeMemberName("~/.ssh/authorized_keys")).toBe(true);
  expect(isUnsafeMemberName("../../etc/passwd")).toBe(true);
  expect(isUnsafeMemberName("a/b/../../../c")).toBe(true);
  expect(isUnsafeMemberName("a\\..\\..\\b")).toBe(true); // backslash separators
});

test("isUnsafeMemberName allows normal in-tree members", () => {
  expect(isUnsafeMemberName("readme.txt")).toBe(false);
  expect(isUnsafeMemberName("src/handlers/document.ts")).toBe(false);
  expect(isUnsafeMemberName("dir/..name/file")).toBe(false); // .. inside a segment, not a segment
  expect(isUnsafeMemberName("./config.json")).toBe(false);
});

test("stripSymlinks removes symlinks (incl. nested) but keeps real files/dirs", () => {
  const base = join(tmpdir(), `ctb-strip-${Date.now()}-${process.pid}`);
  mkdirSync(join(base, "sub"), { recursive: true });
  writeFileSync(join(base, "real.txt"), "keep");
  writeFileSync(join(base, "sub", "nested.txt"), "keep");
  symlinkSync("/etc/hostname", join(base, "link.txt")); // exfil vector at top level
  symlinkSync("/etc", join(base, "sub", "evil")); // nested symlink-to-dir
  try {
    stripSymlinks(base);
    expect(lexists(join(base, "link.txt"))).toBe(false);
    expect(lexists(join(base, "sub", "evil"))).toBe(false);
    expect(lexists(join(base, "real.txt"))).toBe(true);
    expect(lexists(join(base, "sub", "nested.txt"))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
