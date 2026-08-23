import * as fs from "node:fs";

/**
 * Resolves the bundled ffmpeg executable.
 *
 * ffmpeg-static reports a path inside the app bundle. Once electron-builder
 * packs the app into app.asar that path is not a real file any more — an asar
 * archive can be read by Node's patched fs, but it cannot be executed, so
 * spawning it fails with ENOENT. The build config unpacks ffmpeg-static into
 * app.asar.unpacked, and the executable has to be addressed there instead.
 */

let cached: string | null = null;
let lastError: string | null = null;

function candidates(): string[] {
  const out: string[] = [];

  let reported: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("ffmpeg-static") as string | { default?: string };
    reported = typeof mod === "string" ? mod : (mod?.default ?? null);
  } catch (e) {
    lastError = `ffmpeg-static could not be loaded: ${(e as Error).message}`;
  }

  if (reported) {
    // The unpacked copy first: inside a packaged app it is the only runnable one.
    out.push(reported.replace(`app.asar${require("node:path").sep}`, `app.asar.unpacked${require("node:path").sep}`));
    out.push(reported.replace("app.asar", "app.asar.unpacked"));
    out.push(reported);
  }

  return [...new Set(out)];
}

export function ffmpegPath(): string {
  if (cached) return cached;

  for (const p of candidates()) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        cached = p;
        lastError = null;
        return p;
      }
    } catch {
      // unreadable candidate, try the next
    }
  }

  throw new Error(
    lastError ??
      "The bundled ffmpeg could not be found. Reinstalling ROM Convert should restore it.",
  );
}

/** Non-throwing probe for the UI, so a broken install shows a message not a crash. */
export function ffmpegStatus(): { ok: boolean; path: string | null; error: string | null } {
  try {
    return { ok: true, path: ffmpegPath(), error: null };
  } catch (e) {
    return { ok: false, path: null, error: (e as Error).message };
  }
}
