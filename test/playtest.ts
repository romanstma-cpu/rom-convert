/**
 * Playtest: exercises argument building, output naming, progress parsing and
 * the settings store without launching ffmpeg or opening a window. Anything
 * that needs a real encode lives in ffmpeg-check.ts instead.
 *
 *   npm run playtest
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PRESETS, buildArgs, findPreset, presetsFor } from "../electron/media/presets";
import { kindOf, isSupported, uniqueOutputPath, wouldOverwriteInput } from "../electron/media/files";
import {
  ConvertQueue,
  explainFailure,
  parseDuration,
  parseProgress,
  parseTimecode,
} from "../electron/media/queue";
import {
  DEFAULT_SETTINGS,
  dataDir,
  loadSettings,
  optionsFrom,
  resolveOutputDir,
  saveSettings,
} from "../electron/media/store";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

const SANDBOX = path.join(os.tmpdir(), "rom-convert-test");
function reset(): void {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* first run */
  }
  fs.mkdirSync(SANDBOX, { recursive: true });
}

const OPTS = optionsFrom(DEFAULT_SETTINGS);

// ---------------------------------------------------------------- file kinds

section("file kinds");
check("mp4 is video", kindOf("C:\\clips\\a.mp4") === "video");
check("MOV is matched case-insensitively", kindOf("a.MOV") === "video");
check("mp3 is audio", kindOf("song.mp3") === "audio");
check("png is image", kindOf("shot.png") === "image");
check(
  "gif counts as video so it can become an mp4",
  kindOf("loop.gif") === "video",
  String(kindOf("loop.gif")),
);
check("an unknown extension is rejected", kindOf("notes.txt") === null);
check("a file with no extension is rejected", kindOf("README") === null);
check("isSupported agrees", isSupported("a.mkv") && !isSupported("a.exe"));

// ---------------------------------------------------------------- output paths

section("output naming");
reset();
const first = uniqueOutputPath(SANDBOX, "holiday.mov", "mp4");
check("first output keeps the original stem", path.basename(first) === "holiday.mp4");

fs.writeFileSync(first, "x");
const second = uniqueOutputPath(SANDBOX, "holiday.mov", "mp4");
check("an existing file is never overwritten", path.basename(second) === "holiday (1).mp4");

fs.writeFileSync(second, "x");
const third = uniqueOutputPath(SANDBOX, "holiday.mov", "mp4");
check("the counter keeps climbing", path.basename(third) === "holiday (2).mp4");

check(
  "a name with dots only loses the real extension",
  path.basename(uniqueOutputPath(SANDBOX, "my.holiday.v2.mov", "mp4")) === "my.holiday.v2.mp4",
);
check(
  "writing over the input is caught",
  wouldOverwriteInput("C:\\a\\b.mp4", "C:\\a\\b.mp4") &&
    wouldOverwriteInput("C:\\a\\B.MP4", "C:\\a\\b.mp4"),
);
check(
  "a different file is not a collision",
  !wouldOverwriteInput("C:\\a\\b.mov", "C:\\a\\b.mp4"),
);

// ---------------------------------------------------------------- presets

section("presets");
check("every preset has a unique id", new Set(PRESETS.map((p) => p.id)).size === PRESETS.length);
check("every preset explains itself", PRESETS.every((p) => p.detail.trim().length > 0));
check("every preset accepts at least one kind", PRESETS.every((p) => p.accepts.length > 0));
check("unknown preset is not found", findPreset("nope") === undefined);

check("a video offers mp4", presetsFor("video").some((p) => p.id === "mp4"));
check("audio never offers a video format", !presetsFor("audio").some((p) => p.kind === "video"));
check("audio offers mp3", presetsFor("audio").some((p) => p.id === "mp3"));
check("an image offers webp", presetsFor("image").some((p) => p.id === "webp"));
check("an image is not offered mp3", !presetsFor("image").some((p) => p.id === "mp3"));

// ---------------------------------------------------------------- arguments

section("ffmpeg arguments");

function argsFor(id: string, opts = OPTS, kind: "video" | "audio" | "image" = "video"): string[] {
  const p = findPreset(id)!;
  return buildArgs("in.mov", "out." + p.ext, p, opts, kind);
}

const mp4 = argsFor("mp4");
check("input is passed with -i", mp4.includes("-i") && mp4[mp4.indexOf("-i") + 1] === "in.mov");
check("output is the final argument", mp4[mp4.length - 1] === "out.mp4");
check("stdin is disabled so ffmpeg cannot hang", mp4.includes("-nostdin"));
check("progress is machine-readable", mp4.includes("-progress") && mp4.includes("-nostats"));
check("mp4 uses h264", mp4.includes("libx264"));
check("mp4 is streamable", mp4.includes("+faststart"));
check("mp4 uses a widely-playable pixel format", mp4.includes("yuv420p"));

check("hevc is tagged hvc1 so Apple devices play it", argsFor("mp4-hevc").includes("hvc1"));
check("webm uses vp9", argsFor("webm").includes("libvpx-vp9"));
check("webm sets b:v 0 so crf actually applies", (() => {
  const a = argsFor("webm");
  return a[a.indexOf("-b:v") + 1] === "0";
})());

const gif = argsFor("gif");
check("gif builds its own palette", gif.some((a) => a.includes("palettegen")));
check("gif applies that palette", gif.some((a) => a.includes("paletteuse")));
check("gif loops forever", gif[gif.indexOf("-loop") + 1] === "0");
check("gif drops audio", gif.includes("-an"));

check("mp3 strips video", argsFor("mp3").includes("-vn"));
check("mp3 uses lame", argsFor("mp3").includes("libmp3lame"));
check("wav is uncompressed pcm", argsFor("wav").includes("pcm_s16le"));
check("flac is flac", argsFor("flac").includes("flac"));

check(
  "a still from a video is one frame, not thousands",
  argsFor("jpg", OPTS, "video").includes("-frames:v"),
);
check(
  "an image input needs no frame limit",
  !argsFor("jpg", OPTS, "image").includes("-frames:v"),
);
check("webp uses the webp encoder", argsFor("webp", OPTS, "image").includes("libwebp"));

section("quality and scaling");
const small = argsFor("mp4", { ...OPTS, quality: "small" });
const high = argsFor("mp4", { ...OPTS, quality: "high" });
check("a smaller file means a higher crf", (() => {
  const s = Number(small[small.indexOf("-crf") + 1]);
  const h = Number(high[high.indexOf("-crf") + 1]);
  return s > h;
})());

check("no scale filter when the size is left alone", !argsFor("mp4").includes("-vf"));
const scaled = argsFor("mp4", { ...OPTS, maxHeight: 720 });
const vf = scaled[scaled.indexOf("-vf") + 1];
check("a height cap adds a scale filter", vf !== undefined && vf.includes("scale="));
check("scaling never upsizes a smaller source", vf.includes("min(ih,720)"));
check("scaling keeps dimensions even for h264", vf.includes("-2:"));

section("trimming");
const trimmed = argsFor("mp4", { ...OPTS, trimStart: 5, trimEnd: 12 });
check("start seek comes before -i so it is fast", trimmed.indexOf("-ss") < trimmed.indexOf("-i"));
check("the trim start is passed", trimmed[trimmed.indexOf("-ss") + 1] === "5");
check("the trim length is relative to the seek", trimmed[trimmed.indexOf("-to") + 1] === "7");
check("no -to when no end is set", !argsFor("mp4", { ...OPTS, trimStart: 3 }).includes("-to"));

// ---------------------------------------------------------------- progress

section("progress parsing");
check("timecode parses", parseTimecode("00:01:23.45") === 83.45);
check("hours are counted", parseTimecode("01:00:00.00") === 3600);
check("junk is rejected", parseTimecode("N/A") === null);

check(
  "duration comes out of the ffmpeg banner",
  parseDuration("  Duration: 00:00:30.05, start: 0.000000, bitrate: 1105 kb/s") === 30.05,
);
check("a banner without a duration yields null", parseDuration("Stream #0:0: Video") === null);
check("N/A duration yields null", parseDuration("  Duration: N/A, start: 0") === null);

const prog = parseProgress("frame=120\nout_time_us=4000000\nspeed=2.5x\nprogress=continue\n");
check("progress reads out_time_us", prog.outUs === 4_000_000);
check("progress reads speed", prog.speed === "2.5x");
check("continue is not an end", prog.ended === false);
check("end is detected", parseProgress("progress=end\n").ended === true);
check("speed of N/A is ignored", parseProgress("speed=N/A\n").speed === null);
check("a partial chunk does not crash", parseProgress("out_tim").outUs === null);
check(
  "out_time_ms is also microseconds",
  parseProgress("out_time_ms=2000000\n").outUs === 2_000_000,
);

// ---------------------------------------------------------------- failures

section("failure messages");
check(
  "a missing encoder is explained",
  explainFailure("Unknown encoder 'libx265'", 1).includes("libx265"),
);
check(
  "a missing file is explained in plain words",
  explainFailure("in.mov: No such file or directory", 1).includes("moved or renamed"),
);
check(
  "a permissions problem points at the output folder",
  explainFailure("Permission denied", 1).includes("output folder"),
);
check(
  "a corrupt file is explained",
  explainFailure("Invalid data found when processing input", 1).includes("corrupt"),
);
check("a full disk is explained", explainFailure("No space left on device", 1).includes("space"));
check(
  "an unrecognised error still says something",
  explainFailure("something odd happened", 7).length > 0,
);
check("no stderr at all still names the exit code", explainFailure("", 3).includes("3"));

// ---------------------------------------------------------------- queue

section("queue");
reset();
const q = new ConvertQueue();

let events = 0;
const off = q.subscribe(() => {
  events++;
});

const a = path.join(SANDBOX, "a.mp4");
const b = path.join(SANDBOX, "b.mov");
const junk = path.join(SANDBOX, "notes.txt");
for (const f of [a, b, junk]) fs.writeFileSync(f, "x");

q.add([a, b, junk], "mp3", OPTS, SANDBOX);
check("only media files are queued", q.getState().jobs.length === 2, `${q.getState().jobs.length}`);
check("subscribers are notified", events > 0);
check("jobs start queued", q.getState().jobs.every((j) => j.status === "queued"));
check("the chosen preset is recorded", q.getState().jobs[0].presetId === "mp3");
check("the preset label is carried for the UI", q.getState().jobs[0].presetLabel === "MP3");
check("input size is recorded", q.getState().jobs[0].inputSize === 1);

const firstId = q.getState().jobs[0].id;
q.cancel(firstId);
check("a queued job can be cancelled", q.getState().jobs[0].status === "cancelled");

q.remove(q.getState().jobs[1].id);
check("removing drops the row", q.getState().jobs.length === 1);

q.clearFinished();
check("clearing removes finished rows", q.getState().jobs.length === 0);

q.add([a], "mp3", OPTS, SANDBOX);
q.cancelAll();
check("cancelAll clears the backlog", q.getState().jobs.every((j) => j.status === "cancelled"));

let threw = false;
try {
  q.add([a], "not-a-format", OPTS, SANDBOX);
} catch {
  threw = true;
}
check("an unknown format is rejected", threw);

off();
const before = events;
q.add([a], "mp3", OPTS, SANDBOX);
check("unsubscribing stops notifications", events === before);

// A listener that throws must not stall the queue for everyone else.
const q2 = new ConvertQueue();
let reached = false;
q2.subscribe(() => {
  throw new Error("renderer is gone");
});
q2.subscribe(() => {
  reached = true;
});
q2.add([a], "mp3", OPTS, SANDBOX);
check("a throwing listener does not block the next one", reached);

// ---------------------------------------------------------------- settings

section("settings");
reset();
check("fresh install returns defaults", loadSettings().presetId === DEFAULT_SETTINGS.presetId);

saveSettings({ ...DEFAULT_SETTINGS, presetId: "webm", quality: "high" });
check("settings round-trip", loadSettings().presetId === "webm" && loadSettings().quality === "high");

saveSettings({ ...DEFAULT_SETTINGS, maxHeight: 99999 });
check("an absurd height is clamped", loadSettings().maxHeight === 4320, `${loadSettings().maxHeight}`);
saveSettings({ ...DEFAULT_SETTINGS, maxHeight: -20 });
check("a negative height means 'leave it alone'", loadSettings().maxHeight === 0);
saveSettings({ ...DEFAULT_SETTINGS, quality: "nonsense" as never });
check("an invalid quality falls back", loadSettings().quality === DEFAULT_SETTINGS.quality);

fs.writeFileSync(path.join(dataDir(), "settings.json"), "{ not json", "utf-8");
check("a corrupt settings file falls back to defaults", loadSettings().presetId === DEFAULT_SETTINGS.presetId);

fs.writeFileSync(
  path.join(dataDir(), "settings.json"),
  "\ufeff" + JSON.stringify({ presetId: "gif" }),
  "utf-8",
);
check("a UTF-8 BOM does not wipe settings", loadSettings().presetId === "gif");

section("output folder");
check(
  "source mode writes beside the original",
  resolveOutputDir({ ...DEFAULT_SETTINGS, outputMode: "source" }, "C:\\clips\\a.mov") ===
    "C:\\clips",
);
check(
  "custom mode uses the chosen folder",
  resolveOutputDir(
    { ...DEFAULT_SETTINGS, outputMode: "custom", outputDir: "D:\\out" },
    "C:\\clips\\a.mov",
  ) === "D:\\out",
);
check(
  "custom mode with no folder falls back to the source",
  resolveOutputDir({ ...DEFAULT_SETTINGS, outputMode: "custom", outputDir: "" }, "C:\\clips\\a.mov") ===
    "C:\\clips",
);

// ---------------------------------------------------------------- result

console.log(`\n${"=".repeat(52)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
