import { useState } from "react";
import type { FfmpegStatus, Settings, UpdateState } from "../types";
import { Field, Toggle } from "../ui";

const HEIGHTS = [
  { value: 0, label: "Leave as it is" },
  { value: 2160, label: "4K · 2160p" },
  { value: 1440, label: "1440p" },
  { value: 1080, label: "1080p" },
  { value: 720, label: "720p" },
  { value: 480, label: "480p" },
];

export default function Options({
  settings,
  onPatch,
  onClose,
  version,
  ffmpeg,
  update,
  onCheckUpdate,
}: {
  settings: Settings;
  onPatch: (p: Partial<Settings>) => void | Promise<void>;
  onClose: () => void;
  version: string;
  ffmpeg: FfmpegStatus | null;
  update: UpdateState | null;
  onCheckUpdate: () => void | Promise<void>;
}) {
  const [checking, setChecking] = useState(false);

  async function pickFolder() {
    const dir = await window.rom.files.pickFolder();
    if (dir) await onPatch({ outputDir: dir, outputMode: "custom" });
  }

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>Options</h2>

        <Field
          label="Resolution"
          help="Only ever shrinks. A clip smaller than the limit is left alone rather than blown up."
        >
          <select
            value={settings.maxHeight}
            onChange={(e) => void onPatch({ maxHeight: Number(e.target.value) })}
          >
            {HEIGHTS.map((h) => (
              <option key={h.value} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Where converted files go">
          <select
            value={settings.outputMode}
            onChange={(e) =>
              void onPatch({ outputMode: e.target.value === "custom" ? "custom" : "source" })
            }
          >
            <option value="source">Next to the original file</option>
            <option value="custom">A folder I choose</option>
          </select>
        </Field>

        {settings.outputMode === "custom" && (
          <div style={{ marginTop: -6, marginBottom: 14 }}>
            <div className="path">{settings.outputDir || "No folder chosen yet."}</div>
            <button className="btn tiny" style={{ marginTop: 8 }} onClick={() => void pickFolder()}>
              Choose folder…
            </button>
          </div>
        )}

        <Toggle
          label="Start with Windows"
          checked={settings.startWithWindows}
          onChange={(v) => void onPatch({ startWithWindows: v })}
        />

        <div className="notice" style={{ marginTop: 16, display: "block" }}>
          <div style={{ marginBottom: 8 }}>
            <strong>ROM Convert {version && `v${version}`}</strong>
          </div>
          <div className="field-help" style={{ marginBottom: 10 }}>
            {ffmpeg?.ok
              ? "Converting is done by a bundled copy of ffmpeg. Your files never leave this PC."
              : (ffmpeg?.error ?? "Checking the bundled converter…")}
          </div>
          <div className="field-help" style={{ marginBottom: 10 }}>
            {update?.status === "unsupported"
              ? "Updates are checked in the installed build."
              : (update?.message ?? "Updates are checked automatically.")}
          </div>
          <button
            className="btn tiny"
            disabled={checking || update?.status === "unsupported"}
            onClick={async () => {
              setChecking(true);
              try {
                await onCheckUpdate();
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
        </div>

        <div className="row-actions" style={{ marginTop: 18 }}>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
