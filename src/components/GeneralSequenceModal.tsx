import { useEffect, useState } from "react";
import { findAction } from "../constants";
import type { Project, Sequence } from "../types";

interface Props {
  sequence: Sequence;
  projects: Project[];
  colors: Record<string, string>;
  onRun: (targetIds: string[], branch: string) => void;
  onClose: () => void;
}

export function GeneralSequenceModal({ sequence, projects, colors, onRun, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const steps = sequence.actionIds.map((id) => findAction(id)).filter(Boolean);
  const needsBranch = steps.some((a) => a?.needsBranch);
  const [branch, setBranch] = useState("");

  // Cibles définies à la création, résolues vers les projets existants.
  const targets = (sequence.targets ?? [])
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => !!p);

  const canRun = targets.length > 0 && (!needsBranch || branch.trim().length > 0);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            Lancer · <span style={sequence.color ? { color: sequence.color } : undefined}>{sequence.name}</span>
          </h3>
          <button className="tab-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="gseq-steps">
          {steps.map((a, i) => (
            <span className="gseq-step" key={i}>
              <span className="gseq-step-num">{i + 1}</span>
              <span style={a && colors[a.id] ? { color: colors[a.id] } : undefined}>{a?.label}</span>
            </span>
          ))}
        </div>

        {needsBranch && (
          <label className="field gseq-branch">
            <span>Branche cible (appliquée à tous les services)</span>
            <input
              autoFocus
              value={branch}
              placeholder="ex: develop"
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canRun && onRun(targets.map((p) => p.id), branch.trim())}
            />
          </label>
        )}

        <div className="gseq-targets-head">
          <span className="muted">
            Cibles ({targets.length}) — définies dans la séquence
          </span>
        </div>
        <div className="gseq-target-chips">
          {targets.length === 0 ? (
            <span className="muted">
              Aucune cible définie. Modifiez la séquence dans ⚙ Réglages.
            </span>
          ) : (
            targets.map((p) => (
              <span className={"badge badge-" + p.kind} key={p.id} style={{ padding: "3px 9px" }}>
                {p.name}
              </span>
            ))
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            className="btn btn-primary"
            disabled={!canRun}
            onClick={() => onRun(targets.map((p) => p.id), branch.trim())}
          >
            ▶ Lancer sur {targets.length} projet{targets.length > 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
