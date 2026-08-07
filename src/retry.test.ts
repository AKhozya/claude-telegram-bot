import { describe, expect, test } from "bun:test";
import { Api, GrammyError, HttpError } from "grammy";
import { installRetry, retryHttpErrors } from "./retry";

const OK = { ok: true as const, result: true };

const httpError = () =>
  new HttpError("Network request for 'sendDocument' failed!", new Error("EACCES"));

/**
 * A `prev` that yields the given outcomes in order and records what it was handed.
 * The last outcome repeats, so "always fails" is one argument.
 *
 * Throwing and returning are separate keys rather than inferred from the value: a
 * rejection that is not an `Error` is one of the cases under test, and a fake that decided
 * by `instanceof Error` silently turned it into a successful result.
 */
type Outcome = { throws: unknown } | { returns: unknown };

function fakePrev(...outcomes: Outcome[]) {
  const calls: Array<{ method: string; payload: unknown; signal: unknown }> = [];
  const prev = async (method: string, payload: unknown, signal: unknown) => {
    calls.push({ method, payload, signal });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
    if ("throws" in outcome) throw outcome.throws;
    return outcome.returns;
  };
  return { prev: prev as any, calls };
}

// Untyped only because `Transformer` declares this parameter as the `abort-controller`
// shim's `AbortSignal`, which the global one is not assignable to. The value handed over at
// run time is whatever the caller passed.
const run = (transform: ReturnType<typeof retryHttpErrors>, prev: any, signal?: any) =>
  transform(prev, "sendDocument" as any, { chat_id: 1 } as any, signal);

describe("retryHttpErrors", () => {
  test("a call that succeeds is passed through untouched", async () => {
    const { prev, calls } = fakePrev({ returns: OK });
    expect(await run(retryHttpErrors(3, 0), prev)).toBe(OK);
    expect(calls).toHaveLength(1);
    // Method, payload and signal reach the wire as given — a transformer that rewrote any
    // of them would still pass every count assertion below.
    expect(calls[0]).toEqual({
      method: "sendDocument",
      payload: { chat_id: 1 },
      signal: undefined,
    });
  });

  // The defect this file exists for. Pre-fix the same input never returned at all.
  test("an HttpError is retried a bounded number of times, then rethrown", async () => {
    const error = httpError();
    const { prev, calls } = fakePrev({ throws: error });
    await expect(run(retryHttpErrors(3, 0), prev)).rejects.toBe(error);
    // One initial attempt plus three retries. An off-by-one either way changes this.
    expect(calls).toHaveLength(4);
  });

  test("the attempt count is what bounds it", async () => {
    for (const [attempts, expected] of [
      [0, 1],
      [1, 2],
      [5, 6],
    ] as const) {
      const { prev, calls } = fakePrev({ throws: httpError() });
      await run(retryHttpErrors(attempts, 0), prev).catch(() => {});
      expect(calls).toHaveLength(expected);
    }
  });

  test("an HttpError that clears on a retry returns the result", async () => {
    const { prev, calls } = fakePrev(
      { throws: httpError() },
      { throws: httpError() },
      { returns: OK },
    );
    expect(await run(retryHttpErrors(3, 0), prev)).toBe(OK);
    expect(calls).toHaveLength(3);
  });

  /**
   * Only the transport class retries. A `GrammyError` is Telegram answering — the request
   * arrived and was refused, so repeating it changes nothing and delays the report.
   * `autoRetry` still handles the two answers that are worth repeating (`retry_after` and
   * 5xx) on its own, from the result rather than from a throw.
   */
  test("anything that is not an HttpError is rethrown on the first attempt", async () => {
    const errors = [
      new GrammyError(
        "Call to 'sendDocument' failed!",
        { ok: false, error_code: 400, description: "Bad Request" },
        "sendDocument",
        {},
      ),
      new Error("plain"),
      // A rejection that is not an Error at all must not be retried either.
      "not an error" as unknown as Error,
    ];
    for (const error of errors) {
      const { prev, calls } = fakePrev({ throws: error });
      await expect(run(retryHttpErrors(3, 0), prev)).rejects.toBe(error);
      expect(calls).toHaveLength(1);
    }
  });

  /**
   * Retrying a call whose caller has already given up wastes the shutdown. The runner
   * aborts this signal when it stops, and passes it to every `getUpdates`.
   *
   * The scheduled count is asserted, not just the call count: an abort noticed only when
   * the timer fires gives the same one attempt, a whole backoff later. Nothing under this
   * transformer schedules a timer except the backoff.
   */
  test("an aborted signal stops the retry without waiting first", async () => {
    const error = httpError();
    const { prev, calls } = fakePrev({ throws: error });
    let scheduled = 0;
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      scheduled++;
      return real(fn, ms);
    }) as typeof setTimeout;
    try {
      await expect(run(retryHttpErrors(3, 5000), prev, AbortSignal.abort())).rejects.toBe(error);
    } finally {
      globalThis.setTimeout = real;
    }
    expect(calls).toHaveLength(1);
    expect(scheduled).toBe(0);
  });

  /**
   * The abort that the check above cannot see, because it arrives while the backoff is
   * already sleeping. A wait that ran to completion would spend another attempt on a
   * request nobody is waiting for, and the delay doubles each time, so the window this
   * covers is the widest one.
   *
   * The delay is set far longer than the abort so a pass cannot come from the timer
   * winning the race.
   */
  test("an abort during the wait stops it before the next attempt", async () => {
    const error = httpError();
    const { prev, calls } = fakePrev({ throws: error });
    const controller = new AbortController();
    const pending = run(retryHttpErrors(3, 5000), prev, controller.signal);
    await Bun.sleep(5);
    controller.abort();
    await expect(pending).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });

  /**
   * Called with no arguments, which is how `installRetry` calls it — the numbers below are
   * the ones production runs on, not a fixture. Every other test here passes its own, so
   * without this a default of zero retries would pass the whole file.
   *
   * `setTimeout` is replaced rather than waited on: the assertion is then on the delay the
   * code asked for, and the test costs no time. Safe only because the sole caller of
   * `setTimeout` under this transformer is the backoff itself.
   */
  test("the defaults are three retries, doubling from one second", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real(fn, 0);
    }) as typeof setTimeout;
    let calls;
    try {
      const fake = fakePrev({ throws: httpError() });
      calls = fake.calls;
      await run(retryHttpErrors(), fake.prev).catch(() => {});
    } finally {
      globalThis.setTimeout = real;
    }
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});

/**
 * The pair driven through a real `Api`, since what the two halves do to each other is the
 * whole point and neither unit test sees it. A fake `fetch` that always throws is what
 * grammY turns into the `HttpError` this is all about.
 *
 * Remove `retryHttpErrors` from the stack and this still rejects, but after one attempt
 * rather than four. Remove `rethrowHttpErrors` and it never rejects at all, failing on the
 * test timeout — which is the production symptom, an API call that never returns.
 */
describe("installRetry", () => {
  const failingApi = () => {
    let fetches = 0;
    const api = new Api("1:fake-token", {
      fetch: (async () => {
        fetches++;
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    return { api, fetches: () => fetches };
  };

  /**
   * Which of the two ends up inside the other, asserted on what `installRetry` registered
   * rather than on an order written out here.
   *
   * The sequence is chosen because the orders answer it differently. Installed as they
   * are, the two `500`s before the transport failure have already spent two of
   * `autoRetry`'s three attempts, and the retry that clears the failure happens inside the
   * third — so the run ends on the fifth answer, still a `500`. Reversed, the transport
   * retry re-enters `autoRetry` from the top with its budget back at three
   * (`remainingAttempts` is per invocation), which reaches the `ok` at the sixth.
   *
   * Driving `Api` here instead would need grammY's own request timer, which the stub below
   * would fire immediately. The composition mirrors `concatTransformer`: later is outer.
   */
  test("the transport retry runs inside one autoRetry attempt, not around it", async () => {
    const answers = [
      { throws: false, body: { ok: false, error_code: 500, description: "a" } },
      { throws: false, body: { ok: false, error_code: 500, description: "b" } },
      { throws: true, body: null },
      { throws: false, body: { ok: false, error_code: 500, description: "c" } },
      { throws: false, body: { ok: false, error_code: 500, description: "d" } },
      { throws: false, body: { ok: true, result: true } },
    ];
    let n = 0;
    const raw = async () => {
      const answer = answers[Math.min(n++, answers.length - 1)]!;
      if (answer.throws) throw httpError();
      return answer.body as any;
    };

    const installed: any[] = [];
    installRetry({ config: { use: (...t: any[]) => installed.push(...t) } } as any, 3, 0);
    const call = installed.reduce(
      (prev, trans) => (m: any, p: any, s: any) => trans(prev, m, p, s),
      raw,
    );

    const real = globalThis.setTimeout;
    // autoRetry waits three seconds before its first 5xx retry and doubles from there.
    globalThis.setTimeout = ((fn: () => void) => real(fn, 0)) as typeof setTimeout;
    let result;
    try {
      result = await call("sendMessage", {}, undefined);
    } finally {
      globalThis.setTimeout = real;
    }

    expect(result.ok).toBe(false);
    expect(n).toBe(5);
  });

  test("a transport failure is retried, then given up on", async () => {
    const { api, fetches } = failingApi();
    installRetry(api, 3, 0);
    await expect(api.sendMessage(1, "hi")).rejects.toBeInstanceOf(HttpError);
    expect(fetches()).toBe(4);
  });

  // Also the one place the signal is shown to reach the transformer at all: `callApi`
  // hands the caller's own object down the chain, and only the raw client past the end of
  // it derives grammY's shim controller from it.
  test("no retry outlives an aborted request", async () => {
    const { api, fetches } = failingApi();
    installRetry(api, 3, 0);
    await expect(
      api.sendMessage(1, "hi", undefined, AbortSignal.abort() as any),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetches()).toBe(1);
  });
});

/**
 * Why `index.ts` sets `rethrowHttpErrors: true`. Without it `autoRetry` swallows the class
 * this module bounds and never returns, so dropping that one flag restores the hang no
 * matter what the retry above does — and nothing in this repo's own code would look wrong.
 *
 * A failure here means upstream changed: either it now counts these attempts, in which
 * case this module and the flag can go, or the retry moved and the reasoning needs
 * rechecking against the new shape. It does not mean the assertion should be relaxed.
 */
test("autoRetry retries an HttpError without consulting its attempt counter", async () => {
  const source = await Bun.file("node_modules/@grammyjs/auto-retry/out/mod.js").text();

  const start = source.indexOf("async function call()");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("return res;", start);
  expect(end).toBeGreaterThan(start);
  const call = source.slice(start, end);

  // It retries on this class...
  expect(call).toContain("HttpError");
  // ...gated only by the flag, never by a count.
  expect(call).toContain("rethrowHttpErrors");
  expect(call).not.toContain("remainingAttempts");
  expect(call).not.toContain("maxRetries");
});
