import { useEffect, useState } from "react";
import type { Project } from "../types";

interface Props {
  project: Project;
  /** URL détectée automatiquement (remote git / package.json), ou "". */
  autoUrl: string;
  /** Override manuel actuel, ou null si le projet suit la détection auto. */
  override: string | null;
  /** null = supprime l'override (revient à la détection auto). */
  onSave: (url: string | null) => void;
  onCancel: () => void;
}

/**
 * Édition du lien de dépôt d'un projet. Par défaut il suit l'URL détectée
 * automatiquement ; on peut la remplacer manuellement (ou en saisir une si rien
 * n'est détecté).
 */
export function RepoLinkModal({ project, autoUrl, override, onSave, onCancel }: Props) {
  const [useAuto, setUseAuto] = useState(override == null && autoUrl.length > 0);
  const [url, setUrl] = useState(override ?? autoUrl ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const valid = useAuto || url.trim().length > 0;
  const save = () => {
    if (!valid) return;
    onSave(useAuto ? null : url.trim());
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Lien du dépôt — {project.name}</h3>
          <button className="tab-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-sub">
          <span className="muted">
            Ouvre la page GitLab / GitHub du projet. Détecté depuis le remote git (ou le
            package.json) ; tu peux le remplacer manuellement.
          </span>
        </div>

        {autoUrl && (
          <label className="autostart-row">
            <input
              type="checkbox"
              checked={useAuto}
              onChange={(e) => setUseAuto(e.target.checked)}
            />
            <span>
              Utiliser le lien détecté (<code>{autoUrl}</code>)
            </span>
          </label>
        )}

        {!useAuto && (
          <label className="field">
            <div className="field-row">
              <input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://gitlab.com/groupe/projet"
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
