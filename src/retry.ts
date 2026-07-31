/**
 * Bounded retry for the error class `autoRetry` cannot bound.
 */

import { HttpError, type Api, type Transformer } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";

/**
 * Retries an `HttpError` a fixed number of times, then rethrows.
 *
 * `autoRetry` retries that class forever. Its `call()` loops `while (res === undefined)`
 * and the `maxRetryAttempts` counter guards only the outer loop over unsuccessful
 * *results*, so nothing counts these (`@grammyjs/auto-retry/out/mod.js:49-68`, pinned by a
 * test). Everything that goes wrong from the fetch onwards arrives as one `HttpError`
 * (`grammy/out/core/client.js:58` wraps the race at `:55`) — a dropped connection, the
 * request timeout, or a filesystem error while streaming an upload — so an unreadable file
 * retried forever and its failure reached nobody. It also swallowed the runner's own
 * `getUpdates` retry, which logs each failure and gives up after 15 h: with `autoRetry`
 * never returning, neither ran.
 *
 * `autoRetry` is therefore configured with `rethrowHttpErrors: true` and the retry happens
 * here, where it stops. A transient failure still recovers; a permanent one surfaces.
 */
export function retryHttpErrors(
  attempts = 3,
  baseDelayMs = 1000
): Transformer {
  return async (prev, method, payload, signal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prev(method, payload, signal);
      } catch (error) {
        // Aborts are `wait`'s, not this condition's: reaching here means an attempt has
        // already been made, so the only abort left to notice is one that lands before the
        // next — whether that is before the wait or during it.
        if (attempt >= attempts || !(error instanceof HttpError)) {
          throw error;
        }
        await wait(baseDelayMs * 2 ** attempt, signal, error);
      }
    }
  };
}

/**
 * Resolves after `ms`, or rejects with `reason` the moment `signal` aborts.
 *
 * Sleeping through an abort would spend another attempt on a request whose caller has
 * already stopped listening, and the delay doubles each time, so the wait is where an
 * abort has the longest to arrive. `autoRetry`'s own `pause` is abort-aware for the same
 * reason.
 *
 * A signal already aborted on entry takes the first line and never starts a timer — an
 * `addEventListener` would not fire for an abort that has happened, leaving the caller to
 * sit out a delay it has no use for.
 */
function wait(
  ms: number,
  signal: Parameters<Transformer>[3],
  reason: unknown
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(reason);
    const handle = setTimeout(finish, ms);
    function finish() {
      // Releases the timer when the abort path gets here first; a no-op on the other.
      clearTimeout(handle);
      signal?.removeEventListener("abort", finish);
      if (signal?.aborted) reject(reason);
      else resolve();
    }
    signal?.addEventListener("abort", finish);
  });
}

/**
 * Installs the pair, which only works as a pair: `retryHttpErrors` alone still has
 * `autoRetry` looping forever around whatever it gives up on, and `rethrowHttpErrors`
 * alone leaves no retry at all. Kept together here rather than at the call site so neither
 * can be dropped on its own.
 *
 * What is left to `autoRetry` is the part it does bound: unsuccessful *results*, meaning
 * `retry_after` and 5xx.
 *
 * Order is load-bearing, and grammY makes the later `use` the outer one. `retryHttpErrors`
 * goes first, so a transport retry happens inside one `autoRetry` attempt and does not
 * refresh its budget. Reversed, every transport retry re-enters `autoRetry` with
 * `remainingAttempts` back at its initial value — that counter is per invocation
 * (`mod.js:42`) — and a connection that keeps flapping would extend the 5xx retries with
 * it. A test drives a mixed sequence that the two orders answer differently.
 *
 * The two counts are unset rather than repeated so `retryHttpErrors` above stays the only
 * place production's numbers are written, and a test of its defaults is a test of these.
 */
export function installRetry(
  api: Pick<Api, "config">,
  attempts?: number,
  baseDelayMs?: number
): void {
  api.config.use(retryHttpErrors(attempts, baseDelayMs));
  api.config.use(
    autoRetry({
      maxRetryAttempts: 3,
      maxDelaySeconds: 30,
      rethrowHttpErrors: true,
    })
  );
}
