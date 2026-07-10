import type { ActionDef, Project, Sequence } from "./types";

export const DEFAULT_GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

/** Suggestion affichée quand aucune commande de démarrage n'est définie. */
export const START_COMMAND_PLACEHOLDER = "npm run start   ou   ./startup.sh";

/**
 * Actions fondamentales, non modifiables : toujours présentes, jamais éditables
 * dans les réglages (démarrage / arrêt / git de base + opérations de packages,
 * qui n'ont pas de commande éditable car pilotées par leur `kind`).
 */
export const CORE_ACTIONS: ActionDef[] = [
  { id: "start", label: "Démarrer", command: "", kind: "start" },
  { id: "stop", label: "Arrêter", command: "", kind: "stop" },
  { id: "restart", label: "Redémarrer", command: "", kind: "restart" },
  { id: "git-pull", label: "Git pull", command: "git pull" },
  { id: "git-fetch", label: "Git fetch", command: "git fetch --all --prune" },
  {
    id: "checkout",
    label: "Changer de branche",
    command: "git checkout {branch}",
    needsBranch: true,
  },
  // Actions spécifiques aux packages : modifient le package.json des services.
  {
    id: "link-package",
    label: "Lier aux services (chemin local)",
    command: "",
    kind: "link",
  },
  {
    id: "restore-package",
    label: "Restaurer la version dans les services",
    command: "",
    kind: "restore",
  },
];

/**
 * Actions « commande » modifiables dans les réglages. Semées par défaut dans la
 * config (via `seedActions`) puis éditables / supprimables par l'utilisateur.
 */
export const DEFAULT_ACTIONS: ActionDef[] = [
  { id: "npm-install", label: "npm install", command: "npm install" },
  { id: "npm-ci", label: "npm ci", command: "npm ci" },
  { id: "npm-build", label: "npm run build", command: "npm run build" },
  { id: "test", label: "Lancer les tests (npm run test:sq)", command: "npm run test:sq", kind: "test" },
  { id: "rm-dist", label: "Supprimer dist", command: "rm -rf dist", danger: true },
  {
    id: "rm-node-modules",
    label: "Supprimer node_modules",
    command: "rm -rf node_modules",
    danger: true,
  },
  {
    id: "rm-lock",
    label: "Supprimer package-lock.json",
    command: "rm -f package-lock.json",
    danger: true,
  },
];

/** Base non modifiable utilisée pour fusionner avec les actions de l'utilisateur. */
export const BUILTIN_ACTIONS: ActionDef[] = CORE_ACTIONS;

const DEFAULT_ACTION_IDS = new Set(DEFAULT_ACTIONS.map((a) => a.id));

/**
 * Injecte les actions par défaut dans les actions utilisateur si aucune n'y est
 * déjà présente (migration douce des anciennes configs, où ces actions étaient
 * intégrées). Une fois semées et persistées, l'utilisateur les édite librement.
 */
export function seedActions(custom: ActionDef[]): ActionDef[] {
  return custom.some((a) => DEFAULT_ACTION_IDS.has(a.id)) ? custom : [...DEFAULT_ACTIONS, ...custom];
}

/** Séquences proposées par défaut (modifiables dans les réglages). */
export const DEFAULT_SEQUENCES: Sequence[] = [
  { id: "update", name: "Mise à jour", actionIds: ["git-pull", "npm-install"] },
  {
    id: "clean-install",
    name: "Clean install",
    actionIds: ["rm-node-modules", "rm-lock", "npm-install"],
  },
  {
    id: "full-reset",
    name: "Reset complet",
    actionIds: ["rm-dist", "rm-node-modules", "rm-lock", "git-pull", "npm-install"],
  },
];

export function findAction(id: string): ActionDef | undefined {
  return CORE_ACTIONS.find((a) => a.id === id) ?? DEFAULT_ACTIONS.find((a) => a.id === id);
}

/** Indique si une action a du sens pour un projet donné. */
export function actionAllowed(a: ActionDef, p: Project): boolean {
  if (a.kind === "link" || a.kind === "restore") return p.kind === "package";
  if (a.kind === "start" || a.kind === "stop" || a.kind === "restart")
    return p.start_command != null;
  return true; // actions bash : valables partout
}
