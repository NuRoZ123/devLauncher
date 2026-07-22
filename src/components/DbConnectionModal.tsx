import { useEffect, useMemo, useState } from "react";
import type { DbConnection, DbDriver } from "../types";

export interface DbModalState {
  projectId: string;
  projectName: string;
  /** Valeurs .env résolues (pour le test de connexion et l'aperçu). */
  env: Record<string, string>;
  /** Clés disponibles dans le .env (options des listes déroulantes). */
  keys: string[];
  /** Mapping déjà enregistré pour ce service, ou null. */
  saved: DbConnection | null;
  loading: boolean;
  error?: string;
}

interface Props {
  state: DbModalState;
  /** Enregistre le mapping (clés .env) puis teste la connexion. */
  onConnect: (conn: DbConnection) => Promise<{ ok: boolean; message: string }>;
  onCancel: () => void;
}

type FieldKey = "hostKey" | "portKey" | "userKey" | "passwordKey" | "databaseKey";

const FIELDS: { key: FieldKey; label: string; secret?: boolean }[] = [
  { key: "hostKey", label: "Hôte" },
  { key: "portKey", label: "Port" },
  { key: "userKey", label: "Utilisateur" },
  { key: "passwordKey", label: "Mot de passe", secret: true },
  { key: "databaseKey", label: "Base de données" },
];

/** Mapping vide : les clés sont choisies manuellement. */
function emptyConn(driver: DbDriver): DbConnection {
  return {
    driver,
    hostKey: "",
    portKey: "",
    userKey: "",
    passwordKey: "",
    databaseKey: "",
  };
}

export function DbConnectionModal({ state, onConnect, onCancel }: Props) {
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [status, setStatus] = useState<
    { phase: "idle" | "connecting" | "ok" | "err"; message?: string }
  >({ phase: "idle" });

  // Initialise le formulaire dès que le .env est chargé : mapping déjà
  // enregistré si présent, sinon champs vides (saisie manuelle).
  useEffect(() => {
    if (state.loading) return;
    setConn((cur) => cur ?? state.saved ?? emptyConn("mariadb"));
  }, [state.loading, state.saved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const preview = useMemo(() => {
    const p: Record<string, string> = {};
    if (conn) {
      for (const f of FIELDS) {
        const key = conn[f.key];
        p[f.key] = key ? state.env[key] ?? "" : "";
      }
    }
    return p;
  }, [conn, state.env]);

  const setField = (key: FieldKey, value: string) => {
    setConn((c) => (c ? { ...c, [key]: value } : c));
    setStatus({ phase: "idle" });
  };
  const setDriver = (driver: DbDriver) => {
    setConn((c) => (c ? { ...c, driver } : c));
    setStatus({ phase: "idle" });
  };

  const missing = conn
    ? FIELDS.filter((f) => f.key !== "passwordKey" && !conn[f.key]).map((f) => f.label)
    : [];
  const canConnect = !!conn && missing.length === 0 && status.phase !== "connecting";

  async function connect() {
    if (!conn) return;
    setStatus({ phase: "connecting" });
    const res = await onConnect(conn);
    // Succès → la modale se ferme (le résultat est journalisé côté service).
    if (res.ok) {
      onCancel();
      return;
    }
    setStatus({ phase: "err", message: res.message });
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal modal-db" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Connexion base de données</h3>
          <button className="tab-close" onClick={onCancel} title="Fermer">
            ×
          </button>
        </div>

        <div className="modal-sub">
          <span className="muted">{state.projectName}</span>
          {state.saved &&
            (state.saved.verified ? (
              <span className="chip chip-db-ok">✓ connectée</span>
            ) : (
              <span className="chip chip-db-warn">non vérifiée</span>
            ))}
        </div>

        {state.error && <div className="banner-error">{state.error}</div>}

        {state.loading || !conn ? (
          <div className="branch-loading">
            <span className="spinner" /> Lecture du .env…
          </div>
        ) : (
          <>
            <div className="db-drivers">
              <button
                className={"db-driver" + (conn.driver === "mariadb" ? " on" : "")}
                onClick={() => setDriver("mariadb")}
              >
                MariaDB / MySQL
              </button>
              <button
                className={"db-driver" + (conn.driver === "postgres" ? " on" : "")}
                onClick={() => setDriver("postgres")}
              >
                PostgreSQL
              </button>
            </div>

            {state.keys.length === 0 && (
              <div className="db-hint muted">
                Aucune variable trouvée dans le .env de ce service.
              </div>
            )}

            <div className="db-fields">
              {FIELDS.map((f) => (
                <label className="db-field" key={f.key}>
                  <span className="db-field-label">{f.label}</span>
                  <select
                    value={conn[f.key]}
                    onChange={(e) => setField(f.key, e.target.value)}
                  >
                    <option value="">— clé .env —</option>
                    {state.keys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <span className="db-field-preview muted" title={f.secret ? "" : preview[f.key]}>
                    {conn[f.key]
                      ? f.secret
                        ? preview[f.key]
                          ? "••••••"
                          : "(vide)"
                        : preview[f.key] || "(vide)"
                      : ""}
                  </span>
                </label>
              ))}
            </div>

            <div className="db-hint muted">
              Seuls les <strong>noms de clés</strong> .env sont enregistrés — aucun identifiant
              n'est stocké. La connexion est relue depuis le .env à la réouverture.
            </div>

            {status.phase === "ok" && (
              <div className="banner-ok">✓ Connecté — {status.message}</div>
            )}
            {status.phase === "err" && <div className="banner-error">{status.message}</div>}
          </>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>
            Fermer
          </button>
          <button
            className="btn btn-primary"
            disabled={!canConnect}
            onClick={connect}
            title={missing.length ? `Champs requis : ${missing.join(", ")}` : ""}
          >
            {status.phase === "connecting" ? (
              <span className="spinner spinner-xs" />
            ) : (
              "Se connecter"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
