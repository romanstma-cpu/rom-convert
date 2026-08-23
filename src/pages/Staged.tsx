import type { MediaFile } from "../types";
import { KIND_ICON, bytes } from "../ui";

export default function Staged({
  files,
  onRemove,
  onClear,
}: {
  files: MediaFile[];
  onRemove: (path: string) => void;
  onClear: () => void;
}) {
  const total = files.reduce((s, f) => s + f.size, 0);

  return (
    <div className="card">
      <div className="card-head">
        <div className="label">
          Ready to convert · {files.length} file{files.length === 1 ? "" : "s"}
        </div>
        <button className="linkish" onClick={onClear}>
          Remove all
        </button>
      </div>

      <div className="jobs">
        {files.map((f) => (
          <div className="job" key={f.path}>
            <div className="job-icon" aria-hidden="true">
              {KIND_ICON[f.kind] ?? "▣"}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="job-name" title={f.path}>
                {f.name}
              </div>
              <div className="job-meta">
                {f.kind} · {bytes(f.size)}
              </div>
            </div>
            <div className="job-actions">
              <button
                className="btn tiny quiet"
                onClick={() => onRemove(f.path)}
                aria-label={`Remove ${f.name}`}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="hint" style={{ marginTop: 10 }}>
        {bytes(total)} in total
      </div>
    </div>
  );
}
