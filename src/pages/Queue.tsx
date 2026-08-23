import type { Job, QueueState } from "../types";
import { KIND_ICON, bytes, seconds, sizeDelta } from "../ui";

function meta(job: Job): JSX.Element {
  switch (job.status) {
    case "queued":
      return <>waiting · {bytes(job.inputSize)}</>;
    case "running":
      return (
        <>
          {job.durationSec
            ? `${Math.round(job.progress * 100)}% of ${seconds(job.durationSec)}`
            : "working…"}
          {job.speed ? ` · ${job.speed}` : ""}
        </>
      );
    case "done": {
      const delta = sizeDelta(job.inputSize, job.outputSize);
      return (
        <>
          <span className="ok">Done</span> · {bytes(job.inputSize)} → {bytes(job.outputSize)}
          {delta ? ` · ${delta}` : ""}
        </>
      );
    }
    case "failed":
      return <span className="err">{job.error ?? "Failed."}</span>;
    case "cancelled":
      return <>Stopped before it finished.</>;
  }
}

export default function Queue({
  state,
  onCancel,
  onRemove,
  onReveal,
  onClearFinished,
}: {
  state: QueueState;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onReveal: (file: string) => void;
  onClearFinished: () => void;
}) {
  const finished = state.jobs.filter(
    (j) => j.status === "done" || j.status === "failed" || j.status === "cancelled",
  ).length;

  return (
    <div className="card">
      <div className="card-head">
        <div className="label">Queue</div>
        {finished > 0 && (
          <button className="linkish" onClick={onClearFinished}>
            Clear finished
          </button>
        )}
      </div>

      <div className="jobs">
        {state.jobs.map((job) => (
          <div className={`job ${job.status}`} key={job.id}>
            <div className="job-icon" aria-hidden="true">
              {KIND_ICON[job.inputKind] ?? "▣"}
            </div>

            <div style={{ minWidth: 0 }}>
              <div className="job-name" title={job.output ?? job.input}>
                {job.inputName} <span className="fmt-ext">→ {job.presetLabel}</span>
              </div>
              <div className="job-meta">{meta(job)}</div>
              {job.status === "running" && (
                <div className={`bar ${job.durationSec ? "" : "indeterminate"}`}>
                  <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
                </div>
              )}
            </div>

            <div className="job-actions">
              {job.status === "done" && job.output && (
                <button className="btn tiny quiet" onClick={() => onReveal(job.output!)}>
                  Show in folder
                </button>
              )}
              {(job.status === "running" || job.status === "queued") && (
                <button className="btn tiny quiet" onClick={() => onCancel(job.id)}>
                  Cancel
                </button>
              )}
              {(job.status === "done" || job.status === "failed" || job.status === "cancelled") && (
                <button
                  className="btn tiny quiet"
                  onClick={() => onRemove(job.id)}
                  aria-label={`Remove ${job.inputName} from the list`}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
