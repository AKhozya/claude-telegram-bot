import { describe, test, expect } from "bun:test";
import { convertMarkdownToHtml, describeError, formatToolStatus } from "./formatting";

// #5 audit: code was restored via `text.replace(placeholder, "<pre>"+code+"</pre>")`.
// A STRING replacement interprets `$$`/`$&`/`` $` ``/`$'` in the code as special
// patterns — `$&` would re-inject the placeholder match — corrupting the output.
// The fix passes a replacement FUNCTION, which is not subject to `$` interpretation.

// The `**` pass must run before the single-`*` pass: the single-`*` regex uses `(.+?)`,
// which spans the inner delimiters, so on its own it turns `**x**` into <b>*x*</b>. The
// `_` pair does not have this coupling — `[^_]+` cannot span them. Nothing else covers
// the ordering, and a reorder is silent: the output stays well-formed HTML.
test("** stays bold and does not leak literal asterisks (pass ordering)", () => {
  expect(convertMarkdownToHtml("**x**")).toContain("<b>x</b>");
  expect(convertMarkdownToHtml("**x**")).not.toContain("<b>*x*</b>");
  expect(convertMarkdownToHtml("*y*")).toContain("<b>y</b>");
  // The underscore pair, for contrast: order-independent by construction.
  expect(convertMarkdownToHtml("__z__")).toContain("<b>z</b>");
  expect(convertMarkdownToHtml("_w_")).toContain("<i>w</i>");
});

test("inline code containing $& survives verbatim (no pattern corruption)", () => {
  const out = convertMarkdownToHtml("run `echo $&` now");
  expect(out).toContain("<code>echo $&amp;</code>");
  expect(out).not.toContain("INLINECODE");
});

test("code block containing $$ and $` survives verbatim", () => {
  const out = convertMarkdownToHtml("```\ncost=$$ end=$`\n```");
  // A string replacement would turn $$ into $ and $` into the pre-match text.
  expect(out).toContain("cost=$$");
  expect(out).toContain("end=$`");
  expect(out).not.toContain("CODEBLOCK");
});

// A usage-limit sentence arrives wrapped in an API error envelope. Truncating from the
// left showed only the envelope, so /status and the phone reply were both unreadable.

test("a usage-limit error surfaces the sentence, not the API envelope", () => {
  const wrapped =
    'Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error",' +
    '"message":"You\'ve hit your monthly spend limit. Run /usage-credits to manage it."}}';
  const out = describeError(wrapped);
  expect(out).toBe(
    "You've hit your monthly spend limit. Run /usage-credits to manage it."
  );
});

test("an org-policy limit is matched too — both tables can reach a catch", () => {
  const wrapped = 'Error: 403 {"message":"This service is disabled for your org"}';
  expect(describeError(wrapped)).toBe("This service is disabled for your org");
});

test("an ordinary error is left alone, truncated from the left as before", () => {
  const out = describeError(new Error("spawn claude ENOENT"), 12);
  expect(out).toBe("Error: spawn");
});

test("the max applies to the extracted sentence, not the whole envelope", () => {
  const wrapped = 'Error: API Error: 429 {"message":"You\'ve hit your monthly spend limit."}';
  expect(describeError(wrapped, 20)).toBe("You've hit your mont");
});

test("a quoted phrase inside the limit sentence does not cut it short", () => {
  const wrapped =
    'Error: 429 {"message":"You\'ve hit your monthly spend limit. Run \\"/usage-credits\\" to raise it."}';
  expect(describeError(wrapped)).toBe(
    'You\'ve hit your monthly spend limit. Run \\"/usage-credits\\" to raise it.'
  );
});

// A sentence ending in a LITERAL backslash reaches us as `\\` immediately before the
// real closing quote. Checking only the single preceding character reads that as an
// escaped quote, finds no terminator, and leaks the JSON envelope (`...C:\\"}}`).
test("a literal backslash before the closing quote does not swallow the envelope", () => {
  const wrapped =
    'Error: 429 {"message":"You\'ve hit your monthly spend limit. Check C:\\\\"}}';
  expect(describeError(wrapped)).toBe(
    "You've hit your monthly spend limit. Check C:\\\\"
  );
});

// Reading an image is reported as "👀 Viewing" with no path, because the image itself is
// about to be sent. Every other Read reports the path. Pins the extension set so the
// list-vs-regex spelling cannot quietly change which files count as images.
describe("formatToolStatus image detection", () => {
  const viewing = (p: string) => formatToolStatus("Read", { file_path: p });

  test.each([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico",
  ])("%s is an image", (ext) => {
    expect(viewing(`/tmp/shot${ext}`)).toBe("👀 Viewing");
  });

  test("the match is case-insensitive", () => {
    expect(viewing("/tmp/SHOT.PNG")).toBe("👀 Viewing");
    expect(viewing("/tmp/shot.JpEg")).toBe("👀 Viewing");
  });

  test.each([
    ["/tmp/notes.md", "a non-image extension"],
    ["/tmp/shot.jpgx", "an extension that only starts the same way"],
    ["/tmp/jpg", "a bare name matching an extension without its dot"],
    ["/tmp/shot.png.txt", "an image extension that is not last"],
  ])("%s is not an image (%s)", (path) => {
    expect(viewing(path)).not.toBe("👀 Viewing");
    expect(viewing(path)).toContain("Reading");
  });

  // `$` in a JS regex does not match before a trailing newline the way it does in Python,
  // so a regex spelling stays equivalent to endsWith here. Pinned because a stray `m`
  // flag would break it silently.
  test("a trailing newline is not stripped before matching", () => {
    expect(viewing("/tmp/shot.png\n")).not.toBe("👀 Viewing");
  });
});
