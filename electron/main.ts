import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import * as path from "node:path";
import { installCrashHandlers, reportFatal } from "./crashlog";
import { ffmpegStatus } from "./media/binary";
import { SUPPORTED, fileSize, isSupported, kindOf } from "./media/files";
import { PRESETS, presetsFor } from "./media/presets";
import { ConvertQueue } from "./media/queue";
import {
  type Settings,
  loadSettings,
  optionsFrom,
  resolveOutputDir,
  saveSettings,
  dataDir,
} from "./media/store";
import { checkForUpdates, getUpdateState, initUpdater, installUpdate } from "./updater";

installCrashHandlers();

let win: BrowserWindow | null = null;
const queue = new ConvertQueue();

/**
 * Send to the renderer, or quietly do nothing if it is already gone.
 * The window object outlives its webContents during shutdown, so a null check
 * alone lets a send throw "Object has been destroyed" on the way out.
 */
function sendToRenderer(channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

export interface MediaFile {
  path: string;
  name: string;
  kind: "video" | "audio" | "image";
  size: number;
}

/** Paths the app can actually convert, with the details the UI shows. */
function describe(paths: string[]): MediaFile[] {
  const seen = new Set<string>();
  const out: MediaFile[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || p.trim() === "") continue;
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) continue; // dropping the same file twice is a no-op
    seen.add(key);
    const kind = kindOf(p);
    if (!kind) continue;
    out.push({ path: p, name: path.basename(p), kind, size: fileSize(p) });
  }
  return out;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#0d0a14",
    title: "ROM Convert",
    icon: path.join(__dirname, "../assets/icon.ico"),
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  const relay = () => sendToRenderer("window:maximizeChange", win?.isMaximized() ?? false);
  win.on("maximize", relay);
  win.on("unmaximize", relay);

  const indexHtml = path.join(__dirname, "../dist/index.html");
  win.loadFile(indexHtml).catch((e) => {
    reportFatal(new Error(`Could not load the app UI from ${indexHtml}: ${(e as Error).message}`), "loadFile");
  });
}

function registerIpc(): void {
  ipcMain.handle("queue:get", () => queue.getState());
  ipcMain.handle("queue:add", (_e, files: string[]) => {
    const s = loadSettings();
    const usable = (files ?? []).filter(isSupported);
    if (usable.length === 0) return queue.getState();
    // Every file gets its own output folder decision, so "beside the original"
    // still works when a drop spans several folders.
    for (const f of usable) {
      queue.add([f], s.presetId, optionsFrom(s), resolveOutputDir(s, f));
    }
    return queue.getState();
  });
  ipcMain.handle("queue:start", () => {
    queue.start();
    return queue.getState();
  });
  ipcMain.handle("queue:cancel", (_e, id: string) => {
    queue.cancel(id);
    return queue.getState();
  });
  ipcMain.handle("queue:cancelAll", () => {
    queue.cancelAll();
    return queue.getState();
  });
  ipcMain.handle("queue:remove", (_e, id: string) => {
    queue.remove(id);
    return queue.getState();
  });
  ipcMain.handle("queue:clearFinished", () => {
    queue.clearFinished();
    return queue.getState();
  });

  ipcMain.handle("files:pick", async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: "Add files to convert",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Media", extensions: SUPPORTED },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return res.canceled ? [] : describe(res.filePaths);
  });

  // The renderer only ever learns a path; size and kind are read here so the
  // staged list can show something useful before anything is converted.
  ipcMain.handle("files:describe", (_e, paths: string[]) => describe(paths ?? []));

  ipcMain.handle("files:pickFolder", async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: "Choose where converted files go",
      properties: ["openDirectory", "createDirectory"],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle("files:reveal", (_e, file: string) => {
    // showItemInFolder takes an absolute path and opens Explorer on it; it is
    // the only shell call here that touches a user-supplied path, and it can
    // only ever open a folder, never execute anything.
    if (typeof file !== "string" || file.trim() === "") return;
    shell.showItemInFolder(path.resolve(file));
  });
  ipcMain.handle("files:openFolder", (_e, dir: string) => {
    if (typeof dir !== "string" || dir.trim() === "") return;
    return shell.openPath(path.resolve(dir));
  });

  ipcMain.handle("presets:list", () => PRESETS);
  ipcMain.handle("presets:for", (_e, kind: "video" | "audio" | "image") => presetsFor(kind));

  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    const next = saveSettings({ ...loadSettings(), ...patch });
    if (patch.startWithWindows !== undefined && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.startWithWindows });
    }
    return next;
  });

  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:dataDir", () => dataDir());
  ipcMain.handle("app:ffmpeg", () => ffmpegStatus());

  ipcMain.on("window:minimize", () => win?.minimize());
  ipcMain.on("window:maximize", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("window:close", () => win?.close());
  ipcMain.handle("window:isMaximized", () => win?.isMaximized() ?? false);

  ipcMain.handle("update:get", () => getUpdateState());
  ipcMain.handle("update:check", () => checkForUpdates());
  ipcMain.handle("update:install", (_e, force: boolean) => installUpdate(force));
}

// A second launch should focus the running window rather than start a rival
// queue writing to the same output folder.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app
    .whenReady()
    .then(() => {
      queue.subscribe((s) => sendToRenderer("queue:state", s));
      registerIpc();
      createWindow();

      // Restarting mid-convert would abandon a half-written file, so the
      // updater needs to know whether anything is in flight.
      initUpdater(
        () => win,
        () => {
          const s = queue.getState();
          return {
            busy: s.running,
            pending: s.jobs.filter((j) => j.status === "queued" || j.status === "running").length,
          };
        },
      );

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((e) => reportFatal(e, "startup"));
}

app.on("window-all-closed", () => {
  // Killing ffmpeg here is deliberate: a background encode with no window is
  // invisible work the user cannot stop.
  queue.cancelAll();
  if (process.platform !== "darwin") app.quit();
});
