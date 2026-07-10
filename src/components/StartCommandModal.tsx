import { useEffect, useState } from "react";
import { START_COMMAND_PLACEHOLDER } from "../constants";
import type { Project } from "../types";

interface Props {
  /** Projet ciblé (édition d'une exception), ou null = commande par défaut. */
  project: Project | null;
  /** Commande par défaut actuelle (config). */
  defaultCommand: string;
  /** Exception actuelle du projet (null = il suit la commande par défaut). */
  override: string | null;
  /**
   * Mode par défaut : nouvelle commande par défaut.
   * Mode projet : nouvelle exception, ou null pour revenir à la commande par défaut.
   */
  onSave: (command: string | null) => void;
  onCancel: () => void;
}

/**
 * Édition de la commande de démarrage. Ouvert par clic droit sur
 * « Tout démarrer » (commande par défaut) ou sur le « Démarrer » d'un
 * projet (exception propre à ce projet).
 */
export function StartCommandModal({ project, defaultCommand, override, onSave, onCancel }: Props) {
  const [useDefault, setUseDefault] = useState(project != null && override == null);
  const [command, setCommand] = useState(project ? override ?? defaultCommand : defaultCommand);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const valid = useDefault || command.trim().length > 0;
  const save = () => {
    if (!valid) return;
    onSave(project && useDefault ? null : command.trim());
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            {project
              ? `Commande de démarrage — ${project.name}`
              : "Commande de démarrage par défaut"}
          </h3>
          <button className="tab-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-sub">
          <span className="muted">
            {project
              ? "Exception propre à ce projet : elle remplace la commande par défaut."
              : "Utilisée par tous les projets démarrables, sauf ceux ayant une exception."}
          </span>
        </div>

        {project && (
          <label className="autostart-row">
            <input
              type="checkbox"
              checked={useDefault}
              onChange={(e) => setUseDefault(e.target.checked)}
            />
            <span>
              Utiliser la commande par défaut (<code>{defaultCommand || "non définie"}</code>)
            </span>
          </label>
        )}

        {!(project && useDefault) && (
          <label className="field">
            <div className="field-row">
              <input
                autoFocus
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={START_COMMAND_PLACEHOLDER}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
            </div>
          </label>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>
            Annuler
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={save}>
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
