import { useEffect, useState } from "react";

export interface EnvModalState {
  projectId: string;
  projectName: string;
  path: string;
  /** Contenu tel que chargé depuis le disque (pour détecter les changements). */
  original: string;
  /** true = le service tourne : l'enregistrement déclenchera un redémarrage. */
  running: boolean;
  loading: boolean;
  saving: boolean;
  error?: string;
}

interface Props {
  state: EnvModalState;
  onSave: (content: string) => void;
  onCancel: () => void;
}

export function EnvModal({ state, onSave, onCancel }: Props) {
  const [content, setContent] = useState("");

  // Réinitialise le textarea quand le contenu du disque arrive (fin de chargement).
  useEffect(() => {
    if (!state.loading) setContent(state.original);
  }, [state.loading, state.original]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const dirty = content !== state.original;
  const busy = state.loading || state.saving;

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal modal-env" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Modifier le .env</h3>
          <button className="tab-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-sub">
          <span className="muted">{state.projectName}</span>
          <code className="env-path">.env</code>
          {dirty && !busy && <span className="chip chip-dirty">modifié</span>}
        </div>

        {state.error && <div className="banner-error">{state.error}</div>}

        <div className="env-editor-wrap">
          {state.loading ? (
            <div className="branch-loading">
              <span className="spinner" /> Chargement du fichier…
            </div>
          ) : (
            <textarea
              className="env-editor"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              value={content}
              disabled={state.saving}
              onChange={(e) => setContent(e.target.value)}
            />
          )}
        </div>

        <div className="env-hint muted">
          {state.running
            ? "L'enregistrement redémarrera le service si le contenu a changé."
            : "Le service n'est pas démarré : les changements s'appliqueront au prochain lancement."}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>
            Annuler
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !dirty}
            onClick={() => onSave(content)}
          >
            {state.saving ? (
              <span className="spinner spinner-xs" />
            ) : state.running ? (
              "Enregistrer & redémarrer"
            ) : (
              "Enregistrer"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
