import { useEffect, useMemo, useState } from "react";
import type { BranchInfo } from "../types";

export interface BranchModalState {
  projectId: string;
  projectName: string;
  current: string;
  branches: BranchInfo[];
  loading: boolean;
}

interface Props {
  state: BranchModalState;
  onConfirm: (branch: string) => void;
  onCancel: () => void;
}

export function BranchModal({ state, onConfirm, onCancel }: Props) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return state.branches.filter((b) => b.name.toLowerCase().includes(f));
  }, [state.branches, filter]);

  // Si le filtre ne correspond à aucune branche existante, on autorise la
  // création/checkout d'une branche tapée telle quelle.
  const typed = filter.trim();
  const isNew = typed.length > 0 && !state.branches.some((b) => b.name === typed);
  const target = selected || (isNew ? typed : "");

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Changer de branche</h3>
          <button className="tab-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="modal-sub">
          <span className="muted">{state.projectName}</span>
          <span className="chip chip-branch" style={{ cursor: "default" }}>
            actuelle : {state.current}
          </span>
        </div>

        <input
          autoFocus
          className="modal-search"
          placeholder="Filtrer ou saisir une branche…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setSelected("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && target) onConfirm(target);
          }}
        />

        <div className="branch-list">
          {state.loading && <div className="branch-loading"><span className="spinner" /> Chargement des branches…</div>}
          {!state.loading && filtered.length === 0 && !isNew && (
            <div className="muted branch-empty">Aucune branche locale.</div>
          )}
          {!state.loading &&
            filtered.map((b) => (
              <button
                key={b.name}
                className={
                  "branch-item" +
                  (b.name === selected ? " sel" : "") +
                  (b.name === state.current ? " current" : "")
                }
                onClick={() => setSelected(b.name)}
                onDoubleClick={() => onConfirm(b.name)}
              >
                <span className="branch-ico">⎇</span>
                {b.name}
                {b.name === state.current && <span className="branch-tag">actuelle</span>}
                {b.remote && b.name !== state.current && (
                  <span className="branch-tag branch-tag-remote">distante</span>
                )}
              </button>
            ))}
          {!state.loading && isNew && (
            <button
              className={"branch-item new" + (selected === "" ? " sel" : "")}
              onClick={() => setSelected("")}
              onDoubleClick={() => onConfirm(typed)}
            >
              <span className="branch-ico">＋</span>
              Utiliser « {typed} »
            </button>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>
            Annuler
          </button>
          <button
            className="btn btn-primary"
            disabled={!target || target === state.current}
            onClick={() => onConfirm(target)}
          >
            Basculer
          </button>
        </div>
      </div>
    </div>
  );
}
