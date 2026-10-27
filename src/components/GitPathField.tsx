import { useEffect, useState } from "react";
import { api, pickGitExe } from "../api";

export const DEFAULT_GIT_EXE = "C:\\Program Files\\Git\\cmd\\git.exe";

interface FieldProps {
  value: string;
  onChange: (v: string) => void;
  /** Chemin de Git Bash : sert à proposer le git.exe installé à côté. */
  bash: string;
  onBlur?: () => void;
}

/**
 * Saisie du chemin de git.exe : Parcourir, détection automatique (à côté de
 * Git Bash, sinon PATH) et vérification en direct (`git --version`).
 */
export function GitPathInput({ value, onChange, bash, onBlur }: FieldProps) {
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);

  // Vérification (avec un léger délai pendant la frappe).
  useEffect(() => {
    const v = value.trim();
    if (!v) {
      setCheck(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .checkGit(v)
        .then((ver) => alive && setCheck({ ok: true, text: ver }))
        .catch((e) => alive && setCheck({ ok: false, text: String(e) }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value]);

  return (
    <>
      <div className="field-row">
        <input value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} placeholder={DEFAULT_GIT_EXE} />
        <button
          className="btn"
          title="Chercher git.exe à côté de Git Bash, sinon dans le PATH"
          onClick={async () => {
            const p = await api.suggestGitPath(bash);
            if (p) onChange(p);
            else setCheck({ ok: false, text: "git.exe introuvable automatiquement : utilisez « Parcourir… »." });
          }}
        >
          Détecter
        </button>
        <button
          className="btn"
          onClick={async () => {
            const p = await pickGitExe();
            if (p) onChange(p);
          }}
        >
          Parcourir…
        </button>
      </div>
      {check && <small className={check.ok ? "git-check-ok" : "field-error"}>{check.ok ? `✓ ${check.text}` : check.text}</small>}
    </>
  );
}

interface ModalProps {
  bash: string;
  onSave: (path: string) => void;
  onLater: () => void;
}

/**
 * Demande le chemin de git.exe aux utilisateurs existants dont la config ne le
 * contient pas encore (le champ est apparu avec le passage de git en direct).
 */
export function GitPathModal({ bash, onSave, onLater }: ModalProps) {
  const [value, setValue] = useState("");
  const [ok, setOk] = useState(false);

  // Pré-remplit avec le git.exe détecté.
  useEffect(() => {
    api
      .suggestGitPath(bash)
      .then((p) => setValue((v) => v || p || DEFAULT_GIT_EXE))
      .catch(() => setValue((v) => v || DEFAULT_GIT_EXE));
  }, [bash]);

  useEffect(() => {
    const v = value.trim();
    if (!v) return setOk(false);
    let alive = true;
    api
      .checkGit(v)
      .then(() => alive && setOk(true))
      .catch(() => alive && setOk(false));
    return () => {
      alive = false;
    };
  }, [value]);

  return (
    <div className="modal-backdrop">
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Chemin de git.exe</h3>
        </div>
        <p className="cf-p">
          Les fonctions git de DevLauncher (branches, modifications, commit, push/pull, conflits) appellent désormais
          git directement, sans passer par Git Bash : c'est nettement plus rapide. Indiquez l'exécutable git à utiliser.
          Git Bash reste utilisé pour les services et les actions.
        </p>
        <label className="field">
          <span>git.exe</span>
          <GitPathInput value={value} onChange={setValue} bash={bash} />
        </label>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onLater} title="git du PATH sera utilisé en attendant">
            Plus tard
          </button>
          <button className="btn btn-primary" disabled={!ok} onClick={() => onSave(value.trim())}>
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
