import { useMemo, useState, type ReactNode } from "react";
import type { DbDriver } from "../types";

export interface DbWsState {
  projectId: string;
  projectName: string;
  driver: DbDriver;
  /** Nom de la base (résolu depuis le .env). */
  database: string;
  tables: string[];
  loading: boolean;
  error?: string;
}

export interface DbTabInfo {
  id: string;
  /** Table actuellement affichée dans l'onglet (change si on suit une FK). */
  label: string;
  /** Nombre de modifications non enregistrées dans cet onglet. */
  dirty: number;
}

interface Props {
  state: DbWsState;
  tabs: DbTabInfo[];
  activeId: string | null;
  onOpenTable: (table: string) => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onRefreshTables: () => void;
  onClose: () => void;
  /** Panneaux des onglets (tous montés, seul l'actif est visible). */
  children?: ReactNode;
}

const DRIVER_LABEL: Record<DbDriver, string> = {
  mariadb: "MariaDB / MySQL",
  postgres: "PostgreSQL",
};

export function DbWorkspaceView({
  state,
  tabs,
  activeId,
  onOpenTable,
  onSelectTab,
  onCloseTab,
  onRefreshTables,
  onClose,
  children,
}: Props) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? state.tables.filter((t) => t.toLowerCase().includes(s)) : state.tables;
  }, [q, state.tables]);

  const activeLabel = tabs.find((t) => t.id === activeId)?.label;

  return (
    <div className="dbws-backdrop" onMouseDown={onClose}>
      <div className="dbws" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dbws-head">
          <div className="dbws-title">
            <h3>{state.database || state.projectName}</h3>
            <span className="muted">
              {state.projectName} · {DRIVER_LABEL[state.driver]}
            </span>
          </div>
          <button className="tab-close" onClick={onClose} title="Fermer">
            ×
          </button>
        </div>

        <div className="dbws-body">
          <aside className="dbws-side">
            <div className="dbws-side-head">
              <input
                className="dbws-search"
                placeholder="Filtrer les tables…"
                spellCheck={false}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={onRefreshTables}
                disabled={state.loading}
                title="Recharger la liste des tables"
              >
                ↻
              </button>
            </div>
            <div className="dbws-tables">
              {state.loading ? (
                <div className="branch-loading">
                  <span className="spinner" /> Lecture des tables…
                </div>
              ) : state.error ? (
                <div className="banner-error">{state.error}</div>
              ) : filtered.length === 0 ? (
                <div className="empty">
                  {state.tables.length === 0 ? "Aucune table." : `Aucune table « ${q} ».`}
                </div>
              ) : (
                filtered.map((t) => (
                  <button
                    key={t}
                    className={"dbws-table" + (t === activeLabel ? " on" : "")}
                    onClick={() => onOpenTable(t)}
                    title={`${t} — ouvrir dans un onglet`}
                  >
                    <span className="db-table-ico">▤</span>
                    <span className="db-table-name">{t}</span>
                  </button>
                ))
              )}
            </div>
            <div className="dbws-side-foot muted">
              {filtered.length} / {state.tables.length} table
              {state.tables.length > 1 ? "s" : ""}
            </div>
          </aside>

          <main className="dbws-main">
            <div className="dbws-tabs">
              {tabs.length === 0 && <div className="console-empty-tab">Aucune table ouverte</div>}
              {tabs.map((t) => (
                <div
                  key={t.id}
                  className={"dbws-tab" + (t.id === activeId ? " active" : "")}
                  onClick={() => onSelectTab(t.id)}
                  onMouseDown={(e) => {
                    // clic molette = fermer l'onglet
                    if (e.button === 1) {
                      e.preventDefault();
                      onCloseTab(t.id);
                    }
                  }}
                  title={t.dirty > 0 ? `${t.label} — ${t.dirty} modification(s) non enregistrée(s)` : t.label}
                >
                  <span className="dbws-tab-name">{t.label}</span>
                  {t.dirty > 0 && <span className="dbws-tab-dot" />}
                  <button
                    className="tab-close"
                    title="Fermer l'onglet"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(t.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="dbws-panel">
              {tabs.length === 0 ? (
                <div className="empty">Sélectionnez une table à gauche pour l'ouvrir.</div>
              ) : (
                children
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
