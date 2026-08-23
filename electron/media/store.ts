import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_OPTIONS, type Options, type Quality } from "./presets";

export interface Settings {
  presetId: string;
  quality: Quality;
  maxHeight: number;
  /** "source" writes beside the original; "custom" uses outputDir. */
  outputMode: "source" | "custom";
  outputDir: string;
  openWhenDone: boolean;
  startWithWindows: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  presetId: "mp4",
  quality: DEFAULT_OPTIONS.quality,
  maxHeight: 0,
  outputMode: "source",
  outputDir: "",
  openWhenDone: false,
  startWithWindows: false,
};

const FILE = "settings.json";

export function dataDir(): string {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Notepad and PowerShell both write a UTF-8 BOM, which JSON.parse rejects. */
function readText(file: string): string | null {
  const p = path.join(dataDir(), file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8").replace(/^﻿/, "");
}

const QUALITIES: Quality[] = ["small", "balanced", "high"];

/** Clamps anything a hand-edited settings.json could put out of range. */
function sanitize(s: Settings): Settings {
  const height = Number(s.maxHeight);
  return {
    presetId: typeof s.presetId === "string" && s.presetId ? s.presetId : DEFAULT_SETTINGS.presetId,
    quality: QUALITIES.includes(s.quality) ? s.quality : DEFAULT_SETTINGS.quality,
    // 0 means "leave it alone"; anything else is a sane pixel height.
    maxHeight: Number.isFinite(height) && height > 0 ? Math.min(4320, Math.max(120, Math.round(height))) : 0,
    outputMode: s.outputMode === "custom" ? "custom" : "source",
    outputDir: typeof s.outputDir === "string" ? s.outputDir : "",
    openWhenDone: Boolean(s.openWhenDone),
    startWithWindows: Boolean(s.startWithWindows),
  };
}

export function loadSettings(): Settings {
  try {
    const raw = readText(FILE);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    return sanitize({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Settings) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): Settings {
  const clean = sanitize({ ...DEFAULT_SETTINGS, ...s });
  try {
    fs.writeFileSync(path.join(dataDir(), FILE), JSON.stringify(clean, null, 2));
  } catch (e) {
    throw new Error(
      `Could not save settings to ${app.getPath("userData")}: ${(e as Error).message}`,
    );
  }
  return clean;
}

/** The options the queue needs, derived from stored settings plus a trim. */
export function optionsFrom(s: Settings, trimStart = 0, trimEnd = 0): Options {
  return {
    quality: s.quality,
    maxHeight: s.maxHeight,
    trimStart: Math.max(0, trimStart),
    trimEnd: Math.max(0, trimEnd),
  };
}

/** Where a job should write, given the settings and the source file. */
export function resolveOutputDir(s: Settings, inputFile: string): string {
  if (s.outputMode === "custom" && s.outputDir.trim() !== "") return s.outputDir;
  return path.dirname(inputFile);
}
