export type Kind = "video" | "audio" | "image";
export type Quality = "small" | "balanced" | "high";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Preset {
  id: string;
  label: string;
  detail: string;
  kind: Kind;
  ext: string;
  accepts: Kind[];
  silent?: boolean;
}

export interface Options {
  quality: Quality;
  maxHeight: number;
  trimStart: number;
  trimEnd: number;
}

/** A file the user has staged but not yet converted. */
export interface MediaFile {
  path: string;
  name: string;
  kind: Kind;
  size: number;
}

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
  activeIndex: number;
}

export interface Settings {
  presetId: string;
  quality: Quality;
  maxHeight: number;
  outputMode: "source" | "custom";
  outputDir: string;
  openWhenDone: boolean;
  startWithWindows: boolean;
}

export interface FfmpegStatus {
  ok: boolean;
  path: string | null;
  error: string | null;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "current"
  | "error"
  | "unsupported";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  newVersion: string | null;
  percent: number;
  message: string | null;
  checkedAt: number | null;
}

export interface InstallRefusal {
  installed: false;
  reason: string;
}

export interface RomApi {
  queue: {
    get: () => Promise<QueueState>;
    add: (files: string[]) => Promise<QueueState>;
    start: () => Promise<QueueState>;
    cancel: (id: string) => Promise<QueueState>;
    cancelAll: () => Promise<QueueState>;
    remove: (id: string) => Promise<QueueState>;
    clearFinished: () => Promise<QueueState>;
    onState: (cb: (s: QueueState) => void) => () => void;
  };
  files: {
    pick: () => Promise<MediaFile[]>;
    describe: (paths: string[]) => Promise<MediaFile[]>;
    pickFolder: () => Promise<string | null>;
    reveal: (file: string) => Promise<void>;
    openFolder: (dir: string) => Promise<string>;
    pathFor: (file: File) => string;
  };
  presets: {
    list: () => Promise<Preset[]>;
    for: (kind: Kind) => Promise<Preset[]>;
  };
  settings: {
    get: () => Promise<Settings>;
    set: (patch: Partial<Settings>) => Promise<Settings>;
  };
  app: {
    version: () => Promise<string>;
    dataDir: () => Promise<string>;
    ffmpeg: () => Promise<FfmpegStatus>;
  };
  update: {
    get: () => Promise<UpdateState>;
    check: () => Promise<UpdateState>;
    install: (force: boolean) => Promise<InstallRefusal>;
    onState: (cb: (s: UpdateState) => void) => () => void;
  };
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (v: boolean) => void) => () => void;
  };
}

declare global {
  interface Window {
    rom: RomApi;
  }
}
