import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const {
  runner,
  transcribeMedia,
  probeDuration,
  NoAudioTrackError,
  TranscriptionUnavailableError,
} = await import("./transcribe");

// Real files, because the unlink under test is real. Its own directory, not TEMP_DIR: the
// bot may be running against that one.
const scratch = mkdtempSync(join(tmpdir(), "transcribe-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

// The handler tests stub the subprocess and so pin only the parsing. This is the one that
// reads the command line, which is where the stream-selection bug lives: restricting the
// probe to `a:0` measures nothing on a silent video, and that clip is then refused when
// attached as a file while the same clip from the gallery is accepted as [no audio track].
test("probeDuration measures every stream, not just the audio", async () => {
  const calls = fakeSpawns({ code: 0, stdout: "12.5\n" });
  try {
    expect(await probeDuration("/tmp/telegram-bot/video_1.mp4")).toBe(12.5);
    expect(calls[0]![0]).toBe("ffprobe");
    expect(calls[0]).not.toContain("-select_streams");
    expect(calls[0]).toContain("format=duration");
    // The path is the last argument, so a name that looks like a flag cannot become one.
    expect(calls[0]!.at(-1)).toBe("/tmp/telegram-bot/video_1.mp4");
  } finally {
    restore();
  }
});

// Some containers carry no duration in the header. The stream query is the fallback, and the
// longest stream wins — a clip whose audio is shorter than its video must still be measured
// by the video, or an over-long file slips through on its audio length.
test("probeDuration falls back to the streams and takes the longest", async () => {
  const calls = fakeSpawns(
    { code: 0, stdout: "N/A\n" },
    { code: 0, stdout: "\n30.0\n605.0\n" }
  );
  try {
    expect(await probeDuration("/tmp/telegram-bot/video_2.mkv")).toBe(605);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("stream=duration");
  } finally {
    restore();
  }
});

// Trusting the header the moment it parses would take 12 over 601. Both forms are asked and
// the largest wins, so a header that disagrees with the packets cannot undercut the cap.
test("probeDuration prefers the streams when the header undercounts", async () => {
  const calls = fakeSpawns(
    { code: 0, stdout: "12.0\n" },
    { code: 0, stdout: "601.0\n" }
  );
  try {
    expect(await probeDuration("/tmp/telegram-bot/mismatched.mp4")).toBe(601);
    expect(calls).toHaveLength(2);
  } finally {
    restore();
  }
});

// Some muxers write a zero duration into the header of a file whose packets span minutes.
// Accepting that zero would return it as the answer, stop the fallback, and let a clip of any
// length past the cap — the one case where a wrong number is worse than no number.
test("probeDuration ignores a zeroed header duration", async () => {
  fakeSpawns({ code: 0, stdout: "0\n" }, { code: 0, stdout: "601.0\n" });
  try {
    expect(await probeDuration("/tmp/telegram-bot/zeroed.mp4")).toBe(601);
  } finally {
    restore();
  }
});

// `parseFloat` reads "12abc" as 12, so a garbled line would be taken as a measurement.
test("probeDuration does not read a number out of garbled output", async () => {
  fakeSpawns({ code: 0, stdout: "12abc\n" }, { code: 0, stdout: "garbage\n" });
  try {
    expect(await probeDuration("/tmp/telegram-bot/garbled.mp4")).toBeNull();
  } finally {
    restore();
  }
});

// Null is the refuse signal, so the cases that produce it are worth pinning: a non-zero exit
// on both forms, and output that parses to nothing.
test("probeDuration returns null when nothing can be measured", async () => {
  fakeSpawns({ code: 1, stderr: "Invalid data found" }, { code: 0, stdout: "N/A\n" });
  try {
    expect(await probeDuration("/tmp/telegram-bot/broken.bin")).toBeNull();
  } finally {
    restore();
  }
});

// A host without ffprobe throws ENOENT out of spawn. That must read as "cannot measure"
// rather than propagating, or a missing binary would surface as a crash mid-handler.
test("probeDuration returns null when ffprobe is not installed", async () => {
  (runner as any).spawn = () => {
    const error = new Error("spawn ffprobe ENOENT") as Error & { code?: string };
    error.code = "ENOENT";
    throw error;
  };
  try {
    expect(await probeDuration("/tmp/telegram-bot/voice_1.ogg")).toBeNull();
  } finally {
    restore();
  }
});

// A throw is one failed measurement, not a verdict. In practice both forms throw together —
// the only realistic cause is a missing binary — but returning early on the first would make
// the loop's failure modes disagree, and this pins which one is intended.
test("probeDuration still measures when only the first probe throws", async () => {
  let call = 0;
  (runner as any).spawn = () => {
    call += 1;
    if (call === 1) throw new Error("transient");
    return { stdout: "601.0\n", stderr: "", exited: Promise.resolve(0) };
  };
  try {
    expect(await probeDuration("/tmp/telegram-bot/video_3.mp4")).toBe(601);
  } finally {
    restore();
  }
});

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
  // The input ffmpeg reads, pinned by position: asserting the argv merely *contains* the
  // original leaves `-i wavPath` — reading the file it is about to write — passing.
  const i = calls[0]!.indexOf("-i");
  expect(calls[0]![i + 1]).toBe("/tmp/telegram-bot/voice_2.ogg");
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
      NoAudioTrackError
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
    await expect(transcribeMedia("/tmp/telegram-bot/voice_4.ogg")).rejects.toThrow(
      /no transcript/
    );
  } finally {
    restore();
  }
});

// stdout is deliberately non-empty. Left empty, deleting the exit-code check below still
// rejects — via the empty-transcript check, whose message interpolates this same stderr —
// so the test would pass with the check gone. Partial output plus a non-zero exit is the
// only shape that isolates it.
test("a non-zero whisper exit surfaces its stderr, even when it printed something", async () => {
  fakeSpawns(
    { code: 0 },
    { code: 1, stdout: "half a sen", stderr: "error: failed to process audio\n" }
  );
  try {
    await expect(transcribeMedia("/tmp/telegram-bot/voice_5.ogg")).rejects.toThrow(
      /failed to process audio/
    );
  } finally {
    restore();
  }
});

// A missing or corrupt model is a deployment problem, not a bad clip, and the user-facing
// message differs. Checked by stderr rather than by stat-ing the model: an existsSync guard
// at the top of the module makes every test above fail on a dev machine that has no model.
test("an unloadable model is unavailability, not a bad file", async () => {
  fakeSpawns(
    { code: 0 },
    { code: 3, stderr: "error: failed to initialize whisper context\n" }
  );
  try {
    await expect(
      transcribeMedia("/tmp/telegram-bot/voice_6.ogg")
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError);
  } finally {
    restore();
  }
});

test("the derived wav is removed once the transcript is in hand", async () => {
  const input = join(scratch, "ok.ogg");
  writeFileSync(`${input}.wav`, "pretend pcm");
  fakeSpawns({ code: 0 }, { code: 0, stdout: "hello" });
  try {
    await transcribeMedia(input);
  } finally {
    restore();
  }
  expect(existsSync(`${input}.wav`)).toBe(false);
});

// ffmpeg opens the output before it can fail, so a timeout or a mid-stream error leaves a
// partial wav — 19 MB of it for a 10-minute clip. The cleanup has to cover the extraction,
// not only the transcription.
test("a partial wav is removed when ffmpeg fails", async () => {
  const input = join(scratch, "bad.ogg");
  writeFileSync(`${input}.wav`, "half written");
  fakeSpawns({ code: 143, stderr: "Exiting normally, received signal 15.\n" });
  try {
    await expect(transcribeMedia(input)).rejects.toThrow(/ffmpeg failed/);
  } finally {
    restore();
  }
  expect(existsSync(`${input}.wav`)).toBe(false);
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
    await expect(
      transcribeMedia("/tmp/telegram-bot/voice_7.ogg")
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError);
  } finally {
    restore();
  }
});
