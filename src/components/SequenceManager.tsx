import { useState } from "react";
import type { ActionDef, Project, ProjectKind, Sequence } from "../types";
import { ColorPicker } from "./ColorPicker";

interface Props {
  sequences: Sequence[];
  mode: "project" | "general";
  projects: Project[];
  actions: ActionDef[];
  onChange: (next: Sequence[]) => void;
}

const KIND_LABEL: Record<ProjectKind, string> = {
  service: "service",
  front: "front",
  package: "package",
};

export function SequenceManager({ sequences, mode, projects, actions, onChange }: Props) {
  const actionLabel = (id: string) => actions.find((a) => a.id === id)?.label ?? id;
  const actionColor = (id: string) => actions.find((a) => a.id === id)?.color;
  const [newName, setNewName] = useState("");
  const isGeneral = mode === "general";
  const list = sequences.filter((s) => !!s.global === isGeneral);

  function update(id: string, patch: Partial<Sequence>) {
    onChange(sequences.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function addSequence() {
    const name = newName.trim();
    if (!name) return;
    const seq: Sequence = {
      id: `seq-${Date.now()}`,
      name,
      actionIds: [],
      global: isGeneral,
      ...(isGeneral ? { targets: [] } : {}),
    };
    onChange([...sequences, seq]);
    setNewName("");
  }

  function move(seq: Sequence, from: number, dir: -1 | 1) {
    const to = from + dir;
    const ids = seq.actionIds.slice();
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    update(seq.id, { actionIds: ids });
  }

  function toggleTarget(seq: Sequence, pid: string) {
    const t = new Set(seq.targets ?? []);
    if (t.has(pid)) t.delete(pid);
    else t.add(pid);
    update(seq.id, { targets: [...t] });
  }

  return (
    <div className="seq-manager">
      <div className="seq-add">
        <input
          value={newName}
          placeholder={isGeneral ? "Nom d'une séquence générale" : "Nom d'une séquence"}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addSequence()}
        />
        <button className="btn btn-primary btn-sm" onClick={addSequence}>
          + Ajouter
        </button>
      </div>

      {list.length === 0 && <p className="muted">Aucune séquence ici.</p>}

      {list.map((s) => {
        const allChecked = (s.targets?.length ?? 0) === projects.length && projects.length > 0;
        return (
          <div className="seq-card" key={s.id}>
            <div className="seq-head">
              <ColorPicker value={s.color} onChange={(c) => update(s.id, { color: c || undefined })} />
              <input
                className="seq-title-input"
                style={s.color ? { color: s.color } : undefined}
                value={s.name}
                onChange={(e) => update(s.id, { name: e.target.value })}
              />
              <button
                className="btn btn-ghost btn-sm menu-danger"
                onClick={() => onChange(sequences.filter((x) => x.id !== s.id))}
              >
                Supprimer
              </button>
            </div>

            <div className="seq-steps">
              {s.actionIds.length === 0 && (
                <span className="muted">Aucune action — ajoutez-en une.</span>
              )}
              {s.actionIds.map((aid, i) => (
                <div className="seq-step" key={i}>
                  <span className="seq-step-num">{i + 1}</span>
                  <span className="seq-step-label" style={{ color: actionColor(aid) }}>
                    {actionLabel(aid)}
                  </span>
                  <span className="seq-step-tools">
                    <button className="icon-btn" title="Monter" onClick={() => move(s, i, -1)}>
                      ↑
                    </button>
                    <button className="icon-btn" title="Descendre" onClick={() => move(s, i, 1)}>
                      ↓
                    </button>
                    <button
                      className="icon-btn"
                      title="Retirer"
                      onClick={() =>
                        update(s.id, { actionIds: s.actionIds.filter((_, k) => k !== i) })
                      }
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>

            <div className="seq-addstep">
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  update(s.id, { actionIds: [...s.actionIds, e.target.value] });
                }}
              >
                <option value="">+ Ajouter une action…</option>
                {actions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>

            {isGeneral && (
              <div className="seq-targets">
                <div className="seq-targets-head">
                  <span className="muted">Cibles ({s.targets?.length ?? 0})</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      update(s.id, { targets: allChecked ? [] : projects.map((p) => p.id) })
                    }
                  >
                    {allChecked ? "Tout décocher" : "Tout cocher"}
                  </button>
                </div>
                <div className="seq-target-list">
                  {projects.length === 0 && (
                    <span className="muted">Aucun projet (scannez d'abord).</span>
                  )}
                  {projects.map((p) => (
                    <label className="seq-target" key={p.id}>
                      <input
                        type="checkbox"
                        checked={s.targets?.includes(p.id) ?? false}
                        onChange={() => toggleTarget(s, p.id)}
                      />
                      <span className="seq-target-name">{p.name}</span>
                      <span className={"badge badge-" + p.kind}>{KIND_LABEL[p.kind]}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
