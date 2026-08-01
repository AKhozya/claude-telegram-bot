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
const FFPROBE_BIN = "ffprobe";
const WHISPER_BIN = "whisper-cli";

// Conversion measured at 1.6s for five minutes of opus, so this only ever catches a hang.
const FFMPEG_TIMEOUT_MS = 60_000;
// Six times the worst case a 10-minute clip measured (~49s at 2 CPU).
const WHISPER_TIMEOUT_MS = 300_000;
// Reads a container header, not the stream.
const FFPROBE_TIMEOUT_MS = 15_000;

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

  // Bun buffers a piped child's output itself — measured on 1.3.14, 4 MB written to stderr
  // survives awaiting `exited` first — so reading both together is not the deadlock guard
  // the shape suggests, just the form that stays correct if that ever changes.
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
/**
 * Duration of a media file in seconds, or null when it cannot be read.
 *
 * Telegram reports a duration for voice, audio and video messages, so those are refused
 * before the download costs anything. A document carries no duration whatever it contains,
 * so a clip sent as a file has to be measured here — after the transfer, which is the price
 * of accepting that shape at all.
 *
 * Null means "could not tell". Callers refuse on it rather than transcribing, because this is
 * the only cap that shape has — letting it through would spend a probe, a full ffmpeg pass and
 * a whisper run on a clip of any length, and `WHISPER_TIMEOUT_MS` bounds the last of those
 * without enforcing the cap.
 *
 * The container header is asked first and the streams second: some containers carry no
 * `format=duration` and report `N/A` there while the streams still know, and rejecting those
 * would turn a working file into an error.
 *
 * No stream selector, and the longest stream wins. Selecting the audio stream would return
 * nothing for a silent video, so a screen recording sent as a file would be refused while the
 * same clip sent from the gallery is accepted as `[no audio track]`. What is being bounded is
 * how long the file is, not how long its audio is.
 */
export async function probeDuration(inputPath: string): Promise<number | null> {
  const measured: number[] = [];

  // Both forms, always, and the largest wins. Returning the header as soon as it parses would
  // trust it over the streams, and a file whose header says 12 seconds while its packets span
  // 601 would slip past the cap. Some containers also carry no `format=duration` at all and
  // report `N/A` there while the streams still know.
  for (const entries of ["format=duration", "stream=duration"]) {
    let probe;
    try {
      probe = await run(
        [
          FFPROBE_BIN, "-v", "error",
          "-show_entries", entries,
          "-of", "default=noprint_wrappers=1:nokey=1",
          inputPath,
        ],
        FFPROBE_TIMEOUT_MS
      );
    } catch {
      // A throw here is all but always a missing ffprobe, which the second form would hit
      // too. Treated as one failed measurement rather than a verdict anyway, so every
      // failure mode leaves this loop the same way.
      continue;
    }
    if (probe.code !== 0) continue;

    // One line per stream for the second form. `Number`, not `parseFloat`: the latter reads
    // "12abc" as 12, so a garbled line would be taken as a measurement. Strictly positive,
    // not merely finite: some muxers write a zero duration into the header of a file whose
    // packets span minutes, and `N/A` becomes NaN. A truly empty file measures nothing either
    // way, and has nothing to transcribe.
    measured.push(
      ...probe.stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
    );
  }

  return measured.length > 0 ? Math.max(...measured) : null;
}

export async function transcribeMedia(inputPath: string): Promise<string> {
  const wavPath = `${inputPath}.wav`;

  // The cleanup covers the extraction too, not just the transcription: `-y` makes ffmpeg
  // open the output before it can fail, so a timeout or a mid-stream error leaves a partial
  // wav behind.
  try {
    const extract = await run(
      [
        FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
        "-i", inputPath,
        "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        "-y", wavPath,
      ],
      FFMPEG_TIMEOUT_MS
    );

    if (extract.code !== 0) {
      // ffmpeg's own wording when the input has no audio stream to map.
      if (extract.stderr.includes("does not contain any stream")) {
        throw new NoAudioTrackError("no audio track");
      }
      throw new Error(`ffmpeg failed (${extract.code}): ${firstLine(extract.stderr)}`);
    }

    const whisper = await run(
      [
        WHISPER_BIN,
        "-m", WHISPER_MODEL,
        "-f", wavPath,
        "-t", String(WHISPER_THREADS),
        "-nt",
        // Without this whisper-cli forces English: `--language` defaults to `en`, and a
        // multilingual model obeys it. English-only models ignore `auto` harmlessly.
        "-l", "auto",
      ],
      WHISPER_TIMEOUT_MS
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
        `whisper produced no transcript: ${firstLine(whisper.stderr) || "empty output"}`
      );
    }
    return text;
  } finally {
    // Derived data nobody reads again. The temp reaper would eventually get it, but a
    // 10-minute clip is ~19 MB of wav. Missing is the normal case when ffmpeg never got
    // far enough to create it, hence the swallowed error.
    await unlink(wavPath).catch(() => {});
  }
}
