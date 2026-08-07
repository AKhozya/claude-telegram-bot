/**
 * Console redaction for secrets that third-party error formatting leaks.
 */

import { inspect } from "node:util";

/**
 * Rewrites the console methods so no argument reaches stdout/stderr with a
 * known secret in it.
 *
 * The leak this closes: Bun's fetch errors carry the request URL as an own
 * `path` property, and the Telegram Bot API puts the token IN the URL — so the
 * grammY runner logging a failed `getUpdates` printed the full token to pod
 * logs (seen 2026-08-07; Loki retains 720h). Bun's inspect renders error
 * chains at any depth, but cuts PLAIN objects at its default depth of 2 — the
 * depth-unlimited inspect is for a secret nested in a logged payload object,
 * which the default would replace with `[Object ...]` and pass through
 * unscanned.
 *
 * Args that inspect clean pass through untouched so ordinary logging keeps the
 * runtime's own formatting; only an offending arg is flattened to a redacted
 * string. Dumps that bypass console — Bun itself printing an uncaught
 * exception on the way down — are NOT covered: hooking process-level error
 * handling to plug that path risks changing crash semantics for a process that
 * is exiting anyway.
 */
export function installConsoleRedaction(secrets: readonly string[]): void {
  const live = secrets.filter((s) => s.length > 0);
  if (live.length === 0) return;
  for (const name of ["log", "error", "warn", "info", "debug"] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args.map((arg) => redactArg(arg, live)));
    };
  }
}

function redactArg(arg: unknown, secrets: readonly string[]): unknown {
  let text: string;
  if (typeof arg === "string") {
    text = arg;
  } else {
    try {
      text = inspect(arg, { depth: Infinity });
    } catch {
      // A custom [inspect.custom] hook that throws propagates out of inspect
      // (throwing getters do not — verified against Bun 1.3). Unscannable means
      // unprovable-clean: fail closed rather than let the original formatter
      // print what the scan never saw.
      return "[unprintable — redaction scan failed]";
    }
  }
  if (!secrets.some((s) => text.includes(s))) {
    return arg;
  }
  let out = text;
  for (const s of secrets) {
    out = out.replaceAll(s, "<redacted>");
  }
  return out;
}
