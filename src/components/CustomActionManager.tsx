import { useState } from "react";
import type { ActionDef } from "../types";
import { ColorPicker } from "./ColorPicker";

interface Props {
  actions: ActionDef[];
  colors: Record<string, string>;
  onChange: (next: ActionDef[]) => void;
  onColor: (id: string, color: string) => void;
}

export function CustomActionManager({ actions, colors, onChange, onColor }: Props) {
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");

  function add() {
    const l = label.trim();
    const c = command.trim();
    if (!l || !c) return;
    onChange([...actions, { id: `custom-${Date.now()}`, label: l, command: c, kind: "bash" }]);
    setLabel("");
    setCommand("");
  }

  function update(id: string, patch: Partial<ActionDef>) {
    onChange(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  return (
    <div className="customact">
      <div className="customact-add">
        <input
          className="ca-label"
          value={label}
          placeholder="Nom de l'action"
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          className="ca-cmd"
          value={command}
          placeholder="Commande (ex: npm run lint)"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn btn-primary btn-sm" onClick={add}>
          + Ajouter
        </button>
      </div>

      {actions.length === 0 && (
        <p className="muted">
          Aucune action personnalisée. Elles apparaîtront dans le menu Actions et dans les
          séquences.
        </p>
      )}

      {actions.map((a) => (
        <div className="ca-row" key={a.id}>
          <ColorPicker value={colors[a.id]} onChange={(c) => onColor(a.id, c)} />
          <input
            className="ca-label"
            style={colors[a.id] ? { color: colors[a.id] } : undefined}
            value={a.label}
            onChange={(e) => update(a.id, { label: e.target.value })}
          />
          <span className="ca-prompt">$</span>
          <input
            className="ca-cmd"
            value={a.command}
            onChange={(e) => update(a.id, { command: e.target.value })}
          />
          <label
            className="ca-visible"
            title="Afficher dans le menu Actions des projets (décoché = réservé aux séquences)"
          >
            <input
              type="checkbox"
              checked={!a.hidden}
              onChange={(e) => update(a.id, { hidden: !e.target.checked })}
            />
            Projets
          </label>
          <button
            className="btn btn-ghost btn-sm menu-danger"
            onClick={() => onChange(actions.filter((x) => x.id !== a.id))}
          >
            Supprimer
          </button>
        </div>
      ))}
    </div>
  );
}
