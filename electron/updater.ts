import { BrowserWindow, app } from "electron";
import { autoUpdater } from "electron-updater";

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

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8_000;

let state: UpdateState = {
  status: "idle",
  currentVersion: "0.0.0",
  newVersion: null,
  percent: 0,
  message: null,
  checkedAt: null,
};

let getWindow: () => BrowserWindow | null = () => null;
/** Set by main so the updater can refuse to restart mid-conversion. */
let queueBusy: () => { busy: boolean; pending: number } = () => ({ busy: false, pending: 0 });

function publish(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  // The window reference outlives its webContents during shutdown, so a check
  // that resolves then would otherwise throw "Object has been destroyed".
  const w = getWindow();
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
  w.webContents.send("update:state", state);
}

export function getUpdateState(): UpdateState {
  return state;
}

export function initUpdater(
  window: () => BrowserWindow | null,
  busy: () => { busy: boolean; pending: number },
): void {
  getWindow = window;
  queueBusy = busy;
  state.currentVersion = app.getVersion();

  // electron-updater cannot resolve a feed from an unpackaged tree, and
  // throwing there would just noise up development.
  if (!app.isPackaged) {
    state.status = "unsupported";
    state.message = "Updates are only checked in an installed build.";
    return;
  }

  autoUpdater.autoDownload = true;
  // A conversion may be in flight; installing is an explicit action, guarded below.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => publish({ status: "checking", message: null }));

  autoUpdater.on("update-not-available", () =>
    publish({
      status: "current",
      newVersion: null,
      percent: 0,
      message: "You're on the latest version.",
      checkedAt: Date.now(),
    }),
  );

  autoUpdater.on("update-available", (info) =>
    publish({
      status: "available",
      newVersion: info.version,
      percent: 0,
      message: `Version ${info.version} is available. Downloading…`,
      checkedAt: Date.now(),
    }),
  );

  autoUpdater.on("download-progress", (p) =>
    publish({ status: "downloading", percent: Math.round(p.percent) }),
  );

  autoUpdater.on("update-downloaded", (info) =>
    publish({
      status: "ready",
      newVersion: info.version,
      percent: 100,
      message: `Version ${info.version} is ready to install.`,
    }),
  );

  autoUpdater.on("error", (err) =>
    publish({
      status: "error",
      message: `Update check failed: ${err?.message ?? String(err)}`,
      checkedAt: Date.now(),
    }),
  );

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return state;
  if (state.status === "downloading" || state.status === "ready") return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    publish({ status: "error", message: (e as Error).message, checkedAt: Date.now() });
  }
  return state;
}

export interface InstallRefusal {
  installed: false;
  reason: string;
}

/**
 * Installing restarts the app, which would kill ffmpeg mid-write and leave a
 * truncated file. The caller is told why rather than losing work; `force` is
 * the user answering that prompt.
 */
export function installUpdate(force = false): InstallRefusal | never {
  if (state.status !== "ready") {
    return { installed: false, reason: "No downloaded update is waiting to be installed." };
  }

  const { busy, pending } = queueBusy();
  if (!force && (busy || pending > 0)) {
    return {
      installed: false,
      reason:
        `Installing restarts ROM Convert, and ${pending} file${pending === 1 ? " is" : "s are"} ` +
        `still in the queue. Let it finish, or clear the queue first.`,
    };
  }

  autoUpdater.quitAndInstall(true, true);
  throw new Error("unreachable: quitAndInstall does not return");
}
