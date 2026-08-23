/**
 * End-to-end check: runs the real bundled ffmpeg and converts real files.
 *
 * The playtest asserts the arguments are right; this asserts they actually
 * produce a playable file, which is the only claim that matters to a user.
 *
 *   npm run ffcheck
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ffmpegPath } from "../electron/media/binary";
import { DEFAULT_OPTIONS, type Options } from "../electron/media/presets";
import { ConvertQueue, type Job } from "../electron/media/queue";

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

const SANDBOX = path.join(os.tmpdir(), `rom-convert-ff-${Date.now()}`);
const OPTS: Options = { ...DEFAULT_OPTIONS };

function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = "";
    c.stderr.setEncoding("utf-8");
    c.stderr.on("data", (d: string) => {
      stderr += d;
    });
    c.on("close", (code) => resolve({ code, stderr }));
  });
}

/** Reads a file's resolution back out of ffmpeg's banner. */
async function resolutionOf(file: string): Promise<string | null> {
  const { stderr } = await run(["-hide_banner", "-i", file]);
  return /,\s(\d{2,5}x\d{2,5})[\s,]/.exec(stderr)?.[1] ?? null;
}

/** Runs one queue to completion and hands back the finished jobs. */
function convert(q: ConvertQueue): Promise<Job[]> {
  return new Promise((resolve) => {
    const off = q.subscribe((s) => {
      const settled = s.jobs.every(
        (j) => j.status === "done" || j.status === "failed" || j.status === "cancelled",
      );
      if (settled && !s.running) {
        off();
        resolve(s.jobs);
      }
    });
    q.start();
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(SANDBOX, { recursive: true });
  console.log(`\n== real ffmpeg ==`);
  console.log(`  binary:  ${ffmpegPath()}`);
  console.log(`  sandbox: ${SANDBOX}`);

  // --- a real source file to work from
  const src = path.join(SANDBOX, "source.mp4");
  const made = await run([
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=640x480:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    src,
  ]);
  check("a test video can be generated", made.code === 0 && fs.existsSync(src));
  if (!fs.existsSync(src)) {
    console.log("cannot continue without a source file");
    process.exit(1);
  }

  // --- every video-capable preset actually produces a file
  for (const preset of ["mp4", "webm", "gif", "mp3", "m4a", "wav", "flac", "png", "jpg", "webp"]) {
    const q = new ConvertQueue();
    q.add([src], preset, OPTS, SANDBOX);
    const [job] = await convert(q);

    const ok = job.status === "done" && job.output !== null && fs.existsSync(job.output);
    check(
      `${preset}: produces a real file`,
      ok,
      job.status === "failed" ? (job.error ?? "") : job.status,
    );
    if (ok) {
      check(`${preset}: the file is not empty`, job.outputSize > 0, `${job.outputSize} bytes`);
      check(`${preset}: progress finished at 100%`, job.progress === 1, String(job.progress));
    }
  }

  // --- resolution capping
  {
    const q = new ConvertQueue();
    q.add([src], "mp4", { ...OPTS, maxHeight: 240 }, SANDBOX);
    const [job] = await convert(q);
    const res = job.output ? await resolutionOf(job.output) : null;
    check("a height cap is actually applied", res === "320x240", res ?? "no resolution read");
  }
  {
    // 4000 is far above the 480-tall source: it must not be upscaled.
    const q = new ConvertQueue();
    q.add([src], "mp4", { ...OPTS, maxHeight: 4000 }, SANDBOX);
    const [job] = await convert(q);
    const res = job.output ? await resolutionOf(job.output) : null;
    check("a small source is never upscaled", res === "640x480", res ?? "no resolution read");
  }

  // --- trimming
  {
    const q = new ConvertQueue();
    q.add([src], "mp3", { ...OPTS, trimStart: 1, trimEnd: 2 }, SANDBOX);
    const [job] = await convert(q);
    const { stderr } = await run(["-hide_banner", "-i", job.output!]);
    const dur = /Duration:\s*00:00:0(\d)/.exec(stderr)?.[1];
    check("a one-second trim yields about one second", dur === "1", `got ${dur ?? "?"}s`);
  }

  // --- collisions never destroy an earlier result
  {
    const q = new ConvertQueue();
    q.add([src], "m4a", OPTS, SANDBOX);
    q.add([src], "m4a", OPTS, SANDBOX);
    const jobs = await convert(q);
    const names = jobs.map((j) => (j.output ? path.basename(j.output) : "")).sort();
    check(
      "converting the same file twice keeps both",
      names.length === 2 && names[0] !== names[1],
      names.join(", "),
    );
    check("both outputs exist on disk", jobs.every((j) => j.output && fs.existsSync(j.output)));
  }

  // --- a file ffmpeg cannot read fails cleanly
  {
    const junk = path.join(SANDBOX, "broken.mp4");
    fs.writeFileSync(junk, "this is definitely not a video");
    const q = new ConvertQueue();
    q.add([junk], "mp4", OPTS, SANDBOX);
    const [job] = await convert(q);
    check("an unreadable file fails rather than hanging", job.status === "failed");
    check("the failure is explained in plain words", (job.error ?? "").length > 0, job.error ?? "");
    check("no stray output is left behind", job.output === null);
  }

  // --- cancelling deletes the half-written file
  {
    const long = path.join(SANDBOX, "long.mp4");
    await run([
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=25:size=1280x720:rate=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", long,
    ]);

    const q = new ConvertQueue();
    q.add([long], "webm", { ...OPTS, quality: "high" }, SANDBOX);

    const finished = convert(q);
    // Let it get far enough to have written something, then pull the plug.
    await new Promise((r) => setTimeout(r, 2500));
    const running = q.getState().jobs[0];
    const partial = running.output;
    check("the job was actually running when cancelled", running.status === "running", running.status);
    q.cancel(running.id);

    const [job] = await finished;
    check("cancelling marks the job cancelled", job.status === "cancelled", job.status);
    check(
      "the partly-written file is deleted",
      partial !== null && !fs.existsSync(partial),
      partial ?? "no path",
    );
    check("a cancelled job reports no output", job.output === null);
  }

  fs.rmSync(SANDBOX, { recursive: true, force: true });

  console.log(`\n${"=".repeat(52)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
