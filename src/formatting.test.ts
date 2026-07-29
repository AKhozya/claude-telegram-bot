import { test, expect } from "bun:test";
import { convertMarkdownToHtml, describeError } from "./formatting";

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
