import { useCallback, useEffect, useState } from "react";
import { api, pickFolder } from "../api";
import type { ProjectKind, ProjectSource } from "../types";

const KINDS: ProjectKind[] = ["service", "front", "package", "fullstack"];
const KIND_LABEL: Record<ProjectKind, string> = {
  service: "Service",
  front: "Front",
  package: "Package",
  fullstack: "Full-stack",
};

interface Props {
  sources: ProjectSource[];
  onChange: (sources: ProjectSource[]) => void;
  /** Place les boutons « Ajouter » au-dessus de la liste plutôt qu'en dessous. */
  addButtonsOnTop?: boolean;
}

function genId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `src-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Nom de dossier (dernier segment du chemin), séparateurs Windows ou POSIX. */
function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * Gestion des sources de projets : projets uniques (un dossier = un projet) et
 * dossiers parents (chaque sous-dossier = un projet, typé individuellement).
 * Réutilisé à la première configuration (Setup) et dans les Réglages.
 */
export function ProjectSources({ sources, onChange, addButtonsOnTop = false }: Props) {
  // Sous-dossiers détectés, par id de source « parent » (undefined = pas encore chargé).
  const [subdirs, setSubdirs] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const loadSubdirs = useCallback(async (src: ProjectSource) => {
    setLoading((l) => ({ ...l, [src.id]: true }));
    try {
      const names = await api.listSubdirs(src.path);
      setSubdirs((s) => ({ ...s, [src.id]: names }));
    } catch {
      setSubdirs((s) => ({ ...s, [src.id]: [] }));
    } finally {
      setLoading((l) => ({ ...l, [src.id]: false }));
    }
  }, []);

  // Charge les sous-dossiers de chaque source parent pas encore analysée.
  useEffect(() => {
    for (const src of sources) {
      if (src.mode === "parent" && subdirs[src.id] === undefined && !loading[src.id]) {
        void loadSubdirs(src);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  const update = (id: string, patch: Partial<ProjectSource>) =>
    onChange(sources.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const remove = (id: string) => onChange(sources.filter((s) => s.id !== id));

  const addSingle = async () => {
    const p = await pickFolder("Choisir un projet");
    if (!p) return;
    onChange([...sources, { id: genId(), path: p, mode: "single", type: "service" }]);
  };

  const addParent = async () => {
    const p = await pickFolder("Choisir un dossier parent");
    if (!p) return;
    onChange([
      ...sources,
      { id: genId(), path: p, mode: "parent", defaultType: "service", overrides: {} },
    ]);
  };

  // "" = suit le type par défaut (pas d'exception) ; sinon type précis ou "ignored".
  const setChildType = (
    src: ProjectSource,
    child: string,
    value: ProjectKind | "ignored" | "",
  ) => {
    const overrides = { ...(src.overrides ?? {}) };
    if (value === "") delete overrides[child];
    else overrides[child] = value;
    update(src.id, { overrides });
  };

  const actions = (
    <div className="sources-actions">
      <button className="btn" onClick={addSingle}>
        + Ajouter un projet
      </button>
      <button className="btn" onClick={addParent}>
        + Ajouter un dossier parent
      </button>
    </div>
  );

  return (
    <div className="sources">
      {addButtonsOnTop && actions}
      {sources.length === 0 && (
        <p className="muted sources-empty">
          Aucun projet pour l'instant. Ajoutez un <b>projet</b> (un dossier = un projet), ou un{" "}
          <b>dossier parent</b> dont chaque sous-dossier deviendra un projet à typer.
        </p>
      )}

      {sources.map((src) => (
        <div className="source-card" key={src.id}>
          <div className="source-head">
            <span
              className={"badge " + (src.mode === "parent" ? "badge-parent" : "badge-single")}
            >
              {src.mode === "parent" ? "Dossier" : "Projet"}
            </span>
            <span className="source-name" title={src.path}>
              {basename(src.path)}
            </span>

            {src.mode === "single" ? (
              <select
                className="source-type"
                value={src.type ?? "service"}
                onChange={(e) => update(src.id, { type: e.target.value as ProjectKind })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            ) : (
              <label className="source-default">
                <span className="muted">Type par défaut</span>
                <select
                  value={src.defaultType ?? "service"}
                  onChange={(e) => update(src.id, { defaultType: e.target.value as ProjectKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {src.mode === "parent" && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => loadSubdirs(src)}
                title="Réanalyser les sous-dossiers"
              >
                ↻
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm source-remove"
              onClick={() => remove(src.id)}
              title="Retirer cette source"
            >
              Retirer
            </button>
          </div>

          <div className="source-path muted">{src.path}</div>

          {src.mode === "single" && src.type === "fullstack" && (
            <div className="fullstack-dirs">
              <small className="muted">
                Sous-dossiers back / front. Laissez vide pour l'auto-détection
                (back/backend/api…, front/frontend/web…). Le package.json à la racine, s'il
                existe, fournit les commandes communes.
              </small>
              <div className="fullstack-dirs-row">
                <label className="fullstack-dir">
                  <span className="muted">Sous-dossier back</span>
                  <input
                    value={src.backDir ?? ""}
                    placeholder="auto"
                    onChange={(e) => update(src.id, { backDir: e.target.value })}
                  />
                </label>
                <label className="fullstack-dir">
                  <span className="muted">Sous-dossier front</span>
                  <input
                    value={src.frontDir ?? ""}
                    placeholder="auto"
                    onChange={(e) => update(src.id, { frontDir: e.target.value })}
                  />
                </label>
              </div>
            </div>
          )}

          {src.mode === "parent" && (
            <div className="subdirs">
              {loading[src.id] && <span className="muted">Analyse des sous-dossiers…</span>}
              {!loading[src.id] && (subdirs[src.id]?.length ?? 0) === 0 && (
                <span className="muted">Aucun sous-dossier détecté.</span>
              )}
              {(subdirs[src.id] ?? []).map((child) => (
                <div className="subdir-row" key={child}>
                  <span className="subdir-name" title={child}>
                    {child}
                  </span>
                  <select
                    value={src.overrides?.[child] ?? ""}
                    onChange={(e) =>
                      setChildType(src, child, e.target.value as ProjectKind | "ignored" | "")
                    }
                  >
                    <option value="">Défaut ({KIND_LABEL[src.defaultType ?? "service"]})</option>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                    <option value="ignored">Ignorer</option>
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {!addButtonsOnTop && actions}
    </div>
  );
}
