/**
 * Output formats, expressed as things people want rather than codec flags.
 *
 * Every preset has to answer three questions for a non-expert: what file do I
 * get, will it play where I need it, and how big is it. The detail strings are
 * part of the feature, not decoration.
 */

export type Kind = "video" | "audio" | "image";
export type Quality = "small" | "balanced" | "high";

export interface Options {
  quality: Quality;
  /** Cap the long edge; 0 leaves the source size alone. */
  maxHeight: number;
  /** Seconds. 0 and 0 means the whole file. */
  trimStart: number;
  trimEnd: number;
}

export const DEFAULT_OPTIONS: Options = {
  quality: "balanced",
  maxHeight: 0,
  trimStart: 0,
  trimEnd: 0,
};

export interface Preset {
  id: string;
  label: string;
  detail: string;
  /** What the output is. */
  kind: Kind;
  ext: string;
  /** Input kinds this preset makes sense for. */
  accepts: Kind[];
  /** True when the output carries no audio, so audio settings can be hidden. */
  silent?: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "mp4",
    label: "MP4",
    detail: "H.264 · plays on everything",
    kind: "video",
    ext: "mp4",
    accepts: ["video"],
  },
  {
    id: "mp4-hevc",
    label: "MP4 (smaller)",
    detail: "H.265 · about half the size, needs a recent device",
    kind: "video",
    ext: "mp4",
    accepts: ["video"],
  },
  {
    id: "webm",
    label: "WebM",
    detail: "VP9 · small, ideal for the web",
    kind: "video",
    ext: "webm",
    accepts: ["video"],
  },
  {
    id: "gif",
    label: "GIF",
    detail: "silent loop · keep it short, GIFs get big fast",
    kind: "video",
    ext: "gif",
    accepts: ["video"],
    silent: true,
  },
  {
    id: "mp3",
    label: "MP3",
    detail: "audio only · works anywhere",
    kind: "audio",
    ext: "mp3",
    accepts: ["video", "audio"],
  },
  {
    id: "m4a",
    label: "M4A",
    detail: "AAC · better than MP3 at the same size",
    kind: "audio",
    ext: "m4a",
    accepts: ["video", "audio"],
  },
  {
    id: "wav",
    label: "WAV",
    detail: "uncompressed · large, for editing",
    kind: "audio",
    ext: "wav",
    accepts: ["video", "audio"],
  },
  {
    id: "flac",
    label: "FLAC",
    detail: "lossless · smaller than WAV, no quality lost",
    kind: "audio",
    ext: "flac",
    accepts: ["video", "audio"],
  },
  {
    id: "jpg",
    label: "JPG",
    detail: "photos · small, no transparency",
    kind: "image",
    ext: "jpg",
    accepts: ["image", "video"],
  },
  {
    id: "png",
    label: "PNG",
    detail: "lossless · keeps transparency",
    kind: "image",
    ext: "png",
    accepts: ["image", "video"],
  },
  {
    id: "webp",
    label: "WebP",
    detail: "much smaller than JPG or PNG",
    kind: "image",
    ext: "webp",
    accepts: ["image", "video"],
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Presets worth offering for a given input, best-first. */
export function presetsFor(kind: Kind): Preset[] {
  return PRESETS.filter((p) => p.accepts.includes(kind));
}

const CRF: Record<string, Record<Quality, string>> = {
  "mp4": { small: "30", balanced: "23", high: "18" },
  "mp4-hevc": { small: "32", balanced: "27", high: "22" },
  "webm": { small: "38", balanced: "32", high: "27" },
};

const AUDIO_KBPS: Record<Quality, string> = { small: "96k", balanced: "160k", high: "256k" };
const MP3_VBR: Record<Quality, string> = { small: "6", balanced: "3", high: "0" };
const IMAGE_Q: Record<Quality, string> = { small: "10", balanced: "5", high: "2" };
const WEBP_Q: Record<Quality, string> = { small: "55", balanced: "80", high: "95" };
const GIF_FPS: Record<Quality, string> = { small: "10", balanced: "15", high: "20" };
const GIF_WIDTH: Record<Quality, string> = { small: "360", balanced: "480", high: "640" };

/**
 * Scale filter that never produces an odd dimension — H.264 and H.265 both
 * reject those — and never upscales a source that is already smaller.
 */
function scaleFilter(maxHeight: number): string | null {
  if (maxHeight <= 0) return null;
  return `scale=-2:'min(ih,${Math.round(maxHeight)})':flags=lanczos`;
}

export function buildArgs(
  input: string,
  output: string,
  preset: Preset,
  opts: Options,
  inputKind: Kind,
): string[] {
  const a: string[] = ["-hide_banner", "-nostdin", "-y"];

  // Seeking before -i is far faster and is accurate enough for whole-file trims.
  if (opts.trimStart > 0) a.push("-ss", String(opts.trimStart));
  a.push("-i", input);
  if (opts.trimEnd > opts.trimStart) a.push("-to", String(opts.trimEnd - opts.trimStart));

  const scale = scaleFilter(opts.maxHeight);
  const q = opts.quality;

  switch (preset.id) {
    case "mp4":
      if (scale) a.push("-vf", scale);
      a.push("-c:v", "libx264", "-crf", CRF.mp4[q], "-preset", "medium", "-pix_fmt", "yuv420p");
      a.push("-c:a", "aac", "-b:a", AUDIO_KBPS[q]);
      // Lets the file start playing before it has fully downloaded.
      a.push("-movflags", "+faststart");
      break;

    case "mp4-hevc":
      if (scale) a.push("-vf", scale);
      a.push("-c:v", "libx265", "-crf", CRF["mp4-hevc"][q], "-preset", "medium");
      // Without hvc1 the file plays in VLC but not in QuickTime or Photos.
      a.push("-tag:v", "hvc1", "-pix_fmt", "yuv420p");
      a.push("-c:a", "aac", "-b:a", AUDIO_KBPS[q]);
      a.push("-movflags", "+faststart");
      break;

    case "webm":
      if (scale) a.push("-vf", scale);
      a.push("-c:v", "libvpx-vp9", "-crf", CRF.webm[q], "-b:v", "0", "-row-mt", "1");
      a.push("-c:a", "libopus", "-b:a", AUDIO_KBPS[q]);
      break;

    case "gif": {
      // One pass would quantise to a fixed 256-colour table and band badly.
      // Generating a palette from the actual frames and applying it in the same
      // graph keeps quality without writing a temporary palette file.
      const w = scale ? `scale=-2:'min(ih,${Math.round(opts.maxHeight)})'` : `scale=${GIF_WIDTH[q]}:-2`;
      a.push(
        "-vf",
        `fps=${GIF_FPS[q]},${w}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
      );
      a.push("-loop", "0", "-an");
      break;
    }

    case "mp3":
      a.push("-vn", "-c:a", "libmp3lame", "-q:a", MP3_VBR[q]);
      break;

    case "m4a":
      a.push("-vn", "-c:a", "aac", "-b:a", AUDIO_KBPS[q]);
      break;

    case "wav":
      a.push("-vn", "-c:a", "pcm_s16le");
      break;

    case "flac":
      a.push("-vn", "-c:a", "flac");
      break;

    case "jpg":
      if (scale) a.push("-vf", scale);
      // From a video, take one frame rather than a folder full of stills.
      if (inputKind === "video") a.push("-frames:v", "1");
      a.push("-q:v", IMAGE_Q[q]);
      break;

    case "png":
      if (scale) a.push("-vf", scale);
      if (inputKind === "video") a.push("-frames:v", "1");
      break;

    case "webp":
      if (scale) a.push("-vf", scale);
      if (inputKind === "video") a.push("-frames:v", "1");
      a.push("-c:v", "libwebp", "-quality", WEBP_Q[q]);
      break;

    default:
      throw new Error(`Unknown preset "${preset.id}".`);
  }

  // Machine-readable progress on stdout keeps it out of the human-readable
  // stderr log, which is kept for diagnosing failures.
  a.push("-progress", "pipe:1", "-nostats");
  a.push(output);
  return a;
}
