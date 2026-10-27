import { useEffect, useState } from "react";
import { pickBashExe } from "../api";
import { DEFAULT_GIT_BASH, START_COMMAND_PLACEHOLDER } from "../constants";
import { GitPathInput } from "./GitPathField";
import { ProjectSources } from "./ProjectSources";
import { api } from "../api";
import type { ProjectSource } from "../types";

interface Props {
  initialSources?: ProjectSource[];
  initialBash?: string;
  initialGit?: string;
  initialCommand?: string;
  onSubmit: (sources: ProjectSource[], bash: string, git: string, startCommand: string) => void;
}

export function Setup({
  initialSources = [],
  initialBash = DEFAULT_GIT_BASH,
  initialGit = "",
  initialCommand = "",
  onSubmit,
}: Props) {
  const [sources, setSources] = useState<ProjectSource[]>(initialSources);
  const [bash, setBash] = useState(initialBash);
  const [git, setGit] = useState(initialGit);
  const [command, setCommand] = useState(initialCommand);

  // Pré-remplit git.exe avec celui détecté à côté de Git Bash (ou dans le PATH).
  useEffect(() => {
    if (initialGit) return;
    api
      .suggestGitPath(initialBash)
      .then((p) => p && setGit((g) => g || p))
      .catch(() => {});
  }, [initialGit, initialBash]);

  const valid =
    sources.length > 0 && bash.trim().length > 0 && git.trim().length > 0 && command.trim().length > 0;

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-logo">⚡</div>
        <h1>DevLauncher</h1>
        <p className="muted">
          Première configuration. Déclarez vos projets, indiquez l'emplacement de Git Bash, de git et la
          commande de démarrage des services.
        </p>

        <label className="field">
          <span>Projets</span>
          <small className="muted">
            Ajoutez un <b>projet</b> (un dossier = un projet), ou un <b>dossier parent</b> dont
            chaque sous-dossier devient un projet à typer (Service, Front ou Package).
          </small>
          <ProjectSources sources={sources} onChange={setSources} />
        </label>

        <label className="field">
          <span>Chemin de Git Bash</span>
          <small className="muted">
            Les services et les actions passent par ce bash, sans ouvrir de fenêtre externe.
          </small>
          <div className="field-row">
            <input
              value={bash}
              onChange={(e) => setBash(e.target.value)}
              placeholder={DEFAULT_GIT_BASH}
            />
            <button
              className="btn"
              onClick={async () => {
                const p = await pickBashExe();
                if (p) setBash(p);
              }}
            >
              Parcourir…
            </button>
          </div>
        </label>

        <label className="field">
          <span>Chemin de git.exe</span>
          <small className="muted">
            Utilisé directement (sans Git Bash) par les fonctions git : branches, modifications,
            commit, push/pull, résolution de conflits. Nettement plus rapide.
          </small>
          <GitPathInput value={git} onChange={setGit} bash={bash} />
        </label>

        <label className="field">
          <span>Commande de démarrage des services</span>
          <small className="muted">
            Exécutée dans le dossier de chaque service au clic sur « Démarrer ».
            Modifiable ensuite dans ⚙ Réglages ou par clic droit sur les boutons de démarrage.
          </small>
          <div className="field-row">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={START_COMMAND_PLACEHOLDER}
            />
          </div>
        </label>

        <button
          className="btn btn-primary btn-block"
          disabled={!valid}
          onClick={() => onSubmit(sources, bash.trim(), git.trim(), command.trim())}
        >
          Démarrer
        </button>
      </div>
    </div>
  );
}
