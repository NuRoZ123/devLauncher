# DevLauncher

Launcher desktop (Tauri 2 + React + TypeScript) pour piloter une architecture
locale de micro-services : démarrage/arrêt des services, logs en direct, état
git, et actions/séquences (npm i, git pull, nettoyage…).

Thème **dark**, binaire léger (WebView2 natif de Windows).

## Fonctionnalités

- **Détection auto** des projets sous la racine choisie :
  - `services/*` → chaque dossier est une API
  - `portail-occupant/` → le front
  - `packages/*` → librairies (affichées, sans démarrage)
- **Commande de démarrage** : tous les projets démarrables utilisent la
  commande par défaut configurée (ex. `npm run start`, `./startup.sh`), avec
  possibilité d'**exceptions par projet** (un service ou le front peut avoir
  sa propre commande).
- **Start / Stop** par projet, ou **Tout démarrer / Tout arrêter**.
- **Consoles à onglets** : logs `stdout`/`stderr` en temps réel par service.
- **État git** par projet : branche courante + nombre de modifications.
- **Changement de branche** depuis l'UI.
- **Actions** unitaires : git pull / fetch, checkout, npm install / ci,
  suppression `dist` / `node_modules` / `package-lock.json`.
- **Séquences** : enchaînements ordonnés d'actions (ex. _Clean install_,
  _Reset complet_), éditables dans les Réglages. Une séquence s'arrête si une
  action échoue.
- Toutes les commandes passent par **Git Bash** sans ouvrir de fenêtre externe.

## Prérequis (déjà installés sur ce poste)

- Node.js + npm
- Rust (toolchain `x86_64-pc-windows-gnu`)
- MinGW-w64 (WinLibs MSVCRT) — fournit `gcc` / `dlltool` / `ld`
- Git for Windows (Git Bash)

> ⚠️ Le projet est sous `OneDrive - SNCF\Bureau` (chemin avec espaces). La
> toolchain GNU n'aime pas les espaces : `src-tauri/.cargo/config.toml` déporte
> donc le dossier `target` vers `C:\dev\dl-target`. Ne pas supprimer ce fichier.

## Lancer en développement

```powershell
# Depuis le dossier du projet
./dev.ps1
# ou directement :
npm run tauri dev
```

Au **premier démarrage**, l'app demande :
1. le **dossier racine** des projets (celui qui contient `services/`,
   `packages/`, `portail-occupant/`) ;
2. le **chemin de Git Bash** (par défaut `C:\Program Files\Git\bin\bash.exe`) ;
3. la **commande de démarrage par défaut** (ex. `npm run start`,
   `./startup.sh`). Si une config existante n'en a pas, cet écran réapparaît
   pré-rempli pour la demander.

La config est enregistrée dans le dossier de config de l'app et modifiable via
le bouton **⚙ Réglages** (y compris les exceptions par projet). Raccourcis :
**clic droit** sur « Tout démarrer » → commande par défaut ; **clic droit** sur
le « Démarrer » d'un projet → exception propre à ce projet.

## Construire un exécutable

```powershell
npm run tauri build
```

Le binaire et l'installeur sont générés sous `C:\dev\dl-target\release\`.

## Structure

```
src/                  Front React + TypeScript
  components/         Setup, Console, ProjectRow, SequenceManager
  api.ts             Pont vers les commandes Tauri
  App.tsx            Orchestration (scan, logs, start/stop, séquences)
src-tauri/
  src/lib.rs         Backend Rust : scan, git, process, logs, actions
  tauri.conf.json    Config Tauri
  .cargo/config.toml Déport du dossier target (chemin sans espaces)
```
