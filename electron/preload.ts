import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(args[0] as T);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  queue: {
    get: () => ipcRenderer.invoke("queue:get"),
    add: (files: string[]) => ipcRenderer.invoke("queue:add", files),
    start: () => ipcRenderer.invoke("queue:start"),
    cancel: (id: string) => ipcRenderer.invoke("queue:cancel", id),
    cancelAll: () => ipcRenderer.invoke("queue:cancelAll"),
    remove: (id: string) => ipcRenderer.invoke("queue:remove", id),
    clearFinished: () => ipcRenderer.invoke("queue:clearFinished"),
    onState: (cb: (s: unknown) => void) => on("queue:state", cb),
  },
  files: {
    pick: () => ipcRenderer.invoke("files:pick"),
    describe: (paths: string[]) => ipcRenderer.invoke("files:describe", paths),
    pickFolder: () => ipcRenderer.invoke("files:pickFolder"),
    reveal: (file: string) => ipcRenderer.invoke("files:reveal", file),
    openFolder: (dir: string) => ipcRenderer.invoke("files:openFolder", dir),
    /**
     * Turns a dropped File into a real path.
     *
     * Electron removed the non-standard File.path property, so a drop handler
     * in the renderer can no longer read where the file came from. webUtils is
     * the supported replacement and has to run here in the preload, where the
     * File object still exists on this side of the context bridge.
     */
    pathFor: (file: File) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return "";
      }
    },
  },
  presets: {
    list: () => ipcRenderer.invoke("presets:list"),
    for: (kind: string) => ipcRenderer.invoke("presets:for", kind),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
  },
  app: {
    version: () => ipcRenderer.invoke("app:version"),
    dataDir: () => ipcRenderer.invoke("app:dataDir"),
    ffmpeg: () => ipcRenderer.invoke("app:ffmpeg"),
  },
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    check: () => ipcRenderer.invoke("update:check"),
    install: (force: boolean) => ipcRenderer.invoke("update:install", force),
    onState: (cb: (s: unknown) => void) => on("update:state", cb),
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximizeChange: (cb: (v: unknown) => void) => on("window:maximizeChange", cb),
  },
};

contextBridge.exposeInMainWorld("rom", api);

export type RomApi = typeof api;
