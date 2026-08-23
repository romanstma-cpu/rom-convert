import * as fs from "node:fs";
import * as path from "node:path";
import type { Kind } from "./presets";

const VIDEO = [
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "mpg", "mpeg",
  "ts", "m2ts", "3gp", "ogv", "gif",
];
const AUDIO = ["mp3", "wav", "m4a", "flac", "ogg", "opus", "aac", "wma", "aiff", "aif", "mka"];
const IMAGE = ["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif"];

export const SUPPORTED = [...VIDEO, ...AUDIO, ...IMAGE];

/**
 * GIF is deliberately classed as video: an animated GIF converted to MP4 is one
 * of the most common reasons to reach for a converter, and the image presets
 * accept video input anyway, so nothing is lost for a static one.
 */
export function kindOf(file: string): Kind | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (VIDEO.includes(ext)) return "video";
  if (AUDIO.includes(ext)) return "audio";
  if (IMAGE.includes(ext)) return "image";
  return null;
}

export function isSupported(file: string): boolean {
  return kindOf(file) !== null;
}

/**
 * An output path that does not already exist.
 *
 * Converting a.mov to a.mp4 twice must not silently destroy the first result,
 * and a converter that overwrites without asking is a converter that eventually
 * eats something irreplaceable. Falls back to a timestamp in the pathological
 * case so this can never loop forever.
 */
export function uniqueOutputPath(dir: string, baseName: string, ext: string): string {
  const stem = baseName.replace(/\.[^.]+$/, "");
  let candidate = path.join(dir, `${stem}.${ext}`);
  if (!fs.existsSync(candidate)) return candidate;

  for (let n = 1; n < 1000; n++) {
    candidate = path.join(dir, `${stem} (${n}).${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem} ${Date.now()}.${ext}`);
}

/** Refuses to write the output over the input, which ffmpeg would truncate. */
export function wouldOverwriteInput(input: string, output: string): boolean {
  return path.resolve(input).toLowerCase() === path.resolve(output).toLowerCase();
}

export function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
