# Audio and Video Transcription Implementation Plan

> **DONE — do not execute.** Every task shipped between `9edba20` and `8e09766` (2026-08-01
> to 2026-08-02): pipeline `9edba20`, voice/audio handler `1ea87b2`, video audio track
> `fa18aac`, image build `05f8a6f`, docs `33f5448`. Later work on the same feature: file
> attachments `1d2c23c`, scene frames `d90bc2c`, silence detection `2c90006`, and the move to
> the `small` model with a re-measured threshold `8e09766`. The unchecked boxes below are the
> plan as written, kept as a record. `src/transcribe.ts` and `src/handlers/audio.ts` are the
> authority on what shipped.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bot transcribe voice notes, audio files and the audio track of videos, so
a spoken message reaches Claude as text instead of an "unsupported" reply.

**Architecture:** One service module (`src/transcribe.ts`) shells out to `ffmpeg` then
`whisper-cli` and returns a string. Two callers use it: a new voice/audio handler that treats
the transcript exactly as a typed message, and the existing video handler, which gains the
transcript alongside the file path it already passes. The binary and model are baked into the
image by a build stage that leaves the toolchain behind.

**Tech Stack:** whisper.cpp v1.9.1 (static musl build), ffmpeg 6.1.2-r2 from alpine, Bun
`Bun.spawn`, grammY.

## Global Constraints

- Model: **`ggml-base.bin` (multilingual)**, invoked with `-l auto`. Owner's decision,
  2026-08-01. whisper-cli's `--language` default is `en`, so the flag is not optional.
- Duration cap: **600 s (10 minutes)**, owner's decision, 2026-08-01. Configurable via
  `TRANSCRIBE_MAX_DURATION_SECONDS`.
- Threads: **2**, matching the container's CPU limit. `nproc` reports the node's 16 inside the
  capped pod, so this must be passed explicitly.
- whisper.cpp pinned to tag **`v1.9.1`**; model pinned to HuggingFace revision
  **`5359861c739e955e79d9a303bcbc70fb988958b1`** and verified by sha256, matching the
  existing kubectl/flux pattern in the Dockerfile.
- No change to the container's CPU/memory limits and **no homelab repo change at all**.
- Gate before every commit: `bun run typecheck && bun test`. Baseline on this branch is
  **415 pass / 1321 expect() / 25 files**, typecheck clean.
- Commit messages: single line, no Claude mention, no `Co-Authored-By`.

---

## Measured facts this plan rests on

Two sources, and they are not interchangeable. The **timing and memory** figures come from
the 2026-07-31 spike recorded in `docs/plan-2026-07-31-register-remainder.md`, Task 6, run in
a pod on worker-node-2 at the real 2 CPU / 2Gi limits. The **size** figures were measured
2026-08-01 for this plan and appear nowhere else — the earlier record has on-disk arithmetic
only, and its image baseline (616 MB) was the uncompressed figure, not the 588 MB pull.

| Fact                      | Value                                                         | Source           |
| ------------------------- | ------------------------------------------------------------- | ---------------- |
| Transcription cost, 2 CPU | ~4.9 s per audio-minute (~12× realtime)                       | Spike, `base.en` |
| Peak RSS, 20-minute clip  | 493 MB, against a 53Mi idle bot in a 2Gi limit                | Spike, `base.en` |
| Threads                   | `-t 2` beats the default `-t 4` by 44 % under a 2-CPU cap     | Spike            |
| Static binary             | 5.4 MiB, `ldd` reports `Not a valid dynamic program`          | Spike            |
| ffmpeg closure            | 568 files, 120.1 MiB on disk, **43.7 MiB compressed pull**    | Here, 2026-08-01 |
| Model `ggml-base.bin`     | 147,951,465 bytes, **127.6 MiB compressed pull**              | Here, 2026-08-01 |
| Current image             | **588 MB compressed** (15 layers, tag 1.27.23, GHCR manifest) | Here, 2026-08-01 |

**The timing and memory rows were measured with `base.en`, not the multilingual `base` this
plan ships.** The two are the same architecture and within 13 KB of each other on disk, and
on the 30 s sample they measured identical (9 s each, both transcripts correct). Treat the
20-minute RSS and per-minute cost as extrapolations across that equivalence, not as direct
measurements of the shipping model. Nothing in the plan is close enough to a limit for the
difference to matter: 493 MB against a 2Gi cap, 49 s against a 300 s timeout.

---

## Assumptions and cut corners

Everything below ⚠ was on the validate-before-build shortlist. All of it has now been
spiked — no item in this table is still resting on reasoning.

| Confidence | Claim                                                                                                                       | How it was settled                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ✅         | whisper.cpp v1.9.1 compiles on musl with only `cmake`/`g++`/`make` and links fully static                                   | Built it; `ldd` rejects the result as non-dynamic                                                         |
| ✅         | `whisper-cli` cannot read Telegram opus **and exits 0 while failing**                                                       | Ran it: `failed to read audio file`, `rc=0`                                                               |
| ✅         | Piping ffmpeg into `whisper-cli -f -` looks like it works and silently transcribes nothing                                  | Piped real speech: empty output, exit 0, timings printed. Temp file returns the correct transcript        |
| ✅         | ffmpeg exits non-zero on a video with no audio track                                                                        | rc=234, `Output file does not contain any stream`, no output file                                         |
| ✅         | A missing model is reported, unlike unreadable audio                                                                        | rc=3, `failed to initialize whisper context`                                                              |
| ✅         | `Bun.spawn` throws synchronously with `code === "ENOENT"` when the binary is absent                                         | Spiked both PATH and absolute-path forms                                                                  |
| ✅         | `Bun.spawn`'s `timeout` fires, kills with SIGTERM, and reports exit 143                                                     | Spiked; partial stdout is lost, so timeout is only ever a failure                                         |
| ✅         | whisper-cli's `--language` defaults to `en`; `-l auto` is required and is harmlessly ignored by `.en` models                | Read `--help`, ran both models with and without the flag                                                  |
| ✅         | The multilingual `base` model matches `base.en` on speed and on the English sample                                          | Ran both: 9 s each under emulation, both transcripts correct                                              |
| ✅         | ffmpeg probes an extensionless input by content                                                                             | Copied an ogg to a name with no extension; conversion succeeded                                           |
| ✅         | Model URL and checksum                                                                                                      | `resolve/<rev>` pinned URL returns 200 and the exact byte count; sha256 matches HuggingFace's own LFS oid |
| ✅         | `brew install whisper-cpp` installs a binary named `whisper-cli`                                                            | Read the Homebrew formula; its own test invokes `#{bin}/whisper-cli`                                      |
| ✅         | The fake-`spawn` test harness works                                                                                         | Ran a standalone script: real subprocess, string-backed fake, and ENOENT all behave                       |
| ✅         | The image is built in **homelab** CI on `ubuntu-latest`, `linux/amd64`, natively                                            | Read `.github/workflows/claude-telegram-build.yml`                                                        |
| ✅         | Task 1's `transcribe.ts` compiles against the real `config.ts` and Bun's types, with no cast on `new Response(proc.stdout)` | Written into the repo as a throwaway probe, `bun run typecheck` clean, then deleted                       |
| ✅         | Task 1's eight tests pass against that module                                                                               | Ran them: 8 pass / 13 expect()                                                                            |
| ✅         | The Dockerfile's `ldd` guard accepts a static binary and rejects a dynamic one                                              | Ran both forms against the real binaries: static passes, dynamic fails                                    |

One defect this table caught before it shipped: an `existsSync(WHISPER_MODEL)` guard at the
top of `transcribeMedia` looked obviously right and would have made **every** unit test fail
on any machine without the model, since `config.ts` resolves the path at module load and the
tests cannot get in front of it. The model check now reads whisper's own stderr instead.

### What the plan review changed

An adversarial pass over the first draft found six defects that code review could not have
caught later, because they were baked into the design:

| Severity | Defect                                                                                                                                                                                                    | Fix                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High     | Every handler test stopped at the download, so **deleting the transcription and the hand-off to Claude left them all passing**                                                                            | Tasks 2 and 3 now each carry tests that drive a successful download and assert the transcript reaches `sendMessageStreaming`                                                                           |
| High     | `audio_${Date.now()}` collides for two messages in the same millisecond, and the loser's cleanup deletes the winner's `.wav`. The repo already fixed exactly this in `document.ts`                        | `uniqueTempDir` moves to `src/utils.ts` and both handlers use it, including `video.ts`, which had the same latent bug                                                                                  |
| Medium   | `delete runner.spawn` does not restore it — `spawn` is an own property of an object literal, unlike `rateLimiter.check`, which lives on a prototype. The module would be left broken for later test files | Save the original and assign it back                                                                                                                                                                   |
| Medium   | Transcription ran **before** `session.startProcessing()`, so for ~49 s `/status` reported an idle bot                                                                                                     | `startProcessing()` moves ahead of the transcription, matching `video.ts`. This fixes `/status` only — `/stop` was already unable to interrupt a transcription, and still is; see the cut corner below |
| Medium   | The plan cited the earlier spike for figures that spike does not contain, and attributed `base.en` measurements to the multilingual model                                                                 | The facts table now names its source per row and states the extrapolation openly                                                                                                                       |
| Low      | Task 3's expected test count silently assumed Task 2 had run                                                                                                                                              | Execution order says so, with the alternative count                                                                                                                                                    |

A second pass over the corrected draft found three more:

| Severity | Defect                                                                                                                                                   | Fix                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| High     | Task 1's `git add` staged none of the three files the `uniqueTempDir` move touches, so a clean checkout after Task 2 or 3 would fail on a missing export | All three paths added to the commit                                                                  |
| Medium   | The claim that `/stop` "takes effect at the query" is false — `stopAndSettle` clears `stopRequested` 100 ms later, so nothing survives                   | Claim withdrawn. `/stop` during transcription is now a named cut corner with its ceiling and its fix |
| Low      | Task 3 said "the failing test", singular, and predicted one failure while adding four tests                                                              | Steps 1-2 now say four, with a table of which three fail and why the fourth does not                 |

A third pass found four more, all in the plan's own prose rather than its code:

| Severity | Defect                                                                                                                                | Fix                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | The review table above claimed moving `startProcessing()` fixed `/stop` too, contradicting the cut corner that says it does not       | Row rewritten as `/status`-only. The cut corner now also separates _skipping the query_ from _killing the subprocess_, which need different fixes |
| Low      | `transcribe.ts`'s own comment still told the reader to delete-to-restore, contradicting the corrected test helper                     | Comment rewritten to say assign the original back, and why this case differs from `rateLimiter.check`                                             |
| Low      | Correcting the `video.ts` docstring left a second false reference to the same non-existent skill in the `finally` block               | Task 3 Step 3 now replaces both                                                                                                                   |
| Low      | The file table claimed `transcribe.test.ts` covers "every failure mode", and omitted the three files the `uniqueTempDir` move touches | Both corrected; the uncovered modes are named                                                                                                     |

One finding was rejected: the review claimed `superpowers:subagent-driven-development` and
`superpowers:executing-plans` do not exist. Both are present in the installed superpowers
6.2.0 skill set, so the header stands.

### Cut corners — deliberate, with the ceiling named

| Corner                                                                                                                                                                                                                                                                                                         | Why it is acceptable                                                                                                                                                                                                                                                                | When to revisit                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No album buffering for audio.** Telegram can deliver several `audio` files as one media group; each will be handled separately                                                                                                                                                                               | `video.ts` already sets this precedent and does the same. The failure mode is N sequential queries, not corruption or loss                                                                                                                                                          | If audio albums turn out to be a real usage pattern. `createMediaGroupBuffer` in `media-group.ts` is generic and already does this for photos and documents                                                                                                                                                                                                                                                                                                    |
| **No concurrency limit on transcription.** Two clips arriving together run two whisper processes                                                                                                                                                                                                               | Each is pinned to 2 threads, so they contend rather than corrupt, and 2 × 493 MB still fits the 2Gi limit                                                                                                                                                                           | If the bot ever serves more than one person                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Silence produces a hallucinated transcript.** 30 s of digital silence returns `" you"`, exit 0                                                                                                                                                                                                               | Measured, and `-sns` does not suppress it. Nobody sends silent voice notes on purpose, and the empty-output check still catches genuine read failures                                                                                                                               | If it shows up in practice, whisper.cpp v1.9 has `--vad`, which needs a second model file                                                                                                                                                                                                                                                                                                                                                                      |
| **Video frames are still not analysed.** Only the audio track is transcribed                                                                                                                                                                                                                                   | Claude has no video tool; extracting frames is a separate feature with its own cost                                                                                                                                                                                                 | If visual video content is actually wanted                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **The transcript is written to the audit log unredacted**, exactly as typed messages already are                                                                                                                                                                                                               | Consistent with `text.ts`, which logs the message body. Changing it would be a separate decision about the audit log as a whole                                                                                                                                                     | If audit-log contents ever need a redaction policy                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Duration comes from the sender.** Telegram documents `duration` as "defined by sender", so a hostile client could understate it                                                                                                                                                                              | Only allowlisted users reach the handler, and the 20 MB Bot API download cap is the real backstop                                                                                                                                                                                   | If the allowlist ever widens                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **`/stop` cannot interrupt a transcription.** `startProcessing()` makes `/status` honest and makes `session.stop()` return `"pending"`, but `stopAndSettle` in `commands.ts` clears `stopRequested` 100 ms later, so nothing survives to cancel the query that follows. The whisper subprocess is never killed | The window is bounded by the duration cap — 49 s at the 10-minute maximum, ~4 s for a typical voice note. Making it work means changing what `pending` means for every caller of `stop()`, which is a change to the stop machinery and belongs in its own commit with its own tests | If the duration cap is ever raised, or if a stuck transcription is observed. Two different fixes, and they are not the same size: **skipping the query** needs only that `stopRequested` survive the `"pending"` path so the handler can check it once `transcribeMedia` returns; **killing the whisper process mid-run** needs an `AbortSignal` threaded into `transcribeMedia` and onto `Bun.spawn`, and is the only one that shortens a stuck transcription |

### Rejected alternatives

- **Fetching the model at runtime to the PVC.** Measured cost of baking it is 127.6 MiB of
  compressed pull, twice a week, on authenticated pulls. The alternative buys that back for a
  download-verify-lock code path and a runtime dependency on HuggingFace during the user's
  first voice message. This reverses the provisional recommendation in the 2026-07-31 spike
  notes, which assumed the model was what pushed the image past the throttle threshold; with
  the real numbers, ffmpeg's 43.7 MiB is unavoidable and the model is the cheap part to make
  deterministic.
- **Piping ffmpeg straight into whisper-cli.** Would remove the temp wav. It silently
  produces an empty transcript — see the table above.
- **A "video-processing skill" wrapping the pipeline**, as `video.ts:4` currently promises. A
  skill runs only if Claude elects to call it; the handler already holds the file and needs no
  model in the loop. The docstring gets corrected instead.

---

## File structure

| File                                                        | Responsibility                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/transcribe.ts` (new)                                   | The whole ffmpeg → whisper pipeline. Knows nothing about Telegram. Exports `transcribeMedia`, two error types, and the `runner` seam tests swap                                                                                                                                                               |
| `src/transcribe.test.ts` (new)                              | The failure modes that shape the design — silent empty output, no audio track, unloadable model, missing binary — driven through a fake `runner.spawn`. Not covered: a generic ffmpeg failure and either subprocess timing out, both of which take the same plain `throw` path as an unexpected non-zero exit |
| `src/utils.ts`                                              | Gains `uniqueTempDir`, relocated from `document.ts` so all three media handlers can use it                                                                                                                                                                                                                    |
| `src/handlers/document.ts`, `src/handlers/document.test.ts` | Import `uniqueTempDir` from its new home; no behaviour change                                                                                                                                                                                                                                                 |
| `src/handlers/audio.ts` (new)                               | Voice and audio messages: download, transcribe, hand the transcript to Claude as if typed                                                                                                                                                                                                                     |
| `src/handlers/audio.test.ts` (new)                          | Guards, caps, and the unavailable path                                                                                                                                                                                                                                                                        |
| `src/config.ts`                                             | Three new settings                                                                                                                                                                                                                                                                                            |
| `src/index.ts`                                              | Route `message:voice` / `message:audio` to the new handler instead of the refusal                                                                                                                                                                                                                             |
| `src/handlers/video.ts`                                     | Transcribe the audio track; correct the docstring                                                                                                                                                                                                                                                             |
| `src/handlers/video.test.ts`                                | Keep the existing guard tests honest under the new flow                                                                                                                                                                                                                                                       |
| `Dockerfile`                                                | whisper build stage, `ffmpeg`, the pinned model                                                                                                                                                                                                                                                               |
| `.env.example`, `AGENTS.md`, `README.md`                    | Document the three settings and the two external dependencies                                                                                                                                                                                                                                                 |

---

## Task 1: The transcription pipeline

**Files:**

- Create: `src/transcribe.ts`
- Create: `src/transcribe.test.ts`
- Modify: `src/config.ts` (append a section near the other runtime-file settings)
- Modify: `src/utils.ts`, `src/handlers/document.ts`, `src/handlers/document.test.ts` (move
  `uniqueTempDir` to the shared module — Tasks 2 and 3 both need it)

**Interfaces:**

- Consumes: `positiveNumberEnv` from `src/config.ts`
- Produces:
  - `transcribeMedia(inputPath: string): Promise<string>` — returns trimmed transcript text
  - `class NoAudioTrackError extends Error`
  - `class TranscriptionUnavailableError extends Error`
  - `const runner: { spawn(cmd: string[], timeoutMs: number): Bun.Subprocess }`
  - `uniqueTempDir(prefix: string): string`, relocated to `src/utils.ts` unchanged

- [ ] **Step 1: Add the settings to `src/config.ts`**

Append after the `IPC_PENDING_TTL_MS` block, before the `Bun.write` line that creates
`TEMP_DIR`:

```ts
// ============== Transcription ==============

// Baked into the image at this path; on macOS the binary comes from `brew install
// whisper-cpp` and the model has to be fetched by hand, so the path is configurable.
export const WHISPER_MODEL = process.env.WHISPER_MODEL || "/usr/local/share/whisper/ggml-base.bin";

// Must match the container's CPU limit, not `nproc` — inside a 2-CPU pod nproc still
// reports the node's 16, and asking for 4 threads measured 44% slower than asking for 2.
export const WHISPER_THREADS = positiveNumberEnv("WHISPER_THREADS", 2);

// Transcription costs ~4.9s per minute of audio at 2 CPU, so this cap is what bounds how
// long the bot can be busy with one clip.
export const TRANSCRIBE_MAX_DURATION_S = positiveNumberEnv("TRANSCRIBE_MAX_DURATION_SECONDS", 600);
```

- [ ] **Step 2: Move `uniqueTempDir` to `src/utils.ts`**

It lives in `src/handlers/document.ts` today, where two more handlers cannot reasonably
import it from. Cut this function and its docstring out of `document.ts`:

```ts
/**
 * A temp dir nobody else will pick. The random suffix is load-bearing: Date.now() alone
 * collides on concurrent same-ms uploads, and the loser's cleanup deletes the winner's
 * files. Exported for the collision test.
 */
export function uniqueTempDir(prefix: string): string {
  return `${TEMP_DIR}/${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
```

Paste it verbatim into `src/utils.ts` — which already imports `TEMP_DIR` — and in
`document.ts` add `uniqueTempDir` to the existing `import { ... } from "../utils"`. Change
the import in `src/handlers/document.test.ts` (line 22, currently pulling it from
`./document`) to come from `../utils`. Nothing else changes: `document.ts` keeps both call
sites and the collision test keeps passing where it is.

- [ ] **Step 3: Write the failing tests**

Create `src/transcribe.test.ts`:

```ts
import { expect, test } from "bun:test";

const { runner, transcribeMedia, NoAudioTrackError, TranscriptionUnavailableError } =
  await import("./transcribe");

interface FakeRun {
  code: number;
  stdout?: string;
  stderr?: string;
}

// The real `runner.spawn` returns a Bun.Subprocess whose stdout/stderr are streams, but
// `new Response(...)` accepts a plain string too, so a fake needs nothing more than this.
// Same assign-and-delete seam as `rateLimiter.check` in text.test.ts; mock.module is
// avoided in this repo.
const realSpawn = runner.spawn;

function fakeSpawns(...runs: FakeRun[]) {
  const calls: string[][] = [];
  (runner as any).spawn = (cmd: string[]) => {
    calls.push(cmd);
    const r = runs.shift() ?? { code: 0, stdout: "" };
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exited: Promise.resolve(r.code),
    };
  };
  return calls;
}

// Assigns the original back rather than deleting. `spawn` is an own property of an object
// literal, so `delete` would leave `runner.spawn` undefined for every later test file —
// unlike `rateLimiter.check`, where delete works because the real method is on the prototype.
function restore() {
  runner.spawn = realSpawn;
}

test("a successful run returns the trimmed transcript", async () => {
  fakeSpawns({ code: 0 }, { code: 0, stdout: "\n hello there \n" });
  try {
    expect(await transcribeMedia("/tmp/telegram-bot/voice_1.ogg")).toBe("hello there");
  } finally {
    restore();
  }
});

test("ffmpeg runs first and whisper reads the wav it wrote, never the original", async () => {
  const calls = fakeSpawns({ code: 0 }, { code: 0, stdout: "text" });
  try {
    await transcribeMedia("/tmp/telegram-bot/voice_2.ogg");
  } finally {
    restore();
  }
  expect(calls[0]![0]).toBe("ffmpeg");
  expect(calls[0]).toContain("/tmp/telegram-bot/voice_2.ogg.wav");
  expect(calls[1]![0]).toBe("whisper-cli");
  expect(calls[1]).toContain("/tmp/telegram-bot/voice_2.ogg.wav");
  // whisper.cpp cannot read opus; handing it the original is the bug this pins.
  expect(calls[1]).not.toContain("/tmp/telegram-bot/voice_2.ogg");
});

test("the language flag is passed, since whisper-cli otherwise forces English", async () => {
  const calls = fakeSpawns({ code: 0 }, { code: 0, stdout: "ciao" });
  try {
    await transcribeMedia("/tmp/telegram-bot/voice_3.ogg");
  } finally {
    restore();
  }
  const l = calls[1]!.indexOf("-l");
  expect(l).toBeGreaterThan(-1);
  expect(calls[1]![l + 1]).toBe("auto");
});

test("a video with no audio track is reported as such, not as a generic failure", async () => {
  fakeSpawns({
    code: 234,
    stderr: "[out#0/wav @ 0x7f] Output file does not contain any stream\n",
  });
  try {
    await expect(transcribeMedia("/tmp/telegram-bot/video_1.mp4")).rejects.toBeInstanceOf(
      NoAudioTrackError,
    );
  } finally {
    restore();
  }
});

// The trap this whole module exists to close: whisper-cli exits 0 on audio it could not
// read, printing nothing. Anything keying on the exit code reports success with an empty
// transcript.
test("whisper exiting 0 with no output is a failure, not an empty transcript", async () => {
  fakeSpawns({ code: 0 }, { code: 0, stdout: "   \n" });
  try {
    await expect(transcribeMedia("/tmp/telegram-bot/voice_4.ogg")).rejects.toThrow(/no transcript/);
  } finally {
    restore();
  }
});

test("a non-zero whisper exit surfaces its stderr", async () => {
  fakeSpawns({ code: 0 }, { code: 1, stderr: "error: failed to process audio\n" });
  try {
    await expect(transcribeMedia("/tmp/telegram-bot/voice_5.ogg")).rejects.toThrow(
      /failed to process audio/,
    );
  } finally {
    restore();
  }
});

// A missing or corrupt model is a deployment problem, not a bad clip, and the user-facing
// message differs. Checked by stderr rather than by stat-ing the model: an existsSync guard
// at the top of the module makes every test above fail on a dev machine that has no model.
test("an unloadable model is unavailability, not a bad file", async () => {
  fakeSpawns({ code: 0 }, { code: 3, stderr: "error: failed to initialize whisper context\n" });
  try {
    await expect(transcribeMedia("/tmp/telegram-bot/voice_6.ogg")).rejects.toBeInstanceOf(
      TranscriptionUnavailableError,
    );
  } finally {
    restore();
  }
});

// Bun.spawn throws synchronously with code ENOENT when the binary is missing, which is the
// normal state on a machine that never installed ffmpeg or whisper-cpp.
test("a missing binary is reported as unavailable, not as a broken file", async () => {
  (runner as any).spawn = () => {
    const err: any = new Error('Executable not found in $PATH: "ffmpeg"');
    err.code = "ENOENT";
    throw err;
  };
  try {
    await expect(transcribeMedia("/tmp/telegram-bot/voice_7.ogg")).rejects.toBeInstanceOf(
      TranscriptionUnavailableError,
    );
  } finally {
    restore();
  }
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test src/transcribe.test.ts`
Expected: FAIL — `Cannot find module './transcribe'`.

- [ ] **Step 5: Write `src/transcribe.ts`**

```ts
/**
 * Transcription pipeline: ffmpeg to 16 kHz mono wav, then whisper.cpp.
 *
 * ffmpeg is not optional. whisper-cli advertises ogg support but only reads vorbis, and
 * Telegram voice is opus — on which it prints `failed to read audio file` and still exits 0.
 * Piping ffmpeg into `whisper-cli -f -` fails the same silent way, so the wav is written to
 * disk and deleted afterwards.
 */

import { unlink } from "fs/promises";
import { WHISPER_MODEL, WHISPER_THREADS } from "./config";

const FFMPEG_BIN = "ffmpeg";
const WHISPER_BIN = "whisper-cli";

// Conversion measured at 1.6s for five minutes of opus, so this only ever catches a hang.
const FFMPEG_TIMEOUT_MS = 60_000;
// Six times the worst case a 10-minute clip measured (~49s at 2 CPU).
const WHISPER_TIMEOUT_MS = 300_000;

/** The input carried no audio at all — a silent screen recording, say. */
export class NoAudioTrackError extends Error {}

/** ffmpeg or whisper-cli is not installed, or the model is missing. */
export class TranscriptionUnavailableError extends Error {}

// Test seam: assign over `.spawn`, then assign the original back. Not delete-to-restore —
// that works for `rateLimiter.check` because the real method sits on a prototype, and would
// leave this one undefined.
export const runner = {
  spawn: (cmd: string[], timeoutMs: number) =>
    Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs }),
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], timeoutMs: number): Promise<RunResult> {
  let proc;
  try {
    proc = runner.spawn(cmd, timeoutMs);
  } catch (error) {
    // Bun.spawn throws rather than resolving when the executable is absent.
    if ((error as { code?: string })?.code === "ENOENT") {
      throw new TranscriptionUnavailableError(`${cmd[0]} is not installed`);
    }
    throw error;
  }

  // Both pipes are drained together: waiting on `exited` first deadlocks as soon as either
  // fills its buffer.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function firstLine(text: string, max = 200): string {
  const line = text.trim().split("\n").filter(Boolean).pop() ?? "";
  return line.slice(0, max);
}

/**
 * Returns the transcript of `inputPath`, which may be any container ffmpeg can probe —
 * extension included or not, since ffmpeg identifies inputs by content.
 *
 * Throws `NoAudioTrackError` when there is nothing to transcribe, and
 * `TranscriptionUnavailableError` when the machine is not set up for it.
 */
export async function transcribeMedia(inputPath: string): Promise<string> {
  const wavPath = `${inputPath}.wav`;

  const extract = await run(
    [
      FFMPEG_BIN,
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-y",
      wavPath,
    ],
    FFMPEG_TIMEOUT_MS,
  );

  if (extract.code !== 0) {
    // ffmpeg's own wording when the input has no audio stream to map.
    if (extract.stderr.includes("does not contain any stream")) {
      throw new NoAudioTrackError("no audio track");
    }
    throw new Error(`ffmpeg failed (${extract.code}): ${firstLine(extract.stderr)}`);
  }

  try {
    const whisper = await run(
      [
        WHISPER_BIN,
        "-m",
        WHISPER_MODEL,
        "-f",
        wavPath,
        "-t",
        String(WHISPER_THREADS),
        "-nt",
        // Without this whisper-cli forces English: `--language` defaults to `en`, and a
        // multilingual model obeys it. English-only models ignore `auto` harmlessly.
        "-l",
        "auto",
      ],
      WHISPER_TIMEOUT_MS,
    );

    // A model that will not load is a deployment problem, and the user-facing message
    // differs. Detected here rather than by stat-ing WHISPER_MODEL up front: a filesystem
    // check at the top of this module fails every unit test on a machine with no model.
    if (whisper.stderr.includes("failed to initialize whisper context")) {
      throw new TranscriptionUnavailableError(`model not usable at ${WHISPER_MODEL}`);
    }
    if (whisper.code !== 0) {
      throw new Error(`whisper failed (${whisper.code}): ${firstLine(whisper.stderr)}`);
    }

    const text = whisper.stdout.trim();
    if (!text) {
      // Exit 0 with nothing on stdout is what an unreadable input looks like. The exit
      // code cannot be the failure signal here.
      throw new Error(
        `whisper produced no transcript: ${firstLine(whisper.stderr) || "empty output"}`,
      );
    }
    return text;
  } finally {
    // Derived data nobody reads again. The temp reaper would eventually get it, but a
    // 10-minute clip is ~19 MB of wav.
    await unlink(wavPath).catch(() => {});
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/transcribe.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Run the full gate**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; 423 pass across 26 files.

- [ ] **Step 8: Commit**

```bash
git add src/transcribe.ts src/transcribe.test.ts src/config.ts \
        src/utils.ts src/handlers/document.ts src/handlers/document.test.ts
git commit -m "Add ffmpeg and whisper.cpp transcription pipeline"
```

---

## Task 2: The voice and audio handler

**Files:**

- Create: `src/handlers/audio.ts`
- Create: `src/handlers/audio.test.ts`
- Modify: `src/index.ts` (the `message:voice` / `message:audio` registration)

**Interfaces:**

- Consumes: `transcribeMedia`, `NoAudioTrackError`, `TranscriptionUnavailableError` from
  `src/transcribe.ts`; `TRANSCRIBE_MAX_DURATION_S` from `src/config.ts`
- Produces: `handleAudio(ctx: BotContext): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/handlers/audio.test.ts`:

```ts
import { expect, test } from "bun:test";

const { rateLimiter } = await import("../security");
const { session } = await import("../session");
const { runner } = await import("../transcribe");
const { handleAudio } = await import("./audio");

interface Recorded {
  replies: string[];
  reactions: string[];
  edits: string[];
}

const rec = (): Recorded => ({ replies: [], reactions: [], edits: [] });

// No `ctx.getFile`, so downloadTelegramFile throws and execution stops at the download —
// the same trick video.test.ts uses to prove a call got past the guards without stubbing a
// module.
const makeCtx = (message: Record<string, unknown>, r: Recorded): any => ({
  from: { id: 1, username: "tester" },
  chat: { id: 100 },
  msg: { message_id: 5 },
  message,
  reply: async (t: string) => {
    r.replies.push(t);
    return { chat: { id: 100 }, message_id: 901 };
  },
  replyWithChatAction: async () => {},
  api: {
    setMessageReaction: async (_c: number, _m: number, e: any[]) => {
      r.reactions.push(e[0].emoji);
    },
    editMessageText: async (_c: number, _m: number, t: string) => {
      r.edits.push(t);
    },
    deleteMessage: async () => {},
  },
});

test("a message with neither voice nor audio returns before spending a reaction", async () => {
  const r = rec();
  await handleAudio(makeCtx({}, r));
  expect(r.replies).toEqual([]);
  expect(r.reactions).toEqual([]);
});

// Duration is checked before the download, so an over-long clip costs no transfer and no
// whisper run.
test("a clip past the duration cap is refused before it is downloaded", async () => {
  const r = rec();
  await handleAudio(makeCtx({ voice: { file_id: "v1", duration: 601 } }, r));
  expect(r.replies).toEqual(["❌ Too long to transcribe. Maximum is 10 minutes."]);
  expect(r.reactions).toEqual(["👀", "👎"]);
  expect(r.edits).toEqual([]);
});

// The cap is `>`, so exactly at it is allowed. This pins the boundary only — it reads the
// same with the guard deleted, which the over-long test above is what covers.
test("a clip exactly at the cap is not treated as too long", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  limiter.check = () => [true];
  try {
    await handleAudio(makeCtx({ voice: { file_id: "v2", duration: 600 } }, r));
  } finally {
    delete limiter.check;
  }
  expect(r.replies).toEqual(["🎤 Transcribing..."]);
  expect(r.edits).toEqual(["❌ Failed to download audio."]);
});

test("an audio file is accepted on the same path as a voice note", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  limiter.check = () => [true];
  try {
    await handleAudio(makeCtx({ audio: { file_id: "a1", duration: 12 } }, r));
  } finally {
    delete limiter.check;
  }
  expect(r.replies).toEqual(["🎤 Transcribing..."]);
  expect(r.edits).toEqual(["❌ Failed to download audio."]);
});

// Everything above stops at the download, so none of it would notice if the transcription
// and hand-off were deleted outright. The two tests below are the ones that would.

/** A ctx whose download succeeds, returning the path it was asked to write. */
const makeDownloadableCtx = (message: Record<string, unknown>, r: Recorded): any => ({
  ...makeCtx(message, r),
  getFile: async () => ({ download: async (p: string) => p }),
});

const realSpawn = runner.spawn;

/** Pins the rate limiter, the two subprocesses, and the session in one place. */
async function withPipeline(
  whisperStdout: string,
  body: (sent: string[]) => Promise<void>,
): Promise<void> {
  const sent: string[] = [];
  const limiter = rateLimiter as any;
  const s = session as any;
  const saved = {
    sessionId: s.sessionId,
    conversationTitle: s.conversationTitle,
    lastMessage: s.lastMessage,
  };
  limiter.check = () => [true];
  // First spawn is ffmpeg, second is whisper-cli.
  const runs = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: whisperStdout, stderr: "" },
  ];
  (runner as any).spawn = () => {
    const next = runs.shift() ?? { code: 0, stdout: "", stderr: "" };
    return { stdout: next.stdout, stderr: next.stderr, exited: Promise.resolve(next.code) };
  };
  s.sendMessageStreaming = async (prompt: string) => {
    sent.push(prompt);
    return "ok";
  };
  try {
    await body(sent);
  } finally {
    delete limiter.check;
    runner.spawn = realSpawn;
    delete s.sendMessageStreaming;
    Object.assign(s, saved);
  }
}

// The whole point of the handler: what was said reaches Claude as the prompt, unchanged.
// Deleting the transcription or the hand-off fails this.
test("the transcript is what gets sent to Claude, and is echoed back to the user", async () => {
  const r = rec();
  await withPipeline("  book me a flight to Rome  ", async (sent) => {
    await handleAudio(makeDownloadableCtx({ voice: { file_id: "v9", duration: 8 } }, r));
    expect(sent).toEqual(["book me a flight to Rome"]);
  });
  expect(r.edits).toContain("🎤 book me a flight to Rome");
  expect(r.reactions).toEqual(["👀", "👌"]);
});

// A host with no ffmpeg or whisper-cli is the normal state outside the container, and it
// must say so rather than blaming the file.
test("a host without the binaries says so, and sends nothing to Claude", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  const s = session as any;
  let queried = false;
  limiter.check = () => [true];
  (runner as any).spawn = () => {
    const err: any = new Error('Executable not found in $PATH: "ffmpeg"');
    err.code = "ENOENT";
    throw err;
  };
  s.sendMessageStreaming = async () => {
    queried = true;
    return "";
  };
  try {
    await handleAudio(makeDownloadableCtx({ voice: { file_id: "v10", duration: 8 } }, r));
  } finally {
    delete limiter.check;
    runner.spawn = realSpawn;
    delete s.sendMessageStreaming;
  }
  expect(queried).toBe(false);
  expect(r.edits).toEqual(["❌ Transcription isn't available on this host."]);
  expect(r.reactions).toEqual(["👀", "👎"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/handlers/audio.test.ts`
Expected: FAIL — `Cannot find module './audio'`.

- [ ] **Step 3: Write `src/handlers/audio.ts`**

```ts
/**
 * Voice and audio handler.
 *
 * The transcript is sent on as if the user had typed it: session.ts reads the thinking
 * keywords out of that text, so a spoken "ultrathink about X" behaves like the typed form.
 */

import type { BotContext } from "../types";
import { session } from "../session";
import { TRANSCRIBE_MAX_DURATION_S } from "../config";
import { auditLog, startTypingIndicator, uniqueTempDir } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { handleProcessingError } from "./media-group";
import { downloadTelegramFile } from "./download";
import { markReceived, markDone, markFailed } from "./reactions";
import { rateLimitOrReply } from "./rate-limit";
import { transcribeMedia, NoAudioTrackError, TranscriptionUnavailableError } from "../transcribe";

// How much of the transcript the status message shows back. The whole thing still goes to
// Claude; this is only so the user can see what was heard.
const TRANSCRIPT_PREVIEW_CHARS = 500;

export async function handleAudio(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const media = ctx.message?.voice || ctx.message?.audio;

  if (!userId || !chatId || !media) {
    return;
  }

  await markReceived(ctx);

  // Checked before the download: transcription costs ~4.9s per audio-minute, and file size
  // does not bound that — 20 MB of opus is about two hours of speech.
  if (media.duration > TRANSCRIBE_MAX_DURATION_S) {
    await markFailed(ctx);
    await ctx.reply(
      `❌ Too long to transcribe. Maximum is ${Math.floor(
        TRANSCRIBE_MAX_DURATION_S / 60,
      )} minutes.`,
    );
    return;
  }

  if (await rateLimitOrReply(ctx, userId, username)) return;

  console.log(`Received ${ctx.message?.voice ? "voice" : "audio"} from @${username}`);

  const statusMsg = await ctx.reply("🎤 Transcribing...");

  // Marked busy before the transcription, not after: whisper can run for the better part of
  // a minute, and `session.isRunning` is what /status reads. Left until after, /status would
  // report an idle bot while it is plainly working. This does not make the transcription
  // interruptible — /stop marks a cancellation that `stopAndSettle` clears 100 ms later,
  // long before any query exists to consume it.
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  // Declared outside the try so the catch can still reach the tool messages the status
  // callback posted.
  const state = new StreamingState();

  try {
    // No extension: ffmpeg identifies inputs by content, and Telegram audio arrives as
    // anything from opus to flac. uniqueTempDir, not a bare timestamp — two chats can
    // send in the same millisecond, and the loser's cleanup would delete the winner's file.
    let mediaPath: string;
    try {
      mediaPath = await downloadTelegramFile(ctx, uniqueTempDir("audio"));
    } catch (error) {
      console.error("Failed to download audio:", error);
      await markFailed(ctx);
      await ctx.api.editMessageText(chatId, statusMsg.message_id, "❌ Failed to download audio.");
      return;
    }

    let transcript: string;
    try {
      transcript = await transcribeMedia(mediaPath);
    } catch (error) {
      console.error("Transcription failed:", error);
      await markFailed(ctx);
      const message =
        error instanceof TranscriptionUnavailableError
          ? "❌ Transcription isn't available on this host."
          : error instanceof NoAudioTrackError
            ? "❌ That file has no audio track."
            : "❌ Couldn't transcribe that.";
      await ctx.api.editMessageText(chatId, statusMsg.message_id, message);
      return;
    }

    const preview =
      transcript.length > TRANSCRIPT_PREVIEW_CHARS
        ? `${transcript.slice(0, TRANSCRIPT_PREVIEW_CHARS)}…`
        : transcript;
    await ctx.api.editMessageText(chatId, statusMsg.message_id, `🎤 ${preview}`);

    session.lastMessage = transcript; // consumed by /retry
    session.setTitleIfNew(transcript);

    const statusCallback = createStatusCallback(ctx, state);

    const response = await session.sendMessageStreaming(
      transcript,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
    );

    await auditLog(userId, username, "VOICE", transcript, response);
    await markDone(ctx);
  } catch (error) {
    await handleProcessingError(ctx, error, state);
  } finally {
    stopProcessing();
    typing.stop();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/handlers/audio.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register the handler in `src/index.ts`**

Add the import beside the other handler imports:

```ts
import { handleAudio } from "./handlers/audio";
```

Replace this block:

```ts
// No speech-to-text in this build. Without this, voice/audio match no filter at
// all — `message:text` needs a `text` field — and the user gets silence.
bot.on(["message:voice", "message:audio"], (ctx) =>
  ctx.reply("🎤 Voice and audio aren't supported — please send text."),
);
```

with:

```ts
bot.on(["message:voice", "message:audio"], handleAudio);
```

- [ ] **Step 6: Run the full gate**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; 429 pass across 27 files.

- [ ] **Step 7: Commit**

```bash
git add src/handlers/audio.ts src/handlers/audio.test.ts src/index.ts
git commit -m "Transcribe voice and audio messages instead of refusing them"
```

---

## Task 3: Transcribe the audio track of videos

**Files:**

- Modify: `src/handlers/video.ts`
- Modify: `src/handlers/video.test.ts`

**Interfaces:**

- Consumes: `transcribeMedia`, `NoAudioTrackError` from `src/transcribe.ts`
- Produces: nothing new

- [ ] **Step 1: Write the failing tests**

Four of them. Only the guard-order test passes before the implementation lands.

Add these imports at the top of `src/handlers/video.test.ts`, beside the existing ones:

```ts
const { session } = await import("../session");
const { runner } = await import("../transcribe");
```

Append to `src/handlers/video.test.ts`:

```ts
// Videos are capped by duration as well as size now.
test("an over-long video is refused before it is downloaded", async () => {
  const r = rec();
  await handleVideo(makeCtx({ file_id: "v3", file_size: 1024, duration: 601 }, r));
  expect(r.replies).toEqual(["❌ Too long to transcribe. Maximum is 10 minutes."]);
  expect(r.reactions).toEqual(["👀", "👎"]);
  expect(r.edits).toEqual([]);
});

// Which guard runs first is a real choice, not an accident: the size check is the one that
// saves a transfer, so a clip violating both must be refused on size. Reordering them
// silently passes every other test in this file.
test("a video breaking both caps is refused on size, the cheaper guard", async () => {
  const r = rec();
  await handleVideo(makeCtx({ file_id: "v4", file_size: 51 * 1024 * 1024, duration: 601 }, r));
  expect(r.replies).toEqual(["❌ Video too large. Maximum size is 50MB."]);
});

/** A ctx whose download succeeds, returning the path it was asked to write. */
const makeDownloadableCtx = (video: unknown, r: Recorded): any => ({
  ...makeCtx(video, r),
  getFile: async () => ({ download: async (p: string) => p }),
});

const realSpawn = runner.spawn;

async function withVideoPipeline(
  whisper: { code: number; stdout: string; stderr: string },
  ffmpeg: { code: number; stdout: string; stderr: string },
  body: (sent: string[]) => Promise<void>,
): Promise<void> {
  const sent: string[] = [];
  const limiter = rateLimiter as any;
  const s = session as any;
  const saved = {
    sessionId: s.sessionId,
    conversationTitle: s.conversationTitle,
    lastMessage: s.lastMessage,
  };
  limiter.check = () => [true];
  const runs = [ffmpeg, whisper];
  (runner as any).spawn = () => {
    const next = runs.shift() ?? { code: 0, stdout: "", stderr: "" };
    return { stdout: next.stdout, stderr: next.stderr, exited: Promise.resolve(next.code) };
  };
  s.sendMessageStreaming = async (prompt: string) => {
    sent.push(prompt);
    return "ok";
  };
  try {
    await body(sent);
  } finally {
    delete limiter.check;
    runner.spawn = realSpawn;
    delete s.sendMessageStreaming;
    Object.assign(s, saved);
  }
}

const OK = { code: 0, stdout: "", stderr: "" };

// Deleting the transcription call from the handler fails this and nothing else in the file.
test("the video prompt carries the transcript and the file path", async () => {
  const r = rec();
  await withVideoPipeline(
    { code: 0, stdout: "the meeting is at noon", stderr: "" },
    OK,
    async (sent) => {
      await handleVideo(makeDownloadableCtx({ file_id: "v5", file_size: 1024, duration: 30 }, r));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("the meeting is at noon");
      expect(sent[0]).toContain(".mp4");
    },
  );
});

// A silent screen recording is ordinary input, not an error: Claude still gets the path.
test("a video with no audio track still reaches Claude, marked as silent", async () => {
  const r = rec();
  await withVideoPipeline(
    OK,
    {
      code: 234,
      stdout: "",
      stderr: "[out#0/wav] Output file does not contain any stream\n",
    },
    async (sent) => {
      await handleVideo(makeDownloadableCtx({ file_id: "v6", file_size: 1024, duration: 30 }, r));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("[no audio track]");
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/handlers/video.test.ts`
Expected: 3 fail, 4 pass. Specifically:

| Test                               | Why it fails now                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| over-long video refused            | No duration guard exists, so the reply is `📹 Downloading video...`                                                               |
| prompt carries the transcript      | The prompt still says "Please transcribe it for me" and contains no transcript                                                    |
| no audio track marker              | Same — nothing calls `transcribeMedia`, so no marker is ever produced                                                             |
| refused on size, the cheaper guard | **Passes already.** The size guard exists and returns first; this test exists to keep it first once a second guard sits beside it |

- [ ] **Step 3: Correct the docstring in `src/handlers/video.ts`**

Replace lines 1-5:

```ts
/**
 * Video handler for Claude Telegram Bot.
 *
 * Downloads video files and passes them to video-processing skill for transcription.
 */
```

with:

```ts
/**
 * Video handler for Claude Telegram Bot.
 *
 * Downloads the video, transcribes its audio track with whisper.cpp, and passes the
 * transcript plus the file path to Claude. Frames are not analysed — there is no video tool,
 * and the path is passed so Claude can reach the file itself if it needs to.
 */
```

There is a second, equally false claim about that skill further down the same file, in the
`finally` block. Replace:

```ts
// Deliberately not removed — the video-processing skill reads it from disk during
// the query above. The temp reaper collects it once it ages past TEMP_RETENTION_HOURS.
```

with:

```ts
// Deliberately not removed — the path went into the prompt, so Claude may still read
// the file during the query above. The temp reaper collects it once it ages past
// TEMP_RETENTION_HOURS. The derived .wav is already gone; transcribeMedia unlinks it.
```

- [ ] **Step 4: Give the download a collision-proof name**

`downloadVideo` builds `${TEMP_DIR}/video_${timestamp}.mp4` from `Date.now()` alone. Two
videos arriving in the same millisecond land on the same path, and now that a `.wav` is
derived from it, one call's cleanup deletes the other's working file. Replace the body's
path construction:

```ts
const timestamp = Date.now();

// Telegram delivers both regular videos and video notes as mp4.
const videoPath = `${TEMP_DIR}/video_${timestamp}.mp4`;
```

with:

```ts
// Telegram delivers both regular videos and video notes as mp4. The random suffix in
// uniqueTempDir is load-bearing now that a .wav is derived from this path.
const videoPath = `${uniqueTempDir("video")}.mp4`;
```

- [ ] **Step 5: Add the duration guard**

In `src/handlers/video.ts`, replace the `TEMP_DIR` import and add the transcription one:

```ts
import { TRANSCRIBE_MAX_DURATION_S } from "../config";
import { auditLog, startTypingIndicator, uniqueTempDir } from "../utils";
import { transcribeMedia, NoAudioTrackError } from "../transcribe";
```

(`TEMP_DIR` is no longer referenced once Step 4 lands, and the existing
`import { auditLog, startTypingIndicator } from "../utils";` line gains `uniqueTempDir`)

Directly after the existing size guard — the block ending
`` `❌ Video too large. Maximum size is ${MAX_VIDEO_SIZE / 1024 / 1024}MB.` `` — insert:

```ts
// Size does not bound transcription time, so duration is guarded separately. Size is
// checked first because it is the one that costs a transfer.
if (video.duration > TRANSCRIBE_MAX_DURATION_S) {
  await markFailed(ctx);
  await ctx.reply(
    `❌ Too long to transcribe. Maximum is ${Math.floor(TRANSCRIBE_MAX_DURATION_S / 60)} minutes.`,
  );
  return;
}
```

- [ ] **Step 6: Transcribe before building the prompt**

In `src/handlers/video.ts`, replace the prompt-building block:

```ts
const prompt = caption
  ? `Here's a video file at path: ${videoPath}\n\nUser says: ${caption}`
  : `I've received a video file at path: ${videoPath}\n\nPlease transcribe it for me.`;
```

with:

```ts
// A video with no audio track is normal, not an error — a screen recording, say. Any
// other failure is reported in the prompt rather than aborting, because the file path
// is still useful to Claude.
let transcript = "";
try {
  transcript = await transcribeMedia(videoPath);
} catch (error) {
  transcript =
    error instanceof NoAudioTrackError ? "[no audio track]" : "[audio could not be transcribed]";
  console.error("Video transcription failed:", error);
}

const prompt = caption
  ? `Here's a video file at path: ${videoPath}\n\nTranscript of its audio:\n${transcript}\n\nUser says: ${caption}`
  : `I've received a video file at path: ${videoPath}\n\nTranscript of its audio:\n${transcript}`;
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test src/handlers/video.test.ts`
Expected: PASS, 7 tests in that file.

- [ ] **Step 8: Run the full gate**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; 433 pass across 27 files.

- [ ] **Step 9: Commit**

```bash
git add src/handlers/video.ts src/handlers/video.test.ts
git commit -m "Transcribe the audio track of videos and correct the handler docstring"
```

---

## Task 4: Ship ffmpeg, whisper-cli and the model in the image

**Files:**

- Modify: `Dockerfile`

**Interfaces:**

- Consumes: nothing from earlier tasks
- Produces: `/usr/local/bin/whisper-cli` and `/usr/local/share/whisper/ggml-base.bin` in the
  runtime image, matching `WHISPER_MODEL`'s default from Task 1

- [ ] **Step 1: Add the whisper build stage**

Insert between the `deps` stage and the runtime `FROM` (that is, after the
`RUN echo "build: $BUILD_TS" && bun update` line):

```dockerfile
# whisper.cpp, built static so the runtime image needs no libstdc++/libgomp and the
# toolchain never lands in it. OpenMP is off because static libgomp on musl is the usual
# failure; ggml's own thread pool covers it. Pinned by tag — this layer is cache-stable
# across the scheduled rebuilds, unlike the deps stage above.
FROM oven/bun:1.3-alpine AS whisper
ARG WHISPER_VERSION=v1.9.1
RUN apk add --no-cache cmake g++ make git \
    && git clone --depth 1 --branch "${WHISPER_VERSION}" \
         https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp \
    && cd /tmp/whisper.cpp \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
         -DWHISPER_BUILD_TESTS=OFF -DGGML_OPENMP=OFF \
         -DCMAKE_EXE_LINKER_FLAGS=-static \
    && cmake --build build -j"$(nproc)" --config Release \
    && ! ldd build/bin/whisper-cli 2>&1 | grep -q "=>"
```

The `ldd` line is the check: a static binary makes `ldd` report
`not a valid dynamic program` with no `=>` lines, so a build that silently went dynamic
fails here rather than at runtime in a library-less image.

- [ ] **Step 2: Add ffmpeg to the runtime package list**

In the runtime stage, extend the existing `apk add` line and its comment. Add to the comment
block above it:

```
# ffmpeg = audio extraction for transcription. whisper.cpp cannot read Telegram's opus, and
# fails silently rather than erroring, so this is a hard dependency of that feature.
```

and add `ffmpeg` to the package list:

```dockerfile
RUN apk add --no-cache git openssh-client curl jq ca-certificates bash poppler-utils unzip \
    bubblewrap socat github-cli nodejs npm chezmoi ffmpeg
```

- [ ] **Step 3: Copy the binary and fetch the model**

Insert after the flux CLI block and before the Codex CLI block:

```dockerfile
COPY --from=whisper /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli

# Multilingual base model — the English-only variant silently forces English output. Pinned
# to a HuggingFace revision rather than `main` so a scheduled rebuild cannot pick up a
# different file, and checksum-verified like kubectl and flux above.
ARG WHISPER_MODEL_REV=5359861c739e955e79d9a303bcbc70fb988958b1
ARG WHISPER_MODEL_SHA=60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe
RUN mkdir -p /usr/local/share/whisper \
    && curl -fsSL "https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REV}/ggml-base.bin" \
         -o /usr/local/share/whisper/ggml-base.bin \
    && echo "${WHISPER_MODEL_SHA}  /usr/local/share/whisper/ggml-base.bin" | sha256sum -c -
```

- [ ] **Step 4: Build the image and prove the pipeline runs inside it**

```bash
docker build --platform linux/amd64 -t ctb-transcribe-check .
docker run --rm --platform linux/amd64 --entrypoint sh ctb-transcribe-check -c '
  set -e
  ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=3" \
    -ar 16000 -ac 1 -c:a pcm_s16le /tmp/t.wav
  whisper-cli -m /usr/local/share/whisper/ggml-base.bin -f /tmp/t.wav -t 2 -nt -l auto
  echo "pipeline-ok"
'
```

Expected: `pipeline-ok`. The transcript of a sine tone is meaningless — what this proves is
that both binaries run in the runtime image, the model loads, and nothing is missing a shared
library.

- [ ] **Step 5: Record the image size**

```bash
docker image inspect ctb-transcribe-check --format '{{.Size}}'
```

Expected: larger than the pre-change image by roughly 267 MiB on disk. If it is larger than
that, something other than the three intended additions came along — check
`docker history ctb-transcribe-check` before committing.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile
git commit -m "Build whisper.cpp static and ship it with ffmpeg and the base model"
```

---

## Task 5: Document the feature

**Files:**

- Modify: `.env.example`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: the three settings from Task 1
- Produces: nothing code depends on

- [ ] **Step 1: Add the settings to `.env.example`**

Append:

```bash
# Transcription (voice, audio, and the audio track of videos)
# WHISPER_MODEL=/usr/local/share/whisper/ggml-base.bin   # baked into the container image
# WHISPER_THREADS=2                                      # match the container's CPU limit
# TRANSCRIBE_MAX_DURATION_SECONDS=600                    # clips longer than this are refused
```

- [ ] **Step 2: Update `AGENTS.md`**

In the Handlers section, replace:

```
Voice and audio have no dedicated handler — `src/index.ts` replies inline that speech-to-text isn't supported, so users get a reply instead of silence.
```

with:

```
- **`audio.ts`** - Voice notes and audio files. Transcribes with whisper.cpp and sends the transcript on as if it had been typed, so thinking keywords work spoken
```

placing it in the message-type handler list after `video.ts`. In the Key Modules section, add
after `src/retry.ts`:

```
- **`src/transcribe.ts`** - ffmpeg → whisper.cpp pipeline. ffmpeg is mandatory: whisper.cpp cannot read Telegram's opus and exits 0 while failing, so empty output is the failure signal, not the exit code
```

Add three rows to the configuration table:

```
| `WHISPER_MODEL` | Path to the ggml model; baked into the image at `/usr/local/share/whisper/ggml-base.bin` |
| `WHISPER_THREADS` | Threads for whisper.cpp, default 2. Must track the CPU limit — `nproc` reports the node's count inside a capped pod |
| `TRANSCRIBE_MAX_DURATION_SECONDS` | Longest clip accepted, default 600. Size does not bound transcription time |
```

Add to the External Dependencies section, under the `pdftotext` note:

```bash
brew install ffmpeg whisper-cpp  # transcription; whisper-cpp provides whisper-cli
```

with the note that the model is not installed by brew and `WHISPER_MODEL` must point at one
downloaded by hand.

- [ ] **Step 3: Update `README.md`**

In Bot Features, replace the video line and add an audio line:

```
- 🎬 **Video**: Video messages and video notes — the audio track is transcribed and passed to Claude
- 🎤 **Voice & audio**: Voice notes and audio files are transcribed locally with whisper.cpp and answered like a typed message
```

In Prerequisites, add:

```
- **ffmpeg and whisper-cli** (optional, for transcription) - `brew install ffmpeg whisper-cpp`. Set `WHISPER_MODEL` to a downloaded ggml model. Without them the bot replies that transcription isn't available and everything else works as before
```

- [ ] **Step 4: Run the gate**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; 433 pass across 27 files. Docs-only, so this only proves nothing
was disturbed.

- [ ] **Step 5: Commit**

```bash
git add .env.example AGENTS.md README.md
git commit -m "Document transcription settings and its two external dependencies"
```

---

## Execution order

Task 1 must come first — Tasks 2 and 3 both import `transcribeMedia` and the relocated
`uniqueTempDir` from it. Tasks 2 and 3 do not depend on each other's code, but **the expected
test counts in each task assume the order 1 → 2 → 3**: run Task 3 before Task 2 and its gate
reads 427 across 26 files, not 433 across 27. Task 4 is independent of all three and can be
done at any point, but until it lands the feature only works on a host with ffmpeg and
whisper-cli installed. Task 5 last, so it documents what actually shipped.

## What this plan does not do

- No homelab change. No resource limit is raised, no environment variable is added to the
  deployment, and the namespace ResourceQuota is not touched.
- No frame extraction from video.
- No album buffering for audio.
- No VAD model, and therefore no fix for the hallucinated transcript on pure silence.
- No speaker diarisation, no translation (`whisper-cli --translate` exists and is not wired
  up), no timestamps in the transcript (`-nt` suppresses them deliberately — they would be
  noise in a prompt).
