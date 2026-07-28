import { useEffect, useState } from "react";
import type { ActionDef } from "../types";

interface Props {
  projectName: string;
  /** Le script ciblé (label = nom, command = "npm run <script>"). */
  action: ActionDef;
  /** Exécute avec les arguments saisis (chaîne éventuellement vide). */
  onRun: (args: string) => void;
  onCancel: () => void;
}

/**
 * Saisie d'arguments pour un script du package.json. Les arguments sont passés au
 * script via `npm run <script> -- <args>` (le `--` sépare les options npm de
 * celles du script). Ouverte par clic droit sur un script du menu Actions.
 */
export function ScriptArgsModal({ projectName, action, onRun, onCancel }: Props) {
  const [args, setArgs] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const trimmed = args.trim();
  const preview = trimmed ? `${action.command} -- ${trimmed}` : action.command;
  const run = () => onRun(trimmed);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Arguments — {action.label}</h3>
          <button className="tab-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-sub">
          <span className="muted">{projectName}</span>
        </div>

        <label className="field">
          <small className="muted">
            Arguments passés au script (après <code>--</code>). Laisser vide pour l'exécuter tel
            quel.
          </small>
          <div className="field-row">
            <input
              autoFocus
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="--prod --watch"
              onKeyDown={(e) => {
                if (e.key === "Enter") run();
              }}
            />
          </div>
        </label>

        <div className="cmd-preview">
          <code>{preview}</code>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>
            Annuler
          </button>
          <button className="btn btn-primary" onClick={run}>
            Exécuter
          </button>
        </div>
      </div>
    </div>
  );
}
