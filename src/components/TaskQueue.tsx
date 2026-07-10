import type { JobStatus, QJob } from "../types";

interface Props {
  jobs: QJob[];
  onCancelJob: (jobId: string) => void;
  onCancelStep: (jobId: string, stepId: string) => void;
  onClear: () => void;
  onClose: () => void;
}

const ICON: Record<JobStatus, string> = {
  pending: "○",
  running: "",
  done: "✓",
  failed: "✗",
  cancelled: "⊘",
};

function active(status: JobStatus) {
  return status === "running" || status === "pending";
}

export function TaskQueue({ jobs, onCancelJob, onCancelStep, onClear, onClose }: Props) {
  const hasFinished = jobs.some((j) => !active(j.status));

  return (
    <div className="taskq">
      <div className="taskq-head">
        <h3>Tâches</h3>
        <div className="taskq-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClear} disabled={!hasFinished}>
            Effacer terminées
          </button>
          <button className="tab-close" onClick={onClose} title="Fermer">
            ×
          </button>
        </div>
      </div>

      <div className="taskq-body">
        {jobs.length === 0 && <div className="taskq-empty">Aucune tâche.</div>}
        {jobs.map((j) => (
          <div className={"taskq-job status-" + j.status} key={j.id}>
            <div className="taskq-job-head">
              <span className={"job-dot job-" + j.status}>
                {j.status === "running" ? <span className="spinner spinner-xs" /> : ICON[j.status]}
              </span>
              <div className="taskq-job-title">
                <span className="taskq-job-name">{j.title}</span>
                <span className="taskq-job-proj">{j.projectName}</span>
              </div>
              {active(j.status) && j.cancellable && (
                <button className="btn btn-stop btn-sm" onClick={() => onCancelJob(j.id)}>
                  Annuler
                </button>
              )}
            </div>
            <div className="taskq-steps">
              {j.steps.map((s) => (
                <div className={"taskq-step step-" + s.status} key={s.id}>
                  <span className={"step-dot step-" + s.status}>
                    {s.status === "running" ? (
                      <span className="spinner spinner-xs" />
                    ) : (
                      ICON[s.status]
                    )}
                  </span>
                  <span className="taskq-step-label">{s.label}</span>
                  {active(s.status) && j.cancellable && (
                    <button
                      className="icon-btn step-cancel"
                      title="Annuler cette action"
                      onClick={() => onCancelStep(j.id, s.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
