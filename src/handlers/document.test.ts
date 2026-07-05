import { test, expect } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  lstatSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// config.ts (pulled in transitively via document.ts) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const {
  pdfHasUsableText,
  sortPdfPagePaths,
  isUnsafeMemberName,
  stripLinks,
  listArchiveMembers,
} = await import("./document");

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

test("stripLinks removes symlinks (incl. nested) but keeps real files/dirs", () => {
  const base = join(tmpdir(), `ctb-strip-${Date.now()}-${process.pid}`);
  mkdirSync(join(base, "sub"), { recursive: true });
  writeFileSync(join(base, "real.txt"), "keep");
  writeFileSync(join(base, "sub", "nested.txt"), "keep");
  symlinkSync("/etc/hostname", join(base, "link.txt")); // exfil vector at top level
  symlinkSync("/etc", join(base, "sub", "evil")); // nested symlink-to-dir
  try {
    stripLinks(base);
    expect(lexists(join(base, "link.txt"))).toBe(false);
    expect(lexists(join(base, "sub", "evil"))).toBe(false);
    expect(lexists(join(base, "real.txt"))).toBe(true);
    expect(lexists(join(base, "sub", "nested.txt"))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("stripLinks removes hard-link exfil members but leaves the target file intact", () => {
  // Models a tar hard-link member: a file inside extractDir sharing the inode of a
  // secret OUTSIDE it. lstat reports it as a regular file (nlink>1), so the plain
  // isFile() guard misses it — stripLinks must delete it before content is read.
  const root = join(tmpdir(), `ctb-hl-${Date.now()}-${process.pid}`);
  const outside = join(tmpdir(), `ctb-secret-${Date.now()}-${process.pid}.env`);
  mkdirSync(join(root, "extract"), { recursive: true });
  writeFileSync(outside, "SECRET=abc123");
  linkSync(outside, join(root, "extract", "config.env")); // hard link → the secret
  writeFileSync(join(root, "extract", "normal.txt"), "ok"); // nlink 1, kept
  try {
    stripLinks(join(root, "extract"));
    expect(lexists(join(root, "extract", "config.env"))).toBe(false);
    expect(lexists(join(root, "extract", "normal.txt"))).toBe(true);
    // Unlinking the archive entry must not touch the target's data.
    expect(readFileSync(outside, "utf8")).toBe("SECRET=abc123");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

// Integration: exercise listArchiveMembers against the real `tar` binary (the
// path that runs in the container) so the security gate is tested end-to-end,
// not just the isUnsafeMemberName predicate in isolation. Portable member naming
// (no GNU-only --transform): `-C sub ../target` records a real `..` member name.
test("listArchiveMembers surfaces members (incl. a .. traversal) from a real tar", async () => {
  const dir = join(tmpdir(), `ctb-tar-${Date.now()}-${process.pid}`);
  mkdirSync(join(dir, "sub", "pkg"), { recursive: true });
  writeFileSync(join(dir, "sub", "a.txt"), "1");
  writeFileSync(join(dir, "sub", "pkg", "b.txt"), "2");
  writeFileSync(join(dir, "target.txt"), "x"); // sits above sub/
  const tarPath = join(dir, "test.tar");
  try {
    // Normal members from within sub/, plus one member named `../target.txt`.
    await Bun.$`tar -cf ${tarPath} -C ${join(dir, "sub")} a.txt pkg/b.txt ../target.txt`.quiet();
    const members = await listArchiveMembers(tarPath, ".tar");
    expect(members).toContain("a.txt");
    expect(members).toContain("pkg/b.txt");
    // The gate: a real archive's `..` member reaches isUnsafeMemberName and is flagged.
    expect(members.some(isUnsafeMemberName)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
