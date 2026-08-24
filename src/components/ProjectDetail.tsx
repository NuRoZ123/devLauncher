import { useState } from "react";
import { buildRepoLinks, repoActions } from "../repo";
import type { Config, DbConnection, GitInfo, Project, ProjectKind } from "../types";

const KINDS: ProjectKind[] = ["service", "front", "package"];
const KIND_LABEL: Record<ProjectKind, string> = {
  service: "Service",
  front: "Front",
  package: "Package",
  fullstack: "Full-stack",
};

interface Props {
  project: Project;
  config: Config;
  git?: GitInfo;
  dbConn?: DbConnection;
  dbDisabled: boolean;
  running: boolean;
  busy?: string;
  onBack: () => void;
  onChangeType: (p: Project, kind: ProjectKind) => void;
  /** null = revient à la commande par défaut. */
  onSaveCommand: (p: Project, cmd: string | null) => void;
  /** null = revient à la détection auto de l'URL. */
  onSaveRepo: (p: Project, url: string | null) => void;
  onStart: (p: Project) => void;
  onStop: (p: Project) => void;
  onEditEnv: (p: Project) => void;
  onOpenUrl: (url: string) => void;
  onDbConfigure: (p: Project) => void;
  onDbOpenTables: (p: Project) => void;
  onDbRetest: (p: Project) => void;
  onToggleDbDisabled: (p: Project, disabled: boolean) => void;
  /** Clés d'actions du menu dépôt masquées pour ce projet. */
  hiddenRepoActions?: string[];
  onToggleRepoAction: (p: Project, key: string, hidden: boolean) => void;
}

/**
 * Page plein écran regroupant tous les paramètres d'un projet : type, commande de
 * démarrage, dépôt git et base de données. Montée avec `key={project.id}` : les
 * brouillons se réinitialisent proprement à chaque projet (ou changement de type).
 */
export function ProjectDetail({
  project,
  config,
  git,
  dbConn,
  dbDisabled,
  running,
  busy,
  onBack,
  onChangeType,
  onSaveCommand,
  onSaveRepo,
  onStart,
  onStop,
  onEditEnv,
  onOpenUrl,
  onDbConfigure,
  onDbOpenTables,
  onDbRetest,
  onToggleDbDisabled,
  hiddenRepoActions,
  onToggleRepoAction,
}: Props) {
  // Sous-projet d'un fullstack (id "fullstack:<projet>:back|front|common") : son
  // type vient de sa place dans le projet, pas d'une source — le reclasser
  // n'aurait aucun effet sur le scan et casserait son id (donc ses réglages).
  const isFullstackChild = project.id.startsWith("fullstack:");
  const cmdOverride = config.command_overrides?.[project.id] ?? "";
  const repoOverride = config.project_links?.[project.id] ?? "";
  const [cmdDraft, setCmdDraft] = useState(cmdOverride);
  const [repoDraft, setRepoDraft] = useState(repoOverride);

  const effectiveUrl = repoOverride || git?.repo_url || "";
  const repoLinks = effectiveUrl ? buildRepoLinks(effectiveUrl, git?.branch) : null;
  const hidden = hiddenRepoActions ?? [];

  return (
    <div className="settings">
      <div className="settings-inner detail">
        <button className="tab-close settings-close" onClick={onBack} title="Retour (Échap)">
          ×
        </button>

        <div className="detail-head">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            ← Retour
          </button>
          <h1 className="detail-title">
            <span className={"dot dot-" + (busy ? "busy" : running ? "run" : "stop")} />
            {project.name}
            <span className={"badge badge-" + project.kind}>{KIND_LABEL[project.kind]}</span>
          </h1>
          <div className="muted detail-path" title={project.path}>
            {project.path}
          </div>
        </div>

        <section className="detail-section">
          <h2>Type</h2>
          {isFullstackChild ? (
            <small className="muted">
              Sous-projet d'un projet full-stack : son type ({KIND_LABEL[project.kind]}) découle de
              sa place dans le projet et n'est pas modifiable ici. Les dossiers back / front se
              règlent sur la source du projet (Réglages → Projets).
            </small>
          ) : (
            <>
              <div className="seg">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    className={"btn btn-sm" + (project.kind === k ? " btn-primary" : "")}
                    onClick={() => onChangeType(project, k)}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
              <small className="muted">
                Reclasse le projet (met à jour sa source). Les réglages liés (commande, lien, base
                de données) sont conservés.
              </small>
            </>
          )}
        </section>

        <section className="detail-section">
          <h2>Démarrage</h2>
          {project.kind === "package" ? (
            <small className="muted">Les packages sont des librairies : pas de démarrage.</small>
          ) : (
            <>
              <label className="field">
                <span>Commande</span>
                <small className="muted">
                  Vide = commande par défaut (<code>{config.start_command || "non définie"}</code>).
                </small>
                <div className="field-row">
                  <input
                    value={cmdDraft}
                    onChange={(e) => setCmdDraft(e.target.value)}
                    placeholder={config.start_command || "npm run start"}
                    onBlur={() => onSaveCommand(project, cmdDraft.trim() || null)}
                    onKeyDown={(e) => {
                      // Entrée = enregistrer tout de suite (sinon il faut sortir
                      // du champ pour que la commande soit prise en compte).
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                  {running ? (
                    <button className="btn btn-stop" onClick={() => onStop(project)}>
                      Arrêter
                    </button>
                  ) : (
                    <button
                      className="btn btn-start"
                      disabled={!project.start_command || !!busy}
                      onClick={() => onStart(project)}
                    >
                      Démarrer
                    </button>
                  )}
                </div>
              </label>
              <div className="detail-meta">
                {project.port != null && <span className="chip">Port {project.port}</span>}
                {project.has_startup && <span className="chip">startup.sh</span>}
                {project.has_package_json && <span className="chip">package.json</span>}
              </div>
              {project.scripts.length > 0 && (
                <small className="muted">Scripts : {project.scripts.join(", ")}</small>
              )}
            </>
          )}
        </section>

        <section className="detail-section">
          <h2>Dépôt git</h2>
          <div className="detail-meta">
            <span className="chip">Branche : {git?.branch ?? "—"}</span>
            <span className="chip">Détecté : {git?.repo_url || "aucun"}</span>
          </div>
          <label className="field">
            <span>Lien manuel</span>
            <small className="muted">Remplace la détection auto. Vide = détection auto.</small>
            <div className="field-row">
              <input
                value={repoDraft}
                onChange={(e) => setRepoDraft(e.target.value)}
                placeholder={git?.repo_url || "https://gitlab.com/groupe/projet"}
                onBlur={() => onSaveRepo(project, repoDraft.trim() || null)}
              />
            </div>
          </label>
          {repoLinks && (
            <>
              <div className="detail-links">
                {repoActions(repoLinks)
                  .filter((a) => a.url && !hidden.includes(a.key))
                  .map((a) => (
                    <button key={a.key} className="btn btn-sm" onClick={() => onOpenUrl(a.url!)}>
                      {a.label}
                    </button>
                  ))}
              </div>
              <div className="detail-toggles">
                <span className="muted">Afficher dans le menu :</span>
                {repoActions(repoLinks)
                  .filter((a) => a.url && a.key !== "home")
                  .map((a) => (
                    <label key={a.key} className="chk-inline">
                      <input
                        type="checkbox"
                        checked={!hidden.includes(a.key)}
                        onChange={(e) => onToggleRepoAction(project, a.key, !e.target.checked)}
                      />
                      <span>{a.label}</span>
                    </label>
                  ))}
              </div>
            </>
          )}
        </section>

        {project.kind === "service" && (
          <section className="detail-section">
            <h2>Base de données</h2>
            <label className="autostart-row">
              <input
                type="checkbox"
                checked={dbDisabled}
                onChange={(e) => onToggleDbDisabled(project, e.target.checked)}
              />
              <span>Sans base de données (masquer le bouton BDD)</span>
            </label>
            {!dbDisabled &&
              (!project.has_env ? (
                <small className="muted">
                  Aucun <code>.env</code> à la racine : la connexion lit ses identifiants dans un
                  .env.
                </small>
              ) : (
                <>
                  <div className="detail-meta">
                    <span className="chip">
                      {dbConn
                        ? dbConn.verified
                          ? "Connectée"
                          : "Non vérifiée"
                        : "Non configurée"}
                    </span>
                  </div>
                  <div className="detail-links">
                    <button className="btn btn-sm" onClick={() => onDbConfigure(project)}>
                      Configurer
                    </button>
                    {dbConn && (
                      <button className="btn btn-sm" onClick={() => onDbRetest(project)}>
                        Re-tester
                      </button>
                    )}
                    {dbConn?.verified && (
                      <button className="btn btn-sm" onClick={() => onDbOpenTables(project)}>
                        Ouvrir les tables
                      </button>
                    )}
                  </div>
                </>
              ))}
          </section>
        )}

        <section className="detail-section">
          <h2>Fichier .env</h2>
          {project.has_env ? (
            <button className="btn btn-sm" onClick={() => onEditEnv(project)}>
              Éditer le .env
            </button>
          ) : (
            <small className="muted">
              Aucun <code>.env</code> à la racine du projet.
            </small>
          )}
        </section>
      </div>
    </div>
  );
}
