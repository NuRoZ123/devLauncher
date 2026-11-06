// Raccourcis clavier personnalisables (« macros ») : chaque fonctionnalité de
// l'application peut recevoir une combinaison de touches depuis Réglages →
// Raccourcis. Stockés dans la config : id d'action → combinaison ("Ctrl+Shift+S").
import { actionAllowed } from "./constants";
import { hasServiceUrl } from "./serviceUrl";
import type { ActionDef, Project, Sequence } from "./types";

export type AppCmd =
  | "startAll"
  | "stopAll"
  | "restartAll"
  | "freePorts"
  | "rescan"
  | "jobs"
  | "settings"
  | "stats"
  | "dashboard"
  | "projectsPanel"
  | "consoleNew"
  | "consoleNext"
  | "consolePrev"
  | "consoleClose";

export type ProjCmd =
  | "start"
  | "stop"
  | "toggle"
  | "console"
  | "commands"
  | "newConsole"
  | "git"
  | "db"
  | "detail"
  | "openUrl";

/** Ce que déclenche un raccourci (interprété par App). */
export type BindTarget =
  | { t: "app"; cmd: AppCmd }
  | { t: "gseq"; seqId: string }
  | { t: "proj"; pid: string; cmd: ProjCmd }
  | { t: "projAction"; pid: string; actionId: string }
  | { t: "projSeq"; pid: string; seqId: string };

export interface Bindable {
  /** Clé stable stockée dans config.keybindings. */
  id: string;
  label: string;
  /** Regroupement affiché (catégorie ou projet). */
  group: string;
  groupLabel: string;
  target: BindTarget;
}

const APP_CMDS: { cmd: AppCmd; label: string }[] = [
  { cmd: "startAll", label: "▶ Tout démarrer" },
  { cmd: "stopAll", label: "■ Tout arrêter" },
  { cmd: "restartAll", label: "⟳ Tout redémarrer" },
  { cmd: "freePorts", label: "⚠ Libérer tous les ports" },
  { cmd: "rescan", label: "↻ Re-scanner les projets" },
  { cmd: "jobs", label: "≡ Afficher / masquer les tâches" },
  { cmd: "settings", label: "⚙ Ouvrir / fermer les réglages" },
  { cmd: "stats", label: "🏆 Ouvrir / fermer les stats" },
  { cmd: "dashboard", label: "⌂ Revenir au tableau de bord" },
  { cmd: "projectsPanel", label: "◧ Afficher / masquer la liste des projets" },
  { cmd: "consoleNew", label: "＋ Nouvelle console (projet affiché)" },
  { cmd: "consoleNext", label: "⇥ Console suivante (projet affiché)" },
  { cmd: "consolePrev", label: "⇤ Console précédente (projet affiché)" },
  { cmd: "consoleClose", label: "✕ Fermer la console affichée" },
];

/** Liste de tout ce qui peut recevoir un raccourci, dans l'ordre d'affichage. */
export function buildBindables(
  projects: Project[],
  actions: ActionDef[],
  sequences: Sequence[],
  dbConnected: (pid: string) => boolean,
): Bindable[] {
  const out: Bindable[] = APP_CMDS.map(({ cmd, label }) => ({
    id: `app|${cmd}`,
    label,
    group: "app",
    groupLabel: "Général",
    target: { t: "app", cmd },
  }));

  for (const s of sequences.filter((s) => s.global)) {
    out.push({
      id: `gseq|${s.id}`,
      label: `⛓ ${s.name}`,
      group: "gseq",
      groupLabel: "Séquences générales",
      target: { t: "gseq", seqId: s.id },
    });
  }

  const projSeqs = sequences.filter((s) => !s.global);
  const projActions = actions.filter(
    (a) => !a.hidden && a.kind !== "start" && a.kind !== "stop",
  );
  for (const p of projects) {
    const group = `p|${p.id}`;
    const add = (key: string, label: string, target: BindTarget) =>
      out.push({ id: `${group}|${key}`, label, group, groupLabel: p.name, target });
    const isStack = p.kind === "fullstack";
    if (p.start_command || isStack) {
      add("start", "▶ Démarrer", { t: "proj", pid: p.id, cmd: "start" });
      add("stop", "■ Arrêter", { t: "proj", pid: p.id, cmd: "stop" });
      add("toggle", "⏯ Démarrer / arrêter", { t: "proj", pid: p.id, cmd: "toggle" });
    }
    if (isStack) {
      add("git", "⎇ Changements git", { t: "proj", pid: p.id, cmd: "git" });
      continue; // parent purement structurel : le reste se fait sur les sous-projets
    }
    add("console", "▤ Console de lancement", { t: "proj", pid: p.id, cmd: "console" });
    add("commands", "⌨ Console « Commandes »", { t: "proj", pid: p.id, cmd: "commands" });
    add("newConsole", "＋ Nouvelle console", { t: "proj", pid: p.id, cmd: "newConsole" });
    add("detail", "ⓘ Fiche du projet", { t: "proj", pid: p.id, cmd: "detail" });
    if (hasServiceUrl(p)) {
      add("openUrl", `🌐 Ouvrir l'URL (localhost:${p.port})`, { t: "proj", pid: p.id, cmd: "openUrl" });
    }
    add("git", "⎇ Changements git", { t: "proj", pid: p.id, cmd: "git" });
    if (dbConnected(p.id)) add("db", "🗄 Base de données", { t: "proj", pid: p.id, cmd: "db" });
    for (const a of projActions.filter((a) => actionAllowed(a, p))) {
      add(`a|${a.id}`, a.label, { t: "projAction", pid: p.id, actionId: a.id });
    }
    for (const s of projSeqs) {
      add(`s|${s.id}`, `⛓ ${s.name}`, { t: "projSeq", pid: p.id, seqId: s.id });
    }
  }
  return out;
}

const MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"]);

const KEY_NAMES: Record<string, string> = {
  " ": "Espace",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Échap",
  Enter: "Entrée",
  Backspace: "Retour",
  Delete: "Suppr",
};

/** Combinaison normalisée d'un événement clavier, null pour une touche seule de modification. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Maj");
  if (e.metaKey) parts.push("Win");
  const k = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(k);
  return parts.join("+");
}

/** Touches d'une combinaison, pour l'affichage en « keycaps ». */
export function comboKeys(combo: string): string[] {
  // "Ctrl++" : la touche « + » elle-même.
  return combo.endsWith("++") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
}

/** Raccourcis déjà utilisés par l'application : non attribuables. */
export const RESERVED: { combo: string; label: string }[] = [
  { combo: "Échap", label: "Fermer la vue / le panneau courant" },
  { combo: "Ctrl+C", label: "Copier" },
  { combo: "Ctrl+X", label: "Couper" },
  { combo: "Ctrl+V", label: "Coller" },
  { combo: "Ctrl+A", label: "Tout sélectionner" },
  { combo: "Ctrl+Z", label: "Annuler (champs de saisie)" },
  { combo: "Ctrl+S", label: "Enregistrer les modifications (table BDD, éditeur SQL)" },
  { combo: "Ctrl+Entrée", label: "Exécuter la requête SQL / committer" },
  { combo: "Ctrl+Alt+Entrée", label: "Committer et pousser" },
  { combo: "Tab", label: "Vue fiche (table BDD) / indentation" },
  { combo: "Entrée", label: "Valider une saisie" },
  { combo: "Alt+↑", label: "Différence précédente (diff / fusion)" },
  { combo: "Alt+↓", label: "Différence suivante (diff / fusion)" },
  { combo: "Ctrl+Maj+Alt+Win+←", label: "Défilement horizontal (molette Logitech)" },
  { combo: "Ctrl+Maj+Alt+Win+→", label: "Défilement horizontal (molette Logitech)" },
];
const RESERVED_SET = new Set(RESERVED.map((r) => r.combo));
export const isReserved = (combo: string) => RESERVED_SET.has(combo);

/** Vrai si le focus est dans une zone de saisie (les touches simples y restent du texte). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable
  );
}

/** Une combinaison « forte » (Ctrl/Alt/Win ou touche F) agit même pendant la saisie. */
export function isStrongCombo(combo: string): boolean {
  const keys = comboKeys(combo);
  const key = keys[keys.length - 1];
  return keys.some((k) => k === "Ctrl" || k === "Alt" || k === "Win") || /^F\d{1,2}$/.test(key);
}

// Capture en cours dans les réglages : le déclencheur global se met en pause.
let capturing = false;
export const setCapturing = (v: boolean) => {
  capturing = v;
};
export const isCapturing = () => capturing;
