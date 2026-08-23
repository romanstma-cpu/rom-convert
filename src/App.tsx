import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FfmpegStatus,
  Job,
  Kind,
  MediaFile,
  Preset,
  QueueState,
  Quality,
  Settings,
  UpdateState,
} from "./types";
import Options from "./pages/Options";
import Queue from "./pages/Queue";
import Staged from "./pages/Staged";
import { Confirm, Segmented, ToastHost, useToast } from "./ui";
import appIcon from "../assets/icon-256.png";

const QUALITY_OPTIONS: { value: Quality; label: string }[] = [
  { value: "small", label: "Smaller file" },
  { value: "balanced", label: "Balanced" },
  { value: "high", label: "Best quality" },
];

function Shell() {
  const [staged, setStaged] = useState<MediaFile[]>([]);
  const [queue, setQueue] = useState<QueueState>({ jobs: [], running: false, activeIndex: -1 });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [version, setVersion] = useState("");
  const [maximized, setMaximized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const toast = useToast();

  // Drag events fire for every child element, so a plain boolean flickers.
  const dragDepth = useRef(0);

  useEffect(() => {
    void window.rom.queue.get().then(setQueue);
    void window.rom.settings.get().then(setSettings);
    void window.rom.presets.list().then(setPresets);
    void window.rom.app.ffmpeg().then(setFfmpeg);
    void window.rom.app.version().then(setVersion);
    void window.rom.update.get().then(setUpdate);
    void window.rom.window.isMaximized().then(setMaximized);

    const offQueue = window.rom.queue.onState(setQueue);
    const offMax = window.rom.window.onMaximizeChange(setMaximized);
    const offUpdate = window.rom.update.onState(setUpdate);
    return () => {
      offQueue();
      offMax();
      offUpdate();
    };
  }, []);

  const addFiles = useCallback(
    (files: MediaFile[], rejected = 0) => {
      if (files.length > 0) {
        setStaged((prev) => {
          const seen = new Set(prev.map((f) => f.path.toLowerCase()));
          return [...prev, ...files.filter((f) => !seen.has(f.path.toLowerCase()))];
        });
      }
      if (rejected > 0) {
        toast(
          "info",
          `${rejected} file${rejected === 1 ? "" : "s"} skipped — not a video, audio or image file.`,
        );
      } else if (files.length === 0) {
        toast("info", "Nothing there ROM Convert can read.");
      }
    },
    [toast],
  );

  async function pickFiles() {
    const files = await window.rom.files.pick();
    if (files.length > 0) addFiles(files);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);

    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length === 0) return;

    // Electron removed File.path, so the real path comes from the preload.
    const paths = dropped.map((f) => window.rom.files.pathFor(f)).filter((p) => p !== "");
    const described = await window.rom.files.describe(paths);
    addFiles(described, dropped.length - described.length);
  }

  function onDragEnter(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  async function patch(p: Partial<Settings>) {
    try {
      setSettings(await window.rom.settings.set(p));
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function convert() {
    if (!settings || staged.length === 0) return;
    try {
      await window.rom.queue.add(staged.map((f) => f.path));
      await window.rom.queue.start();
      setStaged([]);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function cancelAll() {
    setConfirmCancel(false);
    await window.rom.queue.cancelAll();
    toast("info", "Stopped. Partly-written files were deleted.");
  }

  // Only offer formats that make sense for what is actually staged; with an
  // empty tray, show everything so the choice can be made up front.
  const kinds = useMemo(() => new Set(staged.map((f) => f.kind)), [staged]);
  const available = useMemo(() => {
    if (presets.length === 0) return [];
    if (kinds.size === 0) return presets;
    return presets.filter((p) => [...kinds].every((k) => p.accepts.includes(k as Kind)));
  }, [presets, kinds]);

  const selected = settings ? available.find((p) => p.id === settings.presetId) ?? null : null;

  // A staged set that the chosen format cannot handle must not silently
  // convert to something unexpected.
  useEffect(() => {
    if (!settings || available.length === 0) return;
    if (!available.some((p) => p.id === settings.presetId)) {
      void patch({ presetId: available[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, settings?.presetId]);

  const pending = queue.jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const done = queue.jobs.filter((j) => j.status === "done").length;
  const busy = queue.running || pending > 0;

  if (!settings) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="titlebar">
        <div className="tb-drag">
          <img src={appIcon} alt="" />
          <span className="tb-name">ROM CONVERT</span>
          <span className="tb-ver">v{version || "1.0.0"}</span>
          <span className={`dot ${busy ? "on" : "off"}`} />
          <span className="tb-status">
            {busy ? `Converting ${pending} file${pending === 1 ? "" : "s"}` : "Ready"}
          </span>
          {update?.status === "ready" && (
            <button
              className="tb-update"
              onClick={async () => {
                const r = await window.rom.update.install(false);
                if (r && !r.installed) toast("info", r.reason);
              }}
            >
              Update to v{update.newVersion}
            </button>
          )}
        </div>
        <div className="tb-controls">
          <button onClick={() => window.rom.window.minimize()} aria-label="Minimize">
            ─
          </button>
          <button onClick={() => window.rom.window.maximize()} aria-label="Maximize">
            {maximized ? "❐" : "▢"}
          </button>
          <button className="x" onClick={() => window.rom.window.close()} aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      <div className="main">
        <div
          className="content"
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => void onDrop(e)}
        >
          {ffmpeg && !ffmpeg.ok && (
            <div className="notice bad">
              <div>
                <strong>The bundled converter is missing.</strong> {ffmpeg.error}
              </div>
            </div>
          )}

          <div className={`drop ${dragging ? "over" : ""} ${staged.length === 0 ? "tall" : ""}`}>
            <div className="drop-icon" aria-hidden="true">
              {/* Drawn rather than a glyph: the box-drawing characters that
                  suit this render as tofu in the shipped font. */}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M12 3v11" strokeLinecap="round" />
                <path d="M7.5 9.5 12 14l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3.5 15.5v2.2A2.3 2.3 0 0 0 5.8 20h12.4a2.3 2.3 0 0 0 2.3-2.3v-2.2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="drop-title">
              {dragging ? "Drop them here" : "Drag files in, or browse"}
            </div>
            <div className="drop-sub">Video, audio and images. As many at once as you like.</div>
            <button className="btn" onClick={() => void pickFiles()}>
              Choose files
            </button>
            <div className="drop-note">
              Everything runs on this PC. Nothing is uploaded, and there is no file size limit.
            </div>
          </div>

          {staged.length > 0 && (
            <Staged
              files={staged}
              onRemove={(p) => setStaged((xs) => xs.filter((f) => f.path !== p))}
              onClear={() => setStaged([])}
            />
          )}

          <div className="card">
            <div className="card-head">
              <div className="label">Convert to</div>
              <button className="linkish" onClick={() => setShowOptions(true)}>
                More options
              </button>
            </div>

            <div className="formats">
              {available.map((p) => (
                <button
                  key={p.id}
                  className={`fmt ${settings.presetId === p.id ? "on" : ""}`}
                  onClick={() => void patch({ presetId: p.id })}
                >
                  <span className="fmt-label">
                    {p.label}
                    <span className="fmt-ext">.{p.ext}</span>
                  </span>
                  <span className="fmt-detail">{p.detail}</span>
                </button>
              ))}
            </div>

            <div className="row-between" style={{ marginTop: 16 }}>
              <div className="stack">
                <span className="opt-title">Quality</span>
                <span className="opt-help">
                  {settings.quality === "small"
                    ? "Smallest file, some detail lost."
                    : settings.quality === "high"
                      ? "Closest to the original. Bigger file, slower."
                      : "A good default for almost everything."}
                </span>
              </div>
              <Segmented
                value={settings.quality}
                options={QUALITY_OPTIONS}
                onChange={(q) => void patch({ quality: q })}
              />
            </div>
          </div>

          {queue.jobs.length > 0 && (
            <Queue
              state={queue}
              onCancel={(id) => void window.rom.queue.cancel(id)}
              onRemove={(id) => void window.rom.queue.remove(id)}
              onReveal={(f) => void window.rom.files.reveal(f)}
              onClearFinished={() => void window.rom.queue.clearFinished()}
            />
          )}
        </div>

        <div className="actionbar">
          <button
            className="btn primary"
            onClick={() => void convert()}
            disabled={staged.length === 0 || !selected || (ffmpeg ? !ffmpeg.ok : false)}
          >
            {staged.length === 0
              ? "Convert"
              : `Convert ${staged.length} file${staged.length === 1 ? "" : "s"}${
                  selected ? ` to ${selected.label}` : ""
                }`}
          </button>

          {busy && (
            <button className="btn danger" onClick={() => setConfirmCancel(true)}>
              Stop
            </button>
          )}

          <span className="spacer" />

          <span className="summary">
            {busy
              ? `${pending} left${done > 0 ? ` · ${done} done` : ""}`
              : done > 0
                ? `${done} file${done === 1 ? "" : "s"} converted`
                : settings.outputMode === "custom" && settings.outputDir
                  ? `Saving to ${settings.outputDir}`
                  : "Saved next to the original file"}
          </span>
        </div>
      </div>

      {showOptions && (
        <Options
          settings={settings}
          onPatch={patch}
          onClose={() => setShowOptions(false)}
          version={version}
          ffmpeg={ffmpeg}
          update={update}
          onCheckUpdate={async () => {
            const s = await window.rom.update.check();
            setUpdate(s);
            if (s.message) toast("info", s.message);
          }}
        />
      )}

      <Confirm
        open={confirmCancel}
        title="Stop converting?"
        body={
          <>
            The file being written now is deleted, because a half-finished video is worse than none
            at all. Anything already converted is kept.
          </>
        }
        confirmLabel="Stop"
        danger
        onConfirm={() => void cancelAll()}
        onCancel={() => setConfirmCancel(false)}
      />
    </>
  );
}

export default function App() {
  return (
    <ToastHost>
      <Shell />
    </ToastHost>
  );
}

export type { Job };
