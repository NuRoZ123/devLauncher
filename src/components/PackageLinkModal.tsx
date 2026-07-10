import { useEffect } from "react";
import type { Project, ServiceDep } from "../types";

export interface LinkModalState {
  pkg: Project;
  depName: string;
  version: string;
  folder: string;
  services: ServiceDep[];
  loading: boolean;
  error?: string;
}

interface Props {
  state: LinkModalState;
  busyId: string | null;
  onApply: (svc: ServiceDep, link: boolean) => void;
  onClose: () => void;
}

export function PackageLinkModal({ state, busyId, onApply, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const linkPath = `../../packages/${state.folder}`;
  const restoreValue = state.version;
  const present = state.services.filter((s) => s.present);
  const absent = state.services.filter((s) => !s.present);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Lier le package</h3>
          <button className="tab-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-sub link-meta">
          <span className="badge badge-package">package</span>
          <b>{state.depName || state.pkg.name}</b>
          {state.version && <span className="chip">v{state.version}</span>}
        </div>
        <div className="link-paths muted">
          Lier → <code>{linkPath}</code> &nbsp;·&nbsp; Restaurer → <code>{restoreValue}</code>
        </div>

        {state.error && <div className="banner-error">{state.error}</div>}

        <div className="branch-list link-list">
          {state.loading && (
            <div className="branch-loading">
              <span className="spinner" /> Analyse des services…
            </div>
          )}

          {!state.loading && present.length === 0 && (
            <div className="branch-empty muted">
              Aucun service n'utilise <b>{state.depName}</b>. Rien à faire.
            </div>
          )}

          {!state.loading &&
            present.map((s) => (
              <div className="link-row" key={s.id}>
                <div className="link-row-main">
                  <span className="link-svc">{s.name}</span>
                  <span
                    className={"chip " + (s.linked ? "chip-linked" : "chip-version")}
                    title={s.location ?? ""}
                  >
                    {s.linked ? "⛓ local" : "📦 " + s.value}
                  </span>
                </div>
                {s.linked ? (
                  <button
                    className="btn btn-sm"
                    disabled={busyId === s.id}
                    onClick={() => onApply(s, false)}
                    title={`Remettre ${restoreValue}`}
                  >
                    {busyId === s.id ? <span className="spinner spinner-xs" /> : "Restaurer"}
                  </button>
                ) : (
                  <button
                    className="btn btn-sm btn-start"
                    disabled={busyId === s.id}
                    onClick={() => onApply(s, true)}
                    title={`Pointer vers ${linkPath}`}
                  >
                    {busyId === s.id ? <span className="spinner spinner-xs" /> : "⛓ Lier"}
                  </button>
                )}
              </div>
            ))}
        </div>

        {!state.loading && absent.length > 0 && (
          <div className="link-absent muted">
            {absent.length} service{absent.length > 1 ? "s" : ""} sans ce package (ignoré
            {absent.length > 1 ? "s" : ""}) : {absent.map((s) => s.name).join(", ")}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
