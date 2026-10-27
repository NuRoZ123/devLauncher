// Défilement horizontal (molette de pouce, molette inclinable, Maj+molette).
//
// 1. Faire défiler la bonne zone : l'événement `wheel` est écouté en phase de
//    capture (aucun composant ne peut le masquer) et le défilement est fait ici
//    plutôt que par le navigateur, dont le comportement natif est peu fiable
//    (geste « verrouillé » sur un conteneur en butée, non transmis au parent).
//
// 2. Molette de pouce Logitech (MX Master…) : Logi Options+ fabrique lui-même
//    le défilement horizontal et, sur devLauncher (WebView2), n'envoie le plus
//    souvent RIEN (mesuré : ni molette ni touche, quel que soit le focus ou
//    l'accessibilité). Contournement documenté dans Paramètres > Général : la
//    molette de pouce envoie deux raccourcis (HSCROLL_KEYS), traités ici comme
//    un cran de défilement horizontal de la zone sous la souris.
//
// 3. Confort : un cran (raccourci ou cran de molette) ne saute pas, il glisse
//    vers sa cible (`glide`) ; la distance par cran de la molette de pouce et
//    l'animation se règlent dans Paramètres > Général (`HScrollSettings`).
//
// Diagnostic : Ctrl+Alt+H affiche les événements de molette reçus et les écrit
// dans %TEMP%\devlauncher-hwheel.log.

import { invoke } from "@tauri-apps/api/core";

/** Barres défilant uniquement à l'horizontale : la molette verticale y est
 *  convertie. `data-hwheel` permet d'en ajouter sans toucher à ce fichier. */
const HORIZONTAL_STRIPS = ".console-tabs, .dbws-tabs, [data-hwheel]";
/** Zones gérant elles-mêmes la molette (ex. canevas zoomable du schéma). */
const OWN_WHEEL = "[data-wheel-own]";
/** Raccourcis envoyés par la molette de pouce (Ctrl+Maj+Alt+Windows+←/→,
 *  réglés dans Logi Options+) : touche → sens. */
const HSCROLL_KEYS: Record<string, -1 | 1> = { ArrowLeft: -1, ArrowRight: 1 };
const IN_TAURI = "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------------------
// Réglages (Paramètres > Général), propres au poste : localStorage
// ---------------------------------------------------------------------------

export interface HScrollSettings {
  /** Pixels parcourus par cran de la molette de pouce (raccourci reçu). */
  step: number;
  /** Les crans glissent vers leur cible au lieu de sauter. */
  smooth: boolean;
}

export const HSCROLL_STEP_MIN = 40;
export const HSCROLL_STEP_MAX = 600;
const HSCROLL_STEP_DEFAULT = 200;
const STEP_KEY = "hscroll.step";
const SMOOTH_KEY = "hscroll.smooth";

function clampStep(n: number): number {
  return Math.min(HSCROLL_STEP_MAX, Math.max(HSCROLL_STEP_MIN, Math.round(n)));
}

function loadSettings(): HScrollSettings {
  // Par défaut, pas d'animation si le système demande de réduire les mouvements.
  const out: HScrollSettings = {
    step: HSCROLL_STEP_DEFAULT,
    smooth: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  };
  try {
    const step = Number(localStorage.getItem(STEP_KEY));
    if (step > 0) out.step = clampStep(step);
    const smooth = localStorage.getItem(SMOOTH_KEY);
    if (smooth !== null) out.smooth = smooth === "1";
  } catch {
    /* stockage indisponible : valeurs par défaut */
  }
  return out;
}

let settings = loadSettings();

export function getHScrollSettings(): HScrollSettings {
  return settings;
}

export function setHScrollSettings(patch: Partial<HScrollSettings>) {
  settings = { ...settings, ...patch };
  settings.step = clampStep(settings.step);
  try {
    localStorage.setItem(STEP_KEY, String(settings.step));
    localStorage.setItem(SMOOTH_KEY, settings.smooth ? "1" : "0");
  } catch {
    /* stockage indisponible : réglage valable jusqu'à la fermeture */
  }
}

// ---------------------------------------------------------------------------
// Cœur : faire défiler le bon conteneur
// ---------------------------------------------------------------------------

/** Delta en pixels, quel que soit le `deltaMode`. */
function toPx(delta: number, mode: number, page: number): number {
  if (mode === 1) return delta * 16; // lignes
  if (mode === 2) return delta * page; // pages
  return delta;
}

/** `el` défile-t-il horizontalement (contenu plus large, overflow auto/scroll) ? */
function isXScroller(el: Element): boolean {
  if (el.scrollWidth <= el.clientWidth + 1) return false;
  const ox = getComputedStyle(el).overflowX;
  return ox === "auto" || ox === "scroll";
}

/** `el` peut-il encore défiler horizontalement dans le sens de `px` ? */
function canScrollX(el: Element, px: number): boolean {
  if (!isXScroller(el)) return false;
  const max = el.scrollWidth - el.clientWidth;
  return px < 0 ? el.scrollLeft > 0.5 : el.scrollLeft < max - 0.5;
}

/** Reliquat (fractions de pixel) par conteneur : les molettes haute résolution
 *  envoient des pas que le navigateur arrondirait à zéro. */
const residue = new WeakMap<Element, number>();

/** Glissement en cours par conteneur : position réelle (fractionnaire) et cible. */
interface Glide {
  pos: number;
  target: number;
  /** `scrollLeft` relu après notre dernière écriture : s'il a changé depuis,
   *  quelqu'un d'autre a fait défiler (barre, synchro de volets, clavier). */
  seen: number;
  last: number;
  raf: number;
}
const glides = new WeakMap<Element, Glide>();
/** Constante de temps du glissement : ~63 % du chemin restant parcouru en ce
 *  délai. Court = nerveux, long = mou. */
const GLIDE_TAU_MS = 70;
/** Sans image depuis ce délai, l'animation est considérée comme figée. */
const GLIDE_STALL_MS = 250;
/** En dessous, un delta de molette est un mouvement continu (pavé tactile,
 *  molette haute résolution) : appliqué tel quel, il est déjà fluide. */
const DISCRETE_MIN_PX = 50;

function glideStep(el: Element, g: Glide, now: number) {
  g.raf = 0;
  if (!el.isConnected) {
    glides.delete(el);
    return;
  }
  // Défilé par ailleurs depuis notre dernière écriture : on lui laisse la main.
  if (Math.abs(el.scrollLeft - g.seen) > 1) {
    glides.delete(el);
    return;
  }
  // Basé sur le temps écoulé : même durée quel que soit le rythme d'affichage
  // (après une longue pause, on arrive simplement à la cible).
  const dt = Math.max(8, now - g.last);
  g.last = now;
  g.pos += (g.target - g.pos) * (1 - Math.exp(-dt / GLIDE_TAU_MS));
  if (Math.abs(g.target - g.pos) < 0.5) g.pos = g.target;
  el.scrollLeft = g.pos;
  g.seen = el.scrollLeft;
  // Arrivé, ou bloqué en butée : terminé.
  if (g.pos === g.target || Math.abs(g.seen - g.pos) > 2) {
    glides.delete(el);
    return;
  }
  g.raf = requestAnimationFrame((t) => glideStep(el, g, t));
}

/** Décale la cible de `el` de `px` et l'y fait glisser. Les crans successifs
 *  s'additionnent : tourner vite va plus loin, sans à-coups. */
function glide(el: Element, px: number) {
  const max = el.scrollWidth - el.clientWidth;
  const cur = el.scrollLeft;
  let g = glides.get(el);
  // Plus aucune image livrée (fenêtre masquée, affichage figé) : le défilement
  // ne doit jamais rester bloqué, on termine sans animation.
  if (g?.raf && performance.now() - g.last > GLIDE_STALL_MS) {
    cancelAnimationFrame(g.raf);
    glides.delete(el);
    el.scrollLeft = g.target + px;
    return;
  }
  // Pas de glissement, ou zone déplacée par ailleurs : on repart d'où elle est.
  if (!g || Math.abs(cur - g.seen) > 1) {
    if (g?.raf) cancelAnimationFrame(g.raf);
    g = { pos: cur, target: cur, seen: cur, last: performance.now(), raf: 0 };
    glides.set(el, g);
  }
  const state = g;
  state.target = Math.min(max, Math.max(0, state.target + px));
  if (!state.raf) {
    state.last = performance.now();
    state.raf = requestAnimationFrame((t) => glideStep(el, state, t));
  }
}

/** Fait défiler `el` de `px`. `discrete` : un cran entier (raccourci, cran de
 *  molette), animé si le réglage le demande ; sinon appliqué immédiatement. */
function scrollXBy(el: Element, px: number, discrete: boolean) {
  // Un glissement en cours absorbe tout : deux écritures concurrentes de
  // scrollLeft se contrediraient.
  if (glides.has(el) || (discrete && settings.smooth)) {
    glide(el, px);
    return;
  }
  const want = (residue.get(el) ?? 0) + px;
  const before = el.scrollLeft;
  el.scrollLeft = before + want;
  const moved = el.scrollLeft - before;
  residue.set(el, moved === 0 && Math.abs(want) >= 1 ? 0 : want - moved);
}

/** Un delta de molette est-il un cran entier (à animer) ? */
function isDiscrete(px: number, mode: number): boolean {
  return mode !== 0 || Math.abs(px) >= DISCRETE_MIN_PX;
}

/** Fait défiler horizontalement le premier ancêtre de `from` (inclus) capable
 *  de bouger dans ce sens. Retourne l'élément défilé, ou null. `discrete` :
 *  forcé pour un raccourci, sinon déduit du delta. */
function scrollHorizontally(from: Element, delta: number, mode: number, discrete?: boolean): Element | null {
  for (let el: Element | null = from; el; el = el.parentElement) {
    const px = toPx(delta, mode, el.clientWidth);
    if (canScrollX(el, px)) {
      scrollXBy(el, px, discrete ?? isDiscrete(px, mode));
      return el;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diagnostic (Ctrl+Alt+H)
// ---------------------------------------------------------------------------

const DIAG_KEY = "hwheel.diag";
let diagOn = false;
let diagEl: HTMLDivElement | null = null;
let diagPath = "";
const diagShown: string[] = [];
let diagPending: string[] = [];

function describe(el: Element | null): string {
  if (!el) return "∅";
  const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "";
  return el.tagName.toLowerCase() + cls;
}

function diag(line: string) {
  if (!diagOn) return;
  const full = `${new Date().toLocaleTimeString()} ${line}`;
  diagPending.push(full);
  diagShown.unshift(full);
  diagShown.length = Math.min(diagShown.length, 16);
  if (diagEl)
    diagEl.textContent =
      `Diagnostic molette — Ctrl+Alt+H pour fermer\nJournal : ${diagPath || "(navigateur : pas de fichier)"}\n\n` +
      diagShown.join("\n");
}

function flushDiag() {
  if (!diagPending.length) return;
  const lines = diagPending;
  diagPending = [];
  if (IN_TAURI) void invoke("hwheel_log", { lines }).catch(() => {});
}

/** `reset` : repartir d'un journal vide (activation manuelle uniquement ; une
 *  restauration au démarrage ne doit pas effacer le test précédent). */
async function setDiag(on: boolean, reset: boolean) {
  diagOn = on;
  try {
    localStorage.setItem(DIAG_KEY, on ? "1" : "0");
  } catch {
    /* stockage indisponible : le mode ne sera pas mémorisé */
  }
  if (IN_TAURI) diagPath = await invoke<string>("hwheel_diag", { on, reset }).catch(() => "");
  if (!on) {
    flushDiag();
    diagEl?.remove();
    diagEl = null;
    diagShown.length = 0;
    return;
  }
  if (!diagEl) {
    diagEl = document.createElement("div");
    diagEl.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:99999;max-width:min(640px,96vw);padding:8px 10px;" +
      "background:rgba(0,0,0,.88);color:#9fe8c0;font:11px Consolas,monospace;white-space:pre;overflow:hidden;" +
      "border:1px solid #3a4;border-radius:6px;pointer-events:none";
    document.body.appendChild(diagEl);
  }
  diag(`----- diagnostic actif (${reset ? "nouveau journal" : "repris au démarrage"}) · dpr=${window.devicePixelRatio}`);
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------

function onWheel(e: WheelEvent) {
  if (e.ctrlKey) return; // zoom
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;

  let dx = e.deltaX;
  let dy = e.deltaY;
  // Maj+molette : certains pilotes ne convertissent pas eux-mêmes.
  if (e.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  const horizontal = dx !== 0 && Math.abs(dx) > Math.abs(dy);

  // Zone autonome : elle traite elle-même la molette.
  if (target.closest(OWN_WHEEL)) {
    if (horizontal) diag(`molette dx=${dx.toFixed(1)} → ${describe(target)} (zone autonome)`);
    return;
  }

  if (horizontal) {
    const moved = scrollHorizontally(target, dx, e.deltaMode);
    if (moved) e.preventDefault();
    diag(
      `molette dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} mode=${e.deltaMode}${e.shiftKey ? " maj" : ""} → ` +
        (moved ? `défile ${describe(moved)}` : `rien à défiler sous ${describe(target)}`),
    );
    return;
  }

  // Molette verticale sur une barre d'onglets : défilement horizontal.
  if (dx === 0 && dy !== 0) {
    const strip = target.closest(HORIZONTAL_STRIPS);
    if (strip) {
      const px = toPx(dy, e.deltaMode, strip.clientWidth);
      if (canScrollX(strip, px)) {
        e.preventDefault();
        scrollXBy(strip, px, isDiscrete(px, e.deltaMode));
      }
    }
  }
}

/** Dernière position connue de la souris (coordonnées page) : les raccourcis
 *  de la molette de pouce visent la zone sous la souris, pas le focus. */
let pointer: { x: number; y: number } | null = null;

function onPointerMove(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
}

/** Ctrl+Maj+Alt+Windows+←/→ : un cran de défilement horizontal. */
function onHScrollKey(e: KeyboardEvent): boolean {
  const dir = HSCROLL_KEYS[e.key];
  if (!dir || !e.ctrlKey || !e.shiftKey || !e.altKey || !e.metaKey) return false;
  e.preventDefault();
  e.stopPropagation();
  const target = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null;
  const moved = target ? scrollHorizontally(target, dir * settings.step, 0, true) : null;
  diag(
    `raccourci ${e.key} → ` +
      (!target ? "position de la souris inconnue" : moved ? `défile ${describe(moved)}` : `rien à défiler sous ${describe(target)}`),
  );
  return true;
}

/** À appeler une fois au démarrage. */
export function installWheelHandling() {
  // Capture + non passif : vu avant tout composant, et défilement natif
  // concurrent empêchable.
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  window.addEventListener("pointerdown", onPointerMove, { capture: true, passive: true });
  window.addEventListener(
    "keydown",
    (e) => {
      if (onHScrollKey(e)) return;
      if (e.ctrlKey && e.altKey && !e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        void setDiag(!diagOn, true);
      }
    },
    true,
  );
  window.setInterval(flushDiag, 400);

  let saved = false;
  try {
    saved = localStorage.getItem(DIAG_KEY) === "1";
  } catch {
    /* stockage indisponible */
  }
  if (saved) void setDiag(true, false);
}
