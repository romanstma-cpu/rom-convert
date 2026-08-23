import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ffmpegPath } from "./binary";
import { fileSize, kindOf, uniqueOutputPath, wouldOverwriteInput } from "./files";
import { type Kind, type Options, type Preset, buildArgs, findPreset } from "./presets";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  input: string;
  inputName: string;
  inputKind: Kind;
  inputSize: number;
  presetId: string;
  presetLabel: string;
  options: Options;
  outputDir: string;
  output: string | null;
  outputSize: number;
  status: JobStatus;
  /** 0..1. Stays at 0 for inputs with no duration until they finish. */
  progress: number;
  durationSec: number | null;
  speed: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface QueueState {
  jobs: Job[];
  running: boolean;
  /** Index into jobs of whatever is converting now, or -1. */
  activeIndex: number;
}

type Listener = (s: QueueState) => void;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `job-${Date.now().toString(36)}-${seq}`;
}

/** "00:01:23.45" -> 83.45 */
export function parseTimecode(tc: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(tc.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Pulls the source duration out of ffmpeg's own banner on stderr. */
export function parseDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  // N/A appears for images and some streams; parseTimecode rejects it anyway.
  return parseTimecode(m[1]);
}

/**
 * Reads the key=value block that `-progress pipe:1` writes.
 *
 * Returns microseconds of output written so far, which beats scraping the
 * human-readable stderr line: that one is localised, rewritten with carriage
 * returns, and changes shape between ffmpeg versions.
 */
export function parseProgress(chunk: string): { outUs: number | null; speed: string | null; ended: boolean } {
  let outUs: number | null = null;
  let speed: string | null = null;
  let ended = false;

  for (const line of chunk.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key === "out_time_us" || key === "out_time_ms") {
      // out_time_ms is misnamed upstream: it is microseconds too.
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) outUs = n;
    } else if (key === "speed" && value !== "N/A") {
      speed = value;
    } else if (key === "progress" && value === "end") {
      ended = true;
    }
  }
  return { outUs, speed, ended };
}

/** Turns ffmpeg's wall of text into one line a person can act on. */
export function explainFailure(stderr: string, code: number | null): string {
  const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-25).join("\n");

  if (/Unknown encoder/i.test(tail)) {
    const enc = /Unknown encoder '([^']+)'/i.exec(tail)?.[1] ?? "that encoder";
    return `This build of ffmpeg has no ${enc} encoder, so that format is unavailable.`;
  }
  if (/No such file or directory/i.test(tail)) {
    return "The input file could not be opened — it may have been moved or renamed.";
  }
  if (/Permission denied/i.test(tail)) {
    return "Windows refused access to that folder. Pick a different output folder.";
  }
  if (/Invalid data found when processing input/i.test(tail)) {
    return "That file is not media ffmpeg can read, or it is corrupt.";
  }
  if (/No space left on device/i.test(tail)) {
    return "The drive ran out of space.";
  }
  if (/moov atom not found/i.test(tail)) {
    return "The video is incomplete — its index is missing, which usually means a broken download.";
  }

  const last = tail.split("\n").pop() ?? "";
  return last.trim() !== "" ? last.trim() : `ffmpeg exited with code ${code ?? "unknown"}.`;
}

export class ConvertQueue {
  private jobs: Job[] = [];
  private listeners: Listener[] = [];
  private child: ChildProcess | null = null;
  private activeId: string | null = null;
  private draining = false;
  private stopping = false;

  subscribe(l: Listener): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  getState(): QueueState {
    return {
      jobs: this.jobs.map((j) => ({ ...j })),
      running: this.child !== null,
      activeIndex: this.jobs.findIndex((j) => j.id === this.activeId),
    };
  }

  private emit(): void {
    const s = this.getState();
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        // a dead renderer must never stall the queue
      }
    }
  }

  add(files: string[], presetId: string, options: Options, outputDir: string): Job[] {
    const preset = findPreset(presetId);
    if (!preset) throw new Error(`Unknown output format "${presetId}".`);

    const added: Job[] = [];
    for (const input of files) {
      const inputKind = kindOf(input);
      if (!inputKind) continue;
      const job: Job = {
        id: nextId(),
        input,
        inputName: path.basename(input),
        inputKind,
        inputSize: fileSize(input),
        presetId,
        presetLabel: preset.label,
        options: { ...options },
        outputDir: outputDir.trim() !== "" ? outputDir : path.dirname(input),
        output: null,
        outputSize: 0,
        status: "queued",
        progress: 0,
        durationSec: null,
        speed: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      };
      this.jobs.push(job);
      added.push(job);
    }
    this.emit();
    return added;
  }

  remove(id: string): void {
    if (id === this.activeId) {
      this.cancel(id);
      return;
    }
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.emit();
  }

  /** Drops finished rows but leaves anything still queued or running. */
  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.status === "queued" || j.status === "running");
    this.emit();
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;

    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      this.emit();
      return;
    }
    if (job.id === this.activeId && this.child) {
      job.status = "cancelled";
      this.child.kill();
    }
  }

  /** Stops after the current file rather than killing it mid-write. */
  stopAfterCurrent(): void {
    this.stopping = true;
    for (const j of this.jobs) {
      if (j.status === "queued") {
        j.status = "cancelled";
        j.finishedAt = Date.now();
      }
    }
    this.emit();
  }

  cancelAll(): void {
    this.stopping = true;
    for (const j of this.jobs) {
      if (j.status === "queued") {
        j.status = "cancelled";
        j.finishedAt = Date.now();
      }
    }
    if (this.activeId) this.cancel(this.activeId);
    this.emit();
  }

  /** Kicks the queue; safe to call repeatedly. */
  start(): void {
    this.stopping = false;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.stopping) break;
        const job = this.jobs.find((j) => j.status === "queued");
        if (!job) break;
        await this.run(job);
      }
    } finally {
      this.draining = false;
      this.activeId = null;
      this.child = null;
      this.emit();
    }
  }

  private run(job: Job): Promise<void> {
    return new Promise((resolve) => {
      const preset = findPreset(job.presetId);
      if (!preset) {
        this.fail(job, `Unknown output format "${job.presetId}".`);
        resolve();
        return;
      }

      let bin: string;
      try {
        bin = ffmpegPath();
      } catch (e) {
        this.fail(job, (e as Error).message);
        resolve();
        return;
      }

      try {
        fs.mkdirSync(job.outputDir, { recursive: true });
      } catch (e) {
        this.fail(job, `Could not create ${job.outputDir}: ${(e as Error).message}`);
        resolve();
        return;
      }

      const output = uniqueOutputPath(job.outputDir, job.inputName, preset.ext);
      if (wouldOverwriteInput(job.input, output)) {
        this.fail(job, "That would overwrite the original file. Choose another output folder.");
        resolve();
        return;
      }

      job.output = output;
      job.status = "running";
      job.startedAt = Date.now();
      job.progress = 0;
      this.activeId = job.id;
      this.emit();

      const args = buildArgs(job.input, output, preset, job.options, job.inputKind);
      const child = spawn(bin, args, { windowsHide: true });
      this.child = child;

      let stderr = "";
      let settled = false;

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        const { outUs, speed, ended } = parseProgress(chunk);
        let changed = false;

        if (speed && speed !== job.speed) {
          job.speed = speed;
          changed = true;
        }
        if (outUs !== null && job.durationSec && job.durationSec > 0) {
          const p = Math.min(0.999, outUs / 1_000_000 / job.durationSec);
          if (p > job.progress) {
            job.progress = p;
            changed = true;
          }
        }
        if (ended && job.progress < 0.999) {
          job.progress = 0.999;
          changed = true;
        }
        if (changed) this.emit();
      });

      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        // Bounded: a long run must not grow this without limit.
        stderr = (stderr + chunk).slice(-20_000);
        if (job.durationSec === null) {
          const d = parseDuration(stderr);
          if (d !== null) {
            // A trim shortens the work, so progress should track the clip.
            const trimmed =
              job.options.trimEnd > job.options.trimStart
                ? job.options.trimEnd - job.options.trimStart
                : d - job.options.trimStart;
            job.durationSec = Math.max(0.1, Math.min(d, trimmed));
            this.emit();
          }
        }
      });

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.child = null;
        this.activeId = null;
        fn();
        this.emit();
        resolve();
      };

      child.on("error", (e) => {
        finish(() => {
          job.status = "failed";
          job.error = `ffmpeg could not be started: ${e.message}`;
          job.finishedAt = Date.now();
        });
      });

      child.on("close", (code) => {
        finish(() => {
          job.finishedAt = Date.now();

          if (job.status === "cancelled") {
            // A killed encode leaves a truncated file that looks like a result.
            this.discard(output);
            job.output = null;
            return;
          }
          if (code === 0) {
            job.status = "done";
            job.progress = 1;
            job.outputSize = fileSize(output);
            if (job.outputSize === 0) {
              job.status = "failed";
              job.error = "ffmpeg reported success but produced an empty file.";
              this.discard(output);
              job.output = null;
            }
            return;
          }
          job.status = "failed";
          job.error = explainFailure(stderr, code);
          this.discard(output);
          job.output = null;
        });
      });
    });
  }

  private fail(job: Job, message: string): void {
    job.status = "failed";
    job.error = message;
    job.finishedAt = Date.now();
    this.emit();
  }

  private discard(file: string): void {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // leaving a stray partial file is better than throwing during cleanup
    }
  }
}
