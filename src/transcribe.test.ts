import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const {
  runner,
  transcribeMedia,
  probeDuration,
  extractSceneFrames,
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
    // Real ffmpeg writes the file named after -y. The frame paths are stat-checked now, so a
    // fake that skipped this would make every frame test pass for the wrong reason.
    const out = cmd[cmd.indexOf("-y") + 1];
    if (r.code === 0 && cmd.includes("-y") && out?.endsWith(".jpg")) {
      writeFileSync(out, "jpeg-bytes");
    }
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

/** stderr as ffmpeg's showinfo writes it, one line per selected frame. */
const showinfo = (...times: number[]) =>
  times
    .map((t) => `[Parsed_showinfo_2 @ 0x0] n:0 pts:0 pts_time:${t} pos:0 fmt:yuv420p`)
    .join("\n");

// The detection pass must not decode at full size: a ten-minute clip does not finish inside
// the timeout that way. It also must not pull audio it has no use for.
test("scene detection runs on a downscaled copy with no audio", async () => {
  const calls = fakeSpawns({ code: 0, stderr: showinfo(1.5) });
  try {
    await extractSceneFrames(join(scratch, "video_1.mp4"), 60);
    expect(calls[0]![0]).toBe("ffmpeg");
    expect(calls[0]).toContain("-an");
    const filter = calls[0]![calls[0]!.indexOf("-vf") + 1]!;
    expect(filter).toContain("scale=320:-2");
    expect(filter).toContain("select='gt(scene,0.3)'");
    expect(filter).toContain("showinfo");
  } finally {
    restore();
  }
});

// One extraction per chosen cut, seeking to the detected timestamp.
test("a frame is extracted at each detected scene change", async () => {
  const calls = fakeSpawns({ code: 0, stderr: showinfo(2, 9, 21) });
  try {
    const frames = await extractSceneFrames(join(scratch, "video_2.mp4"), 60);
    // Four, not three: the opening scene is sampled ahead of the first cut at 2s.
    expect(frames).toEqual([
      join(scratch, "video_2.mp4.frame-1.jpg"),
      join(scratch, "video_2.mp4.frame-2.jpg"),
      join(scratch, "video_2.mp4.frame-3.jpg"),
      join(scratch, "video_2.mp4.frame-4.jpg"),
    ]);
    // Detection, then one run per frame.
    expect(calls).toHaveLength(5);
    // -ss ahead of -i seeks by index instead of decoding up to the point.
    expect(calls[1]!.indexOf("-ss")).toBeLessThan(calls[1]!.indexOf("-i"));
    const seeks = calls.slice(1).map((c) => Number(c[c.indexOf("-ss") + 1]));
    expect(seeks).toEqual([1, 2, 9, 21]);
  } finally {
    restore();
  }
});

// Detection reports where the picture changed, never what preceded the first change. A clip
// holding one view for most of its length and cutting once late would otherwise hand Claude
// a single frame of the tail and nothing of the majority of the video.
test("the scene before the first cut is sampled too", async () => {
  const calls = fakeSpawns({ code: 0, stderr: showinfo(50) });
  try {
    const frames = await extractSceneFrames(join(scratch, "video_7.mp4"), 60);
    expect(frames).toHaveLength(2);
    const seeks = calls.slice(1).map((c) => Number(c[c.indexOf("-ss") + 1]));
    expect(seeks).toEqual([25, 50]);
  } finally {
    restore();
  }
});

// Not when the first cut is already at the very start — half of it is a black frame or a
// title card, and a near-duplicate of the cut that follows it.
test("an immediate first cut gets no extra opening frame", async () => {
  const calls = fakeSpawns({ code: 0, stderr: showinfo(0.4, 12) });
  try {
    await extractSceneFrames(join(scratch, "video_8.mp4"), 60);
    const seeks = calls.slice(1).map((c) => Number(c[c.indexOf("-ss") + 1]));
    expect(seeks).toEqual([0.4, 12]);
  } finally {
    restore();
  }
});

// A cut-heavy clip must not send hundreds of images. Capping by taking the first N would
// cover the opening of a long video and nothing after, so the picks are spread across the
// whole set — first and last included.
test("a cut-heavy clip is capped and spread across the whole video", async () => {
  const times = Array.from({ length: 50 }, (_, i) => i + 1);
  const calls = fakeSpawns({ code: 0, stderr: showinfo(...times) });
  try {
    const frames = await extractSceneFrames(join(scratch, "video_3.mp4"), 60);
    expect(frames).toHaveLength(8);
    const seeks = calls.slice(1).map((c) => Number(c[c.indexOf("-ss") + 1]));
    expect(seeks[0]).toBe(1);
    expect(seeks.at(-1)).toBe(50);
    // Genuinely spread, not clustered at the start.
    expect(seeks.every((v, i) => i === 0 || v > seeks[i - 1]!)).toBe(true);
  } finally {
    restore();
  }
});

// The case this feature is most useful for: a static screen recording has no cut at all, so
// detection returns nothing. Returning no frames there would leave exactly those videos blind.
test("a clip with no detectable cut falls back to evenly spaced stills", async () => {
  const calls = fakeSpawns({ code: 0, stderr: "" });
  try {
    const frames = await extractSceneFrames(join(scratch, "video_4.mp4"), 40);
    expect(frames).toHaveLength(3);
    const seeks = calls.slice(1).map((c) => Number(c[c.indexOf("-ss") + 1]));
    // Interior points — the first frame of a video is often black or a title card.
    expect(seeks).toEqual([10, 20, 30]);
  } finally {
    restore();
  }
});

// Nothing detected and no duration to space stills across leaves nothing to do.
test("no cuts and no known duration yields no frames", async () => {
  const calls = fakeSpawns({ code: 0, stderr: "" });
  try {
    expect(await extractSceneFrames(join(scratch, "video_5.mp4"), null)).toEqual([]);
    expect(calls).toHaveLength(1);
  } finally {
    restore();
  }
});

// A frame ffmpeg could not write is dropped rather than reported as a path that is not there.
test("a frame that fails to extract is left out of the set", async () => {
  // First cut at 0.5s, so no opening frame is added and the set stays at two — this test is
  // about dropping a failed extraction, not about the opening sample.
  fakeSpawns(
    { code: 0, stderr: showinfo(0.5, 9) },
    { code: 0 },
    { code: 1, stderr: "Output file is empty" }
  );
  try {
    expect(await extractSceneFrames(join(scratch, "video_6.mp4"), 60)).toEqual([
      join(scratch, "video_6.mp4.frame-1.jpg"),
    ]);
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
