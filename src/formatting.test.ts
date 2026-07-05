import { test, expect } from "bun:test";
import { convertMarkdownToHtml } from "./formatting";

// #5 audit: code was restored via `text.replace(placeholder, "<pre>"+code+"</pre>")`.
// A STRING replacement interprets `$$`/`$&`/`` $` ``/`$'` in the code as special
// patterns — `$&` would re-inject the placeholder match — corrupting the output.
// The fix passes a replacement FUNCTION, which is not subject to `$` interpretation.

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
