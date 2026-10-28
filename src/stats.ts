import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { langForFile } from "./highlight";

/**
 * Statistiques d'usage et badges (page 🏆). Tout est local : stats.json à côté
 * de la config. Les compteurs sont alimentés par les wrappers de `api.ts`
 * (commit, push, requête SQL…) ; le temps est compté par un tick régulier,
 * que la fenêtre soit visible ou non.
 */

export type CounterKey = "services" | "conflicts" | "commits" | "pushes" | "commitsViewed" | "sqlQueries";

export interface Stats {
  v: 1;
  /** Première utilisation suivie (ms epoch). */
  firstSeen: number;
  /** Temps appli ouverte (ms), visible ou non. */
  totalMs: number;
  /** Dont fenêtre au premier plan. */
  focusMs: number;
  /** Temps ouvert par jour ("AAAA-MM-JJ" → ms). */
  days: Record<string, number>;
  longestSessionMs: number;
  /** Temps de service lancé par projet (id → ms). */
  serviceMs: Record<string, number>;
  counters: Record<CounterKey, number>;
  /** Pulls consécutifs sans conflit. */
  pullStreak: number;
  /** Palier atteint par badge (id → date d'obtention de chaque palier). */
  badges: Record<string, number[]>;
  /** Succès uniques obtenus (id → date). */
  uniques: Record<string, number>;
  /** Compteurs par jour ("AAAA-MM-JJ" → compteurs), pour la frise. */
  dayCounts: Record<string, Partial<Record<CounterKey, number>>>;
  /** Langages des fichiers en conflit résolus (succès Polyglotte). */
  conflictLangs: string[];
  /** Dernière ouverture de la page 🏆 (point « nouveau » sur le trophée). */
  seenAt: number;
  /** Notifications de déblocage affichées (réglage). */
  notify: boolean;
}

export const TIERS = ["Bronze", "Argent", "Or", "Platine", "Diamant"] as const;

export interface BadgeDef {
  id: string;
  icon: string;
  name: string;
  desc: string;
  unit: string;
  thresholds: number[];
  value: (s: Stats, ctx: StatsCtx) => number;
}

export interface UniqueDef {
  id: string;
  icon: string;
  name: string;
  desc: string;
}

interface StatsCtx {
  projectCount: number;
}

const H = 3_600_000;

export const BADGES: BadgeDef[] = [
  { id: "launcher", icon: "🚀", name: "Lanceur", desc: "Services démarrés", unit: "services",
    thresholds: [10, 100, 500, 2000, 10000], value: (s) => s.counters.services },
  { id: "resolver", icon: "🧩", name: "Résolveur", desc: "Fichiers en conflit résolus", unit: "conflits",
    thresholds: [1, 10, 50, 200, 1000], value: (s) => s.counters.conflicts },
  { id: "committer", icon: "✍️", name: "Committeur", desc: "Commits faits depuis l'appli", unit: "commits",
    thresholds: [10, 100, 500, 2000, 10000], value: (s) => s.counters.commits },
  { id: "pusher", icon: "📤", name: "Pousseur", desc: "Push réussis", unit: "push",
    thresholds: [10, 100, 500, 2000, 10000], value: (s) => s.counters.pushes },
  { id: "archeologist", icon: "🏺", name: "Archéologue", desc: "Commits ouverts dans l'historique", unit: "commits",
    thresholds: [10, 100, 500, 2000, 10000], value: (s) => s.counters.commitsViewed },
  { id: "querier", icon: "🗄️", name: "Requêteur", desc: "Requêtes SQL exécutées", unit: "requêtes",
    thresholds: [10, 100, 1000, 5000, 20000], value: (s) => s.counters.sqlQueries },
  { id: "endurance", icon: "⏳", name: "Endurant", desc: "Heures d'appli ouverte", unit: "h",
    thresholds: [10, 100, 500, 1000, 5000], value: (s) => Math.floor(s.totalMs / H) },
  { id: "collector", icon: "📚", name: "Collectionneur", desc: "Projets configurés", unit: "projets",
    thresholds: [3, 10, 25, 50, 100], value: (_s, c) => c.projectCount },
];

export const UNIQUES: UniqueDef[] = [
  { id: "nightOwl", icon: "🦉", name: "Oiseau de nuit", desc: "Un commit entre minuit et 5 h" },
  { id: "earlyBird", icon: "🌅", name: "Lève-tôt", desc: "Appli ouverte entre 5 h et 7 h" },
  { id: "fridayPush", icon: "🍻", name: "Vendredi soir", desc: "Un push le vendredi après 18 h" },
  { id: "zeroConflict", icon: "🕊️", name: "Zéro conflit", desc: "50 pulls d'affilée sans conflit" },
  { id: "cleanup", icon: "🧹", name: "Ménage", desc: "Vider une liste « Ne jamais committer »" },
  { id: "marathon", icon: "🏃", name: "Marathon", desc: "Une session de plus de 10 h" },
  { id: "roots", icon: "🌳", name: "Retour aux sources", desc: "Remonter l'historique jusqu'au premier commit" },
  { id: "conductor", icon: "🎼", name: "Chef d'orchestre", desc: "5 services lancés en même temps" },
  { id: "firstConflict", icon: "🩹", name: "Première fois", desc: "Résoudre son premier conflit" },
  { id: "polyglot", icon: "🌐", name: "Polyglotte", desc: "Résoudre des conflits dans 5 langages différents" },
  { id: "faithful", icon: "💍", name: "Fidèle", desc: "Un an après la première utilisation" },
  { id: "noNet", icon: "🎪", name: "Sans filet", desc: "Pousser directement sur la branche par défaut du dépôt" },
];

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function empty(): Stats {
  return {
    v: 1,
    firstSeen: Date.now(),
    totalMs: 0,
    focusMs: 0,
    days: {},
    longestSessionMs: 0,
    serviceMs: {},
    counters: { services: 0, conflicts: 0, commits: 0, pushes: 0, commitsViewed: 0, sqlQueries: 0 },
    pullStreak: 0,
    badges: {},
    uniques: {},
    dayCounts: {},
    conflictLangs: [],
    seenAt: Date.now(),
    notify: true,
  };
}

let stats: Stats = empty();
let loaded = false;
/** Mutations reçues avant le chargement : rejouées ensuite. */
let queue: ((s: Stats) => void)[] = [];
let sessionMs = 0;
let lastTick = Date.now();
let running: string[] = [];
const ctx: StatsCtx = { projectCount: 0 };
const listeners = new Set<() => void>();
const unlockListeners = new Set<(u: Unlock) => void>();

export interface Unlock {
  icon: string;
  title: string;
  tier?: number;
}

function emit() {
  // Nouvelle référence : useSyncExternalStore re-rend les abonnés.
  stats = { ...stats };
  listeners.forEach((l) => l());
}

let saveTimer: number | undefined;
function scheduleSave(delay = 2000) {
  if (!loaded) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke("save_stats", { stats }).catch(() => {});
  }, delay);
}

function mutate(fn: (s: Stats) => void) {
  if (!loaded) {
    queue.push(fn);
    return;
  }
  fn(stats);
  checkBadges();
  emit();
  scheduleSave();
}

function unlockUnique(s: Stats, id: string) {
  if (s.uniques[id]) return;
  s.uniques[id] = Date.now();
  const u = UNIQUES.find((x) => x.id === id);
  if (u) notifyUnlock({ icon: u.icon, title: u.name });
}

function notifyUnlock(u: Unlock) {
  if (stats.notify) unlockListeners.forEach((l) => l(u));
}

/** Incrémente un compteur, au total et pour le jour courant. */
function addCount(s: Stats, key: CounterKey, n = 1) {
  s.counters[key] += n;
  const k = dayKey(new Date());
  const d = (s.dayCounts[k] ??= {});
  d[key] = (d[key] ?? 0) + n;
}

/** Met à jour les paliers atteints ; notifie les nouveaux. */
function checkBadges() {
  for (const b of BADGES) {
    const v = b.value(stats, ctx);
    const got = stats.badges[b.id] ?? [];
    const reached = b.thresholds.filter((t) => v >= t).length;
    if (reached > got.length) {
      const now = Date.now();
      stats.badges[b.id] = [...got, ...Array(reached - got.length).fill(now)];
      notifyUnlock({ icon: b.icon, title: b.name, tier: reached - 1 });
    }
  }
}

export function dayKey(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const j = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${j}`;
}

const TICK = 15_000;
/** Écart au-delà duquel on considère que le PC était en veille (non compté). */
const MAX_GAP = 3 * 60_000;
let ticks = 0;

function tick() {
  const now = Date.now();
  let dt = now - lastTick;
  lastTick = now;
  if (dt <= 0 || dt > MAX_GAP) dt = 0;
  if (!loaded || dt === 0) return;
  const focused = document.visibilityState === "visible" && document.hasFocus();
  sessionMs += dt;
  stats.totalMs += dt;
  if (focused) stats.focusMs += dt;
  const k = dayKey(new Date(now));
  stats.days[k] = (stats.days[k] ?? 0) + dt;
  for (const id of running) stats.serviceMs[id] = (stats.serviceMs[id] ?? 0) + dt;
  if (sessionMs > stats.longestSessionMs) stats.longestSessionMs = sessionMs;
  const h = new Date(now).getHours();
  if (h >= 5 && h < 7) unlockUnique(stats, "earlyBird");
  if (sessionMs >= 10 * H) unlockUnique(stats, "marathon");
  if (now - stats.firstSeen >= 365 * 24 * H) unlockUnique(stats, "faithful");
  checkBadges();
  emit();
  // Écriture disque au plus une fois par minute pour le temps seul.
  if (++ticks % 4 === 0) scheduleSave(0);
}

export async function initStats() {
  try {
    const raw = await invoke<Stats | null>("load_stats");
    if (raw && raw.v === 1) {
      const base = empty();
      stats = { ...base, ...raw, counters: { ...base.counters, ...raw.counters } };
    }
  } catch {
    // Fichier illisible : on repart de zéro plutôt que de bloquer l'appli.
  }
  loaded = true;
  lastTick = Date.now();
  const q = queue;
  queue = [];
  q.forEach((fn) => fn(stats));
  checkBadges();
  emit();
  scheduleSave(0);
  window.setInterval(tick, TICK);
  window.addEventListener("beforeunload", () => {
    tick();
    invoke("save_stats", { stats }).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Événements (appelés par api.ts / App)
// ---------------------------------------------------------------------------

export const track = {
  count(key: CounterKey, n = 1) {
    if (n <= 0) return;
    mutate((s) => addCount(s, key, n));
  },
  /** Fichiers en conflit résolus (Première fois, Polyglotte). */
  conflicts(files: string[]) {
    if (files.length === 0) return;
    mutate((s) => {
      addCount(s, "conflicts", files.length);
      unlockUnique(s, "firstConflict");
      for (const f of files) {
        const lang = langForFile(f);
        if (lang && !s.conflictLangs.includes(lang)) s.conflictLangs = [...s.conflictLangs, lang];
      }
      if (s.conflictLangs.length >= 5) unlockUnique(s, "polyglot");
    });
  },
  commit() {
    mutate((s) => {
      addCount(s, "commits");
      if (new Date().getHours() < 5) unlockUnique(s, "nightOwl");
    });
  },
  push(onDefaultBranch: boolean) {
    mutate((s) => {
      addCount(s, "pushes");
      if (onDefaultBranch) unlockUnique(s, "noNet");
      const d = new Date();
      if (d.getDay() === 5 && d.getHours() >= 18) unlockUnique(s, "fridayPush");
    });
  },
  pull(ok: boolean) {
    mutate((s) => {
      s.pullStreak = ok ? s.pullStreak + 1 : 0;
      if (s.pullStreak >= 50) unlockUnique(s, "zeroConflict");
    });
  },
  reachedRoot() {
    mutate((s) => unlockUnique(s, "roots"));
  },
  cleanup() {
    mutate((s) => unlockUnique(s, "cleanup"));
  },
  /** Services actuellement lancés (pour le temps par projet). */
  setRunning(ids: string[]) {
    running = ids;
    if (ids.length >= 5) mutate((s) => unlockUnique(s, "conductor"));
  },
  setProjectCount(n: number) {
    if (ctx.projectCount === n) return;
    ctx.projectCount = n;
    if (loaded) mutate(() => {});
  },
};

/** Page 🏆 ouverte : plus de point « nouveau » sur le trophée. */
export function markSeen() {
  mutate((s) => {
    s.seenAt = Date.now();
  });
}

export function setNotify(on: boolean) {
  mutate((s) => {
    s.notify = on;
  });
}

/** Un badge ou succès a-t-il été obtenu depuis la dernière visite de la page ? */
export function hasNew(s: Stats) {
  const after = (t: number) => t > s.seenAt;
  return (
    Object.values(s.uniques).some(after) || Object.values(s.badges).some((dates) => dates.some(after))
  );
}

export function onUnlock(cb: (u: Unlock) => void) {
  unlockListeners.add(cb);
  return () => {
    unlockListeners.delete(cb);
  };
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useStats() {
  return useSyncExternalStore(subscribe, () => stats);
}

/** Durée de la session en cours (ms), à jour à la seconde près. */
export function sessionNow() {
  const dt = Date.now() - lastTick;
  return sessionMs + (dt > 0 && dt <= MAX_GAP ? dt : 0);
}

export function badgeValue(b: BadgeDef, s: Stats) {
  return b.value(s, ctx);
}

/** Jours consécutifs d'utilisation jusqu'à aujourd'hui (ou hier). */
export function currentStreak(s: Stats) {
  const d = new Date();
  if (!s.days[dayKey(d)]) d.setDate(d.getDate() - 1);
  let n = 0;
  while (s.days[dayKey(d)]) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function fmtDuration(ms: number, withSeconds = false) {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (withSeconds && h === 0) {
    const sec = Math.floor(ms / 1000) % 60;
    return `${m} min ${String(sec).padStart(2, "0")} s`;
  }
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, "0")}`;
}
