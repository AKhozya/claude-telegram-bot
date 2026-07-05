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

// Does this host have a real `zip` + Info-ZIP `unzip` (the `-Z1` lister the code
// needs)? BusyBox-only boxes lack `-Z`; the zip integration test skips there rather
// than failing, but runs on macOS dev, GitHub ubuntu runners, and the built image.
const hasInfoZip: boolean = await (async () => {
  if (!Bun.which("zip") || !Bun.which("unzip")) return false;
  const d = join(tmpdir(), `ctb-zipprobe-${Date.now()}-${process.pid}`);
  try {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "x.txt"), "1");
    await Bun.$`sh -c ${`cd ${d} && zip -q probe.zip x.txt`}`.quiet();
    await Bun.$`unzip -Z1 ${join(d, "probe.zip")}`.quiet();
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

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
// path that runs in the container) so the parse — `tar -tf` → split → filter — is
// covered end-to-end, not mocked. Member names are asserted verbatim, incl. a
// nested path. (`..`/absolute rejection is covered by isUnsafeMemberName above;
// crafting a raw `..` member is not portable — GNU tar strips it on create, bsdtar
// keeps it, BusyBox normalises it on list — so the predicate is unit-tested instead.)
test("listArchiveMembers lists members from a real tar (tar -tf parse)", async () => {
  const dir = join(tmpdir(), `ctb-tar-${Date.now()}-${process.pid}`);
  mkdirSync(join(dir, "sub", "pkg"), { recursive: true });
  writeFileSync(join(dir, "sub", "a.txt"), "1");
  writeFileSync(join(dir, "sub", "pkg", "b.txt"), "2");
  const tarPath = join(dir, "test.tar");
  try {
    await Bun.$`tar -cf ${tarPath} -C ${join(dir, "sub")} a.txt pkg/b.txt`.quiet();
    const members = await listArchiveMembers(tarPath, ".tar");
    expect(members).toContain("a.txt");
    expect(members).toContain("pkg/b.txt");
    expect(members.every((m) => !isUnsafeMemberName(m))).toBe(true); // all in-tree
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Symmetric real-binary test for the zip path (`unzip -Z1`). Guards against a base
// image that re-shadows unzip with BusyBox — the exact divergence that broke zip in
// prod once. Skipped where Info-ZIP isn't present rather than failing.
test.skipIf(!hasInfoZip)(
  "listArchiveMembers lists members from a real zip (unzip -Z1 parse)",
  async () => {
    const dir = join(tmpdir(), `ctb-zip-${Date.now()}-${process.pid}`);
    mkdirSync(join(dir, "src", "pkg"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), "1");
    writeFileSync(join(dir, "src", "pkg", "b.txt"), "2");
    const zipPath = join(dir, "test.zip");
    try {
      await Bun.$`sh -c ${`cd ${join(dir, "src")} && zip -q -r ${zipPath} a.txt pkg`}`.quiet();
      const members = await listArchiveMembers(zipPath, ".zip");
      expect(members).toContain("a.txt");
      expect(members).toContain("pkg/b.txt");
      expect(members.every((m) => !isUnsafeMemberName(m))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
