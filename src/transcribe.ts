/**
 * Transcription pipeline: ffmpeg to 16 kHz mono wav, then whisper.cpp.
 *
 * ffmpeg is not optional. whisper-cli advertises ogg support but only reads vorbis, and
 * Telegram voice is opus — on which it prints `failed to read audio file` and still exits 0.
 * Piping ffmpeg into `whisper-cli -f -` fails the same silent way, so the wav is written to
 * disk and deleted afterwards.
 */

import { stat, unlink } from "fs/promises";
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

/**
 * Peak level at or below which a track is treated as having nothing to transcribe, in dBFS.
 *
 * Measured against this model rather than reasoned about, by attenuating a known clip and
 * reading back what whisper made of it:
 *
 *   peak -53.7  transcript correct
 *   peak -63.9  still usable — one word wrong
 *   peak -73.4  unrelated invented text
 *   peak -90.3  [BLANK_AUDIO]
 *
 * So the line sits at -70: below it whisper invents, above it a very quiet recording still
 * transcribes. dBFS is not an audibility threshold, which is why picking a round number by
 * feel gets this wrong in both directions — -60 would have rejected the usable -63.9 case,
 * and the 16-bit silence floor near -90 would have let the invented text through.
 */
const SILENCE_MAX_VOLUME_DB = -70;

/** The input carried no audio at all — a silent screen recording, say. */
export class NoAudioTrackError extends Error {}

/** The audio track exists but carries nothing audible — a muted recording, say. */
export class SilentAudioError extends Error {}

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

/** Most frames handed to Claude for one video, however many scene changes it contains. */
const MAX_FRAMES = 8;
/** How different a frame must be from the last to count as a cut. ffmpeg's scale is 0-1. */
const SCENE_THRESHOLD = 0.3;
/** Frames for a clip with no detectable cut — a static screen recording is the usual case. */
const STATIC_FRAMES = 3;
/**
 * Frames per second the detector looks at. Bounds both its runtime and the showinfo output it
 * buffers: without it a high-frame-rate clip emits one line per frame, and at the 600s
 * duration cap that is six figures of lines held in memory for nothing. Cuts closer together
 * than this are missed, which does not matter for "what is in this video".
 */
const DETECT_FPS = 4;
/** Detection decodes every frame, so it runs on a thumbnail-sized copy. */
const DETECT_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 20_000;

/** Evenly spaced picks from `values`, at most `count` of them, endpoints included. */
function spread<T>(values: T[], count: number): T[] {
  if (values.length <= count) return values;
  const step = (values.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => values[Math.round(i * step)]!);
}

/**
 * JPEG stills from the points where the picture changes, for Claude to read as images.
 *
 * Two passes, because one cannot do it. `select='gt(scene,N)'` alone has no way to cap its
 * output: a clip that cuts every few seconds yields hundreds of frames, and `-frames:v` would
 * cap by taking the first N — covering the opening minute of a ten-minute video and nothing
 * after. So the cuts are timed first, spread evenly, and only the chosen ones extracted.
 *
 * Detection decodes every frame, which is why it runs against a 320px-wide copy with no audio.
 * At full size a ten-minute clip does not finish inside the timeout.
 *
 * A clip with no detectable cut — a static screen recording, a talking head — returns nothing
 * from detection, so evenly spaced stills stand in. Returning an empty list there would mean
 * the silent screen recordings this feature is most useful for got no frames at all.
 */
export async function extractSceneFrames(
  inputPath: string,
  durationSeconds: number | null
): Promise<string[]> {
  let times: number[] = [];
  try {
    const detect = await run(
      [
        FFMPEG_BIN, "-hide_banner", "-nostdin",
        "-i", inputPath,
        "-an",
        "-vf",
        `scale=320:-2,fps=${DETECT_FPS},select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
        "-f", "null", "-",
      ],
      DETECT_TIMEOUT_MS
    );
    // showinfo writes one line per selected frame to stderr; the timestamp is what matters.
    times = [...detect.stderr.matchAll(/pts_time:([0-9.]+)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value >= 0);
  } catch {
    // No ffmpeg, or it died. The fallback below still covers it when the duration is known.
    times = [];
  }

  // A cut marks what changed, never what was on screen before it. A clip holding one view for
  // fifty seconds and then cutting once detects a single timestamp, so without this Claude
  // sees only the second view and none of the majority of the video. Half-way into the
  // opening scene, not its start, which is often black or a title card.
  if (times.length > 0) {
    const opening = times[0]! / 2;
    if (opening >= 1) times.unshift(opening);
  }

  if (times.length === 0 && durationSeconds !== null && durationSeconds > 0) {
    // Interior points only: the first frame of a video is often black or a title card.
    times = Array.from(
      { length: STATIC_FRAMES },
      (_, i) => (durationSeconds * (i + 1)) / (STATIC_FRAMES + 1)
    );
  }

  const chosen = spread(times, MAX_FRAMES);
  const paths: string[] = [];
  for (const [index, time] of chosen.entries()) {
    const framePath = `${inputPath}.frame-${index + 1}.jpg`;
    try {
      // -ss before -i seeks by index instead of decoding up to the point, which is what keeps
      // this cheap enough to run once per frame rather than in one pass over the whole file.
      const shot = await run(
        [
          FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-nostdin",
          "-ss", String(time),
          "-i", inputPath,
          "-frames:v", "1",
          "-vf", "scale='min(768,iw)':-2",
          "-q:v", "4",
          "-y", framePath,
        ],
        EXTRACT_TIMEOUT_MS
      );
      // Exit 0 does not mean a file was written: a seek past the end leaves ffmpeg reporting
      // success with no output, and listing that path would hand Claude something to fail on.
      if (shot.code === 0) {
        const written = await stat(framePath).catch(() => null);
        if (written?.isFile() && written.size > 0) paths.push(framePath);
      }
    } catch {
      // One unreadable frame is not worth losing the rest of the set over.
    }
  }
  return paths;
}

export async function transcribeMedia(inputPath: string): Promise<string> {
  const wavPath = `${inputPath}.wav`;

  // The cleanup covers the extraction too, not just the transcription: `-y` makes ffmpeg
  // open the output before it can fail, so a timeout or a mid-stream error leaves a partial
  // wav behind.
  try {
    // `volumedetect` measures the track while it is being converted, so silence costs no
    // extra pass. It reports at info level, so `-loglevel error` would discard the very line
    // being parsed — the phrase the no-audio check looks for is still present at info.
    const extract = await run(
      [
        FFMPEG_BIN, "-hide_banner", "-loglevel", "info",
        "-i", inputPath,
        "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        "-af", "volumedetect",
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

    // A track of pure silence is not empty output, so the guard below cannot catch it —
    // whisper hallucinates onto silence instead, reliably emitting "you". Caught here rather
    // than after the fact, which also skips a whisper run that had nothing to transcribe.
    // An unparseable level is not treated as silence: a missing measurement is not evidence.
    const peak = extract.stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
    if (peak && Number(peak[1]) <= SILENCE_MAX_VOLUME_DB) {
      throw new SilentAudioError("silent audio");
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
