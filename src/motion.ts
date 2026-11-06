// Animations d'apparition / disparition, centralisées.
//
// Plutôt que d'équiper chaque composant d'un état « en cours de fermeture »,
// un MutationObserver unique surveille le DOM :
//  - apparition : un élément ciblé (voir RULES) est inséré, ou ré-affiché
//    (display:none → visible) → animation d'entrée (Web Animations API) ;
//  - disparition : React retire un élément ciblé → un « fantôme » (clone inerte,
//    pointer-events:none) est réinséré à sa place le temps de l'animation de
//    sortie, puis supprimé. React ne connaît pas le fantôme et n'y touche pas.
// Le callback de l'observateur tourne en microtâche, avant le rendu : aucun
// clignotement. Durée réglable (Réglages → Général), 0 = aucune animation ;
// réglage propre au poste (localStorage), comme la molette horizontale.

type Kind =
  | "fade" // voile de fond
  | "pop" // boîte modale
  | "menu" // menu contextuel, liste déroulante, popover
  | "drawer" // panneau latéral (file des tâches)
  | "toast" // notification
  | "view" // page / onglet qui s'affiche (entrée seulement)
  | "collapse" // bloc dépliable : hauteur 0 ↔ hauteur réelle
  | "collapse-x"; // onglet : largeur 0 ↔ largeur réelle

interface Rule {
  sel: string;
  kind: Kind;
  /** Animé aussi quand il arrive DANS un bloc inséré (sinon : seulement s'il est lui-même le nœud inséré). */
  nested?: boolean;
  /** Animation de sortie (fantôme) au retrait. */
  exit?: boolean;
  /** Suit aussi les bascules display:none ↔ visible de l'attribut style. */
  toggle?: boolean;
}

const RULES: Rule[] = [
  // Superpositions
  { sel: ".modal-backdrop, .dbws-backdrop", kind: "fade", nested: true, exit: true, toggle: true },
  { sel: ".modal, .dbws", kind: "pop", nested: true, exit: true },
  {
    sel: ".context-menu, .context-submenu, .dropdown-menu, .gc-menu, .colorpick-pop",
    kind: "menu",
    nested: true,
    exit: true,
  },
  { sel: ".taskq", kind: "drawer", nested: true, exit: true },
  { sel: ".stats-toast, .kb-notice, .follow-btn", kind: "toast", nested: true, exit: true },
  // Blocs dépliables et bandeaux (dans le flux : la place s'ouvre / se referme)
  {
    sel: [
      ".update-banner",
      ".banner-error",
      ".banner-ok",
      ".field-error",
      ".folder-body",
      ".folder-empty",
      ".project-row-nested",
      ".menu-items",
      ".kb-rows",
      ".gc-commits",
      ".gc-list",
      ".gc-output",
      ".gh-file-list",
      ".subdirs",
      ".fullstack-dirs",
      ".dbdata-selbar",
      ".dbdata-savebar",
    ].join(", "),
    kind: "collapse",
    exit: true,
  },
  // Liste des projets masquée / ré-affichée (« et »») : display:none ↔ visible.
  { sel: ".projects", kind: "collapse-x", exit: true, toggle: true },
  // Onglets de la console
  { sel: ".console-tab", kind: "collapse-x", exit: true },
  // Sous-onglets : entrée seulement (le renommage remplace l'onglet par un champ).
  { sel: ".console-subtab", kind: "collapse-x" },
  // Pages et onglets
  { sel: ".settings, .stats-page, .main, .gh, .settings-inner > :not(.settings-close):not(.settings-tabs)", kind: "view" },
  { sel: ".dbws-tabpanel, .dbsub-panel", kind: "view", toggle: true },
];

/** Durée relative de chaque type (× durée réglée). */
const SCALE: Record<Kind, number> = {
  fade: 1,
  pop: 1,
  menu: 1,
  drawer: 1.1,
  toast: 1.2,
  view: 1,
  collapse: 1,
  "collapse-x": 1,
};

const STORE_KEY = "dl-motion-ms";
export const MOTION_DEFAULT_MS = 180;
export const MOTION_MAX_MS = 600;
/** Au-delà, pas de fantôme : cloner un énorme sous-arbre coûterait plus qu'il ne rapporte. */
const GHOST_MAX_NODES = 6000;
const GHOST_CLASS = "motion-ghost";

let durationMs = load();
const listeners = new Set<(ms: number) => void>();

function load(): number {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw !== null && raw !== "") return clamp(Number(raw));
  } catch {
    /* stockage indisponible */
  }
  // Pas de choix explicite : on respecte la préférence système « réduire les animations ».
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : MOTION_DEFAULT_MS;
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(MOTION_MAX_MS, Math.round(n))) : MOTION_DEFAULT_MS;
}

function applyRoot() {
  const root = document.documentElement;
  root.style.setProperty("--motion-ms", `${durationMs}ms`);
  root.classList.toggle("no-motion", durationMs === 0);
}

export function getMotionDuration(): number {
  return durationMs;
}

export function setMotionDuration(ms: number) {
  durationMs = clamp(ms);
  try {
    localStorage.setItem(STORE_KEY, String(durationMs));
  } catch {
    /* réglage valable jusqu'à la fermeture */
  }
  applyRoot();
  listeners.forEach((l) => l(durationMs));
}

export function onMotionChange(l: (ms: number) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ---------------------------------------------------------------------------
// Images clés
// ---------------------------------------------------------------------------

const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

function frames(kind: Kind, el: HTMLElement): Keyframe[] {
  switch (kind) {
    case "fade":
      return [{ opacity: 0 }, { opacity: 1 }];
    case "pop":
      return [
        { opacity: 0, transform: "translateY(8px) scale(0.97)" },
        { opacity: 1, transform: "none" },
      ];
    case "menu":
      // Déploiement depuis le coin d'ancrage (curseur / bouton) : bien perceptible.
      return [
        { opacity: 0, transform: "translateY(-8px) scale(0.9)", transformOrigin: "top left" },
        { opacity: 1, transform: "none", transformOrigin: "top left" },
      ];
    case "drawer":
      return [
        { opacity: 0, transform: "translateX(40px)" },
        { opacity: 1, transform: "none" },
      ];
    case "toast":
      return [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "none" },
      ];
    case "view":
      return [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ];
    case "collapse":
    case "collapse-x": {
      const x = kind === "collapse-x";
      const cs = getComputedStyle(el);
      const size = x ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
      const [a, b] = x ? ["Left", "Right"] : ["Top", "Bottom"];
      const dim = x ? "width" : "height";
      const open: Keyframe = {
        opacity: 1,
        [dim]: `${size}px`,
        [`padding${a}`]: cs.getPropertyValue(`padding-${a.toLowerCase()}`),
        [`padding${b}`]: cs.getPropertyValue(`padding-${b.toLowerCase()}`),
        [`margin${a}`]: cs.getPropertyValue(`margin-${a.toLowerCase()}`),
        [`margin${b}`]: cs.getPropertyValue(`margin-${b.toLowerCase()}`),
      };
      const shut: Keyframe = {
        opacity: 0,
        [dim]: "0px",
        [`padding${a}`]: "0px",
        [`padding${b}`]: "0px",
        [`margin${a}`]: "0px",
        [`margin${b}`]: "0px",
      };
      return [shut, open];
    }
  }
}

function play(el: HTMLElement, kind: Kind, out: boolean): Animation | null {
  if (durationMs === 0 || typeof el.animate !== "function") return null;
  const collapse = kind === "collapse" || kind === "collapse-x";
  // Un bloc vide (0 px) ou non affiché n'a rien à animer.
  if (collapse && el.getClientRects().length === 0) return null;
  let kf = frames(kind, el);
  if (out) kf = [...kf].reverse();
  const dur = durationMs * SCALE[kind] * (out ? 0.8 : 1);
  let restore: (() => void) | null = null;
  if (collapse) {
    // Pendant l'animation : contenu rogné, taille comptée bord compris, pas de
    // rétrécissement imposé par un parent flex.
    const s = el.style;
    const prev = [s.overflow, s.boxSizing, s.flexShrink, s.minHeight, s.minWidth];
    s.overflow = "hidden";
    s.boxSizing = "border-box";
    s.flexShrink = "0";
    if (kind === "collapse") s.minHeight = "0";
    else s.minWidth = "0";
    restore = () => {
      [s.overflow, s.boxSizing, s.flexShrink, s.minHeight, s.minWidth] = prev;
    };
  }
  const anim = el.animate(kf, { duration: dur, easing: out ? EASE_IN : EASE_OUT, fill: out ? "forwards" : "none" });
  if (restore) {
    const r = restore;
    anim.finished.then(r, r);
  }
  return anim;
}

// ---------------------------------------------------------------------------
// Observateur
// ---------------------------------------------------------------------------

/** Zones à très fort débit de mutations (logs, canevas) : ignorées d'emblée. */
const SKIP_WITHIN = ".console-body, .mv-canvas";

const NESTED_SEL = RULES.filter((r) => r.nested).map((r) => r.sel).join(", ");
const TOGGLE_SEL = RULES.filter((r) => r.toggle).map((r) => r.sel).join(", ");

function ruleFor(el: Element, pred?: (r: Rule) => boolean): Rule | undefined {
  return RULES.find((r) => (!pred || pred(r)) && el.matches(r.sel));
}

function isGhost(n: Node): boolean {
  return n instanceof Element && !!n.closest("." + GHOST_CLASS);
}

/** Entrée de `root` et des éléments « nested » qu'il contient. */
function enter(root: HTMLElement, self: Rule | undefined) {
  // Monté déjà masqué (onglet en arrière-plan) : l'animation viendra à l'affichage.
  if (root.style.display === "none") return;
  if (self) play(root, self.kind, false);
  if (!NESTED_SEL) return;
  root.querySelectorAll<HTMLElement>(NESTED_SEL).forEach((el) => {
    const r = ruleFor(el, (x) => !!x.nested);
    if (r) play(el, r.kind, false);
  });
}

/**
 * Fantôme de sortie : clone inerte réinséré à la place de l'élément retiré (ou
 * masqué), animé puis supprimé. `hiddenToggle` : l'original est encore là mais
 * en display:none — le clone doit, lui, rester visible.
 */
function ghostExit(node: HTMLElement, rule: Rule, parent: Node, next: Node | null, hiddenToggle = false) {
  if (durationMs === 0 || !parent.isConnected) return;
  if (node.getElementsByTagName("*").length > GHOST_MAX_NODES) return;
  const g = node.cloneNode(true) as HTMLElement;
  g.classList.add(GHOST_CLASS);
  g.setAttribute("aria-hidden", "true");
  g.inert = true;
  g.style.pointerEvents = "none";
  if (hiddenToggle) g.style.display = "";
  g.removeAttribute("id");
  g.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
  parent.insertBefore(g, next && next.parentNode === parent ? next : null);

  const anims: Animation[] = [];
  const a = play(g, rule.kind, true);
  if (a) anims.push(a);
  g.querySelectorAll<HTMLElement>(NESTED_SEL).forEach((el) => {
    const r = ruleFor(el, (x) => !!x.nested && !!x.exit);
    const b = r && play(el, r.kind, true);
    if (b) anims.push(b);
  });
  if (anims.length === 0) {
    g.remove();
    return;
  }
  // Retrait garanti même si une animation est annulée ou ne se termine pas.
  const done = () => g.remove();
  Promise.all(anims.map((x) => x.finished)).then(done, done);
  setTimeout(done, durationMs * 2 + 200);
}

function wasHidden(style: string | null): boolean {
  return !!style && /display:\s*none/.test(style);
}

function onMutations(records: MutationRecord[]) {
  if (durationMs === 0) return;
  // Un déplacement (réordonnancement React, glisser-déposer) apparaît comme un
  // retrait suivi d'un ajout du même nœud : ni entrée ni sortie dans ce cas.
  const removed = new Set<Node>();
  for (const r of records) if (r.type === "childList") r.removedNodes.forEach((n) => removed.add(n));

  for (const r of records) {
    if (r.target instanceof Element && r.target.closest(SKIP_WITHIN)) continue;
    if (r.type === "attributes") {
      const el = r.target as HTMLElement;
      if (!TOGGLE_SEL || !el.isConnected || isGhost(el) || !el.matches(TOGGLE_SEL)) continue;
      const before = wasHidden(r.oldValue);
      const now = el.style.display === "none";
      if (before === now) continue;
      const rule = ruleFor(el, (x) => !!x.toggle)!;
      if (before && !now) enter(el, rule);
      else if (rule.exit && el.parentNode) ghostExit(el, rule, el.parentNode, el.nextSibling, true);
      continue;
    }

    r.removedNodes.forEach((n) => {
      if (!(n instanceof HTMLElement) || n.isConnected || n.classList.contains(GHOST_CLASS)) return;
      const rule = ruleFor(n, (x) => !!x.exit);
      if (rule) ghostExit(n, rule, r.target, r.nextSibling);
    });
    r.addedNodes.forEach((n) => {
      if (!(n instanceof HTMLElement) || !n.isConnected || removed.has(n) || isGhost(n)) return;
      enter(n, ruleFor(n));
    });
  }
}

let installed = false;

export function installMotion() {
  applyRoot();
  if (installed || typeof MutationObserver === "undefined") return;
  installed = true;
  new MutationObserver(onMutations).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
    attributeOldValue: true,
  });
}
