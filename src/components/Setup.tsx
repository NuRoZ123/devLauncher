import { useState } from "react";
import { pickBashExe, pickFolder } from "../api";
import { DEFAULT_GIT_BASH, START_COMMAND_PLACEHOLDER } from "../constants";

interface Props {
  initialRoot?: string;
  initialBash?: string;
  initialCommand?: string;
  onSubmit: (root: string, bash: string, startCommand: string) => void;
}

export function Setup({
  initialRoot = "",
  initialBash = DEFAULT_GIT_BASH,
  initialCommand = "",
  onSubmit,
}: Props) {
  const [root, setRoot] = useState(initialRoot);
  const [bash, setBash] = useState(initialBash);
  const [command, setCommand] = useState(initialCommand);

  const valid = root.trim().length > 0 && bash.trim().length > 0 && command.trim().length > 0;

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-logo">⚡</div>
        <h1>DevLauncher</h1>
        <p className="muted">
          Première configuration. Indiquez la racine de votre architecture,
          l'emplacement de Git Bash et la commande de démarrage des services.
        </p>

        <label className="field">
          <span>Dossier racine des projets</span>
          <small className="muted">
            Le dossier qui contient <code>services/</code>, <code>packages/</code> et{" "}
            <code>portail-occupant/</code>
          </small>
          <div className="field-row">
            <input
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="C:\dev\mon-archi"
            />
            <button
              className="btn"
              onClick={async () => {
                const p = await pickFolder("Choisir la racine des projets");
                if (p) setRoot(p);
              }}
            >
              Parcourir…
            </button>
          </div>
        </label>

        <label className="field">
          <span>Chemin de Git Bash</span>
          <small className="muted">
            Toutes les commandes passent par ce bash, sans ouvrir de fenêtre externe.
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
          onClick={() => onSubmit(root.trim(), bash.trim(), command.trim())}
        >
          Démarrer
        </button>
      </div>
    </div>
  );
}
