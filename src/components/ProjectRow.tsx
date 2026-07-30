import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { actionAllowed } from "../constants";
import { buildRepoLinks, repoActions } from "../repo";
import { expandActions, isSequenceValid } from "../sequences";
import type {
  ActionDef,
  DbConnection,
  GitInfo,
  PortInfo,
  Project,
  Sequence,
  TestResult,
} from "../types";

interface Props {
  project: Project;
  git?: GitInfo;
  running: boolean;
  busy?: string;
  portInfo?: PortInfo;
  linkStatus?: { linked: number; present: number };
  testResult?: TestResult;
  actions: ActionDef[];
  sequences: Sequence[];
  onStart: (p: Project) => void;
  onStop: (p: Project) => void;
  onAction: (p: Project, a: ActionDef) => void;
  onSequence: (p: Project, s: Sequence) => void;
  onOpenConsole: (p: Project) => void;
  onCheckout: (p: Project) => void;
  onRefreshGit: (p: Project) => void;
  onLinkPackage: (p: Project) => void;
  onFreePort: (p: Project) => void;
  onRunTests: (p: Project) => void;
  onEditEnv: (p: Project) => void;
  /** Ouvre la configuration/connexion à la base de données du service. */
  onDbConnect: (p: Project) => void;
  /** Re-teste la connexion BDD enregistrée (bouton BDD non vérifié). */
  onDbRetest: (p: Project) => void;
  /** Ouvre la page des tables (bouton BDD connecté). */
  onDbOpenTables: (p: Project) => void;
  /** Mapping BDD enregistré pour ce service (pilote l'état visuel du bouton). */
  dbConn?: DbConnection;
  /** true = test de connexion BDD en cours (loader dans le bouton). */
  dbTesting?: boolean;
  /** true = service déclaré sans base de données (bouton masqué). */
  dbDisabled?: boolean;
  /** Ouvre l'édition de la commande de démarrage du projet (clic droit sur « Démarrer »). */
  onEditStartCommand: (p: Project) => void;
  /** Lien effectif du dépôt (override manuel sinon détection auto), "" si aucun. */
  repoLink?: string;
  /** Ouvre une URL dans le navigateur (actions du menu dépôt). */
  onOpenUrl: (url: string) => void;
  /** Ouvre l'édition du lien de dépôt (clic droit, ou clic si aucun lien). */
  onEditRepo: (p: Project) => void;
  /** Ouvre la page de détail du projet (clic sur le nom). */
  onOpenDetail: (p: Project) => void;
  /** Clés d'actions du menu dépôt à masquer pour ce projet. */
  hiddenRepoActions?: string[];
  /** Clic droit sur un script du package.json : saisir des arguments avant exécution. */
  onRunScriptArgs: (p: Project, a: ActionDef) => void;
  /** Palier « réduit » : le badge de type devient une pastille de couleur. */
  dense?: boolean;
  /** Palier « réduit » : masque le port informatif (l'alerte port occupé reste). */
  hidePort?: boolean;
  /** Palier « étroit » : .env / BDD / dépôt se replient dans le menu ⋯ pour laisser
   *  la place au nom du projet. */
  foldSecondary?: boolean;
}

/** Icône base de données (cylindre), hérite de la couleur du bouton. */
function DbIcon() {
  return (
    <svg
      className="db-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <ellipse cx="8" cy="3.6" rx="5.4" ry="2.2" />
      <path d="M2.6 3.6v8.8c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V3.6" />
      <path d="M2.6 8c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2" />
    </svg>
  );
}

/** Icône dépôt (branche git), hérite de la couleur du bouton. */
function RepoIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="5" r="1.6" />
      <path d="M4.5 5.1v6" />
      <path d="M11.5 6.6c0 2.2-1.6 3-3.5 3.4" />
    </svg>
  );
}

/** Icône console (terminal). */
function TerminalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4l3.2 4L3 12" />
      <path d="M8.4 12H13" />
    </svg>
  );
}

/** Icône fichier .env. */
function EnvIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
  );
}

/** Icône « ⋯ » du menu d'actions. */
function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

/** Icône lecture (démarrer). */
function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <path d="M4.5 3.2v9.6l8-4.8z" />
    </svg>
  );
}

/** Icône stop (arrêter). */
function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <rect x="3.8" y="3.8" width="8.4" height="8.4" rx="1.2" />
    </svg>
  );
}

const KIND_LABEL: Record<string, string> = {
  service: "service",
  front: "front",
  package: "package",
};

const MENU_W = 230;
const MENU_H = 330;

// Catégories du menu d'actions (ordre d'affichage). `grid` = disposition en
// 2 colonnes pour les listes d'items courts (scripts). `danger` = repliée par défaut.
type MenuCat = { id: string; label: string; grid?: boolean; collapsed?: boolean };
const MENU_CATS: MenuCat[] = [
  { id: "lifecycle", label: "Cycle de vie" },
  { id: "scripts", label: "Scripts du projet", grid: true },
  { id: "npm", label: "npm" },
  { id: "git", label: "Git" },
  { id: "package", label: "Package" },
  { id: "custom", label: "Personnalisées" },
  { id: "cleanup", label: "Nettoyage", collapsed: true },
];

// Catégories repliées par défaut à l'ouverture du menu.
const DEFAULT_COLLAPSED = new Set(MENU_CATS.filter((c) => c.collapsed).map((c) => c.id));

function categoryOf(a: ActionDef): string {
  if (a.id.startsWith("script:")) return "scripts";
  if (a.kind === "start" || a.kind === "stop" || a.kind === "restart") return "lifecycle";
  if (a.kind === "link" || a.kind === "restore") return "package";
  if (a.danger) return "cleanup";
  if (a.kind === "test") return "npm";
  if (a.needsBranch || a.id.startsWith("git-")) return "git";
  if (a.id.startsWith("npm-")) return "npm";
  return "custom";
}

// Arbre des scripts : un item simple, ou une branche (préfixe + variantes).
type ScriptBranch = { kind: "branch"; prefix: string; children: ActionDef[] };
type ScriptNode = { kind: "leaf"; action: ActionDef } | ScriptBranch;

// Regroupe les scripts par préfixe avant le premier « : » (convention npm).
// « start:dev » + « start:prod » → une branche « start » (sous-menu au survol).
// Un script sans « : » et sans variantes reste un item simple.
function groupScripts(scriptActions: ActionDef[]): ScriptNode[] {
  const byPrefix = new Map<string, ActionDef[]>();
  for (const a of scriptActions) {
    const prefix = a.label.split(":")[0];
    const arr = byPrefix.get(prefix);
    if (arr) arr.push(a);
    else byPrefix.set(prefix, [a]);
  }
  const nodes: ScriptNode[] = [];
  for (const [prefix, group] of byPrefix) {
    if (group.length === 1 && !group[0].label.includes(":")) {
      nodes.push({ kind: "leaf", action: group[0] });
    } else {
      nodes.push({ kind: "branch", prefix, children: group });
    }
  }
  return nodes;
}

// Mémoïsé : pendant un gros flux de logs, l'app se re-rend toutes les 150 ms ;
// les lignes de projets dont les props n'ont pas changé sont ignorées.
export const ProjectRow = memo(function ProjectRow({
  project,
  git,
  running,
  busy,
  portInfo,
  linkStatus,
  testResult,
  actions: allActions,
  sequences,
  onStart,
  onStop,
  onAction,
  onSequence,
  onOpenConsole,
  onCheckout,
  onRefreshGit,
  onLinkPackage,
  onFreePort,
  onRunTests,
  onEditEnv,
  onDbConnect,
  onDbRetest,
  onDbOpenTables,
  dbConn,
  dbTesting,
  dbDisabled,
  onEditStartCommand,
  repoLink,
  onOpenUrl,
  onEditRepo,
  onOpenDetail,
  hiddenRepoActions,
  onRunScriptArgs,
  dense,
  hidePort,
  foldSecondary,
}: Props) {
  const startable = project.start_command != null;
  const state = busy ? "busy" : running ? "run" : "stop";

  // Actions proposées : compatibles avec le projet et non « réservées aux séquences ».
  const actions = allActions.filter((a) => actionAllowed(a, project) && !a.hidden);
  // Scripts du package.json du projet → actions « npm run <script> » dédiées.
  const scriptActions: ActionDef[] = (project.scripts ?? []).map((s) => ({
    id: `script:${s}`,
    label: s,
    command: `npm run ${s}`,
    kind: "bash",
  }));
  // Regroupe toutes les actions par catégorie, dans l'ordre de MENU_CATS.
  const groups = MENU_CATS.map((cat) => ({
    cat,
    items: [...actions, ...scriptActions].filter((a) => categoryOf(a) === cat.id),
  })).filter((g) => g.items.length > 0);

  // Séquences proposées : valides+applicables (jouables), ou invalides (une action/
  // séquence a été supprimée → affichées désactivées pour signaler le problème).
  const menuSequences = sequences
    .map((s) => {
      const valid = isSequenceValid(s, allActions, sequences);
      const applicable =
        valid && expandActions(s, allActions, sequences).every((a) => actionAllowed(a, project));
      return { seq: s, valid, applicable };
    })
    .filter((x) => !x.valid || x.applicable);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(DEFAULT_COLLAPSED);
  const toggleCat = (id: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const actionsBtnRef = useRef<HTMLButtonElement>(null);

  // Sous-menu (flyout) d'une branche de scripts, ouvert au survol. Rendu hors du
  // menu défilable (position: fixed) pour ne pas être rogné par son overflow.
  const [openSub, setOpenSub] = useState<{ node: ScriptBranch; x: number; y: number } | null>(null);
  const subTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCloseSub = () => {
    if (subTimer.current) clearTimeout(subTimer.current);
  };
  const scheduleCloseSub = () => {
    cancelCloseSub();
    subTimer.current = setTimeout(() => setOpenSub(null), 140);
  };
  const openSubAt = (node: ScriptBranch, e: React.MouseEvent) => {
    cancelCloseSub();
    const r = e.currentTarget.getBoundingClientRect();
    const m = 8;
    const subW = 190;
    let x = r.right - 2;
    if (x + subW > window.innerWidth - m) x = r.left - subW + 2;
    x = Math.max(m, x);
    const estH = node.children.length * 30 + 34;
    const y = r.top + estH > window.innerHeight - m ? Math.max(m, window.innerHeight - estH - m) : r.top;
    setOpenSub({ node, x, y });
  };

  // Palier étroit : le menu du bouton ⋯ est compact (.env / BDD / « Actions ▸ »).
  // Survoler « Actions ▸ » déploie le menu d'actions complet en flyout latéral.
  const [actionsFlyout, setActionsFlyout] = useState<{ x: number; y: number } | null>(null);
  const flyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCloseFlyout = () => {
    if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
  };
  const scheduleCloseFlyout = () => {
    cancelCloseFlyout();
    flyoutTimer.current = setTimeout(() => setActionsFlyout(null), 160);
  };
  const openActionsFlyoutAt = (e: React.MouseEvent) => {
    cancelCloseFlyout();
    const r = e.currentTarget.getBoundingClientRect();
    const m = 8;
    const w = 240;
    let x = r.right - 2;
    if (x + w > window.innerWidth - m) x = r.left - w + 2;
    x = Math.max(m, x);
    const y = Math.max(m, Math.min(r.top, window.innerHeight - 260 - m));
    setActionsFlyout({ x, y });
  };

  const close = useCallback(() => {
    if (subTimer.current) clearTimeout(subTimer.current);
    if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
    setOpenSub(null);
    setActionsFlyout(null);
    setMenuPos(null);
  }, []);

  // Signale aux autres lignes de fermer leur menu : une seule ligne ouverte à la fois.
  const emitOpen = () =>
    window.dispatchEvent(new CustomEvent("dl-context-menu", { detail: project.id }));

  function openFromButton() {
    if (menuPos) {
      close();
      return;
    }
    const r = actionsBtnRef.current?.getBoundingClientRect();
    if (r) {
      setMenuPos({ x: r.right, y: r.bottom + 4 });
      emitOpen();
    }
  }

  function openAt(e: React.MouseEvent) {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    emitOpen();
  }

  // Fermeture du menu : clic extérieur, Échap, ou ouverture du menu d'une autre ligne.
  // (Remplace l'ancien backdrop plein écran qui empêchait le clic droit d'atteindre
  //  une autre ligne et rouvrait le menu courant au mauvais endroit.)
  useEffect(() => {
    if (!menuPos) return;
    const inMenu = (t: EventTarget | null) =>
      t instanceof Element && (t.closest(".context-menu") || t.closest(".context-submenu"));
    const onDown = (e: MouseEvent) => {
      if (!inMenu(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onOtherMenu = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== project.id) close();
    };
    // Capture : ferme avant que le contextmenu d'une autre ligne l'ouvre.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("dl-context-menu", onOtherMenu);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("dl-context-menu", onOtherMenu);
    };
  }, [menuPos, project.id, close]);

  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | undefined>(undefined);

  // Positionne le menu à partir de sa taille réelle (le nombre d'actions varie),
  // pour qu'il reste toujours entièrement dans la fenêtre. Si le menu est plus
  // haut que la fenêtre, on le plafonne et il devient défilable.
  useLayoutEffect(() => {
    if (!menuPos) {
      setMenuStyle(undefined);
      return;
    }
    const m = 8;
    const el = menuRef.current;
    const w = el?.offsetWidth ?? MENU_W;
    const h = el?.offsetHeight ?? MENU_H;
    const top = Math.max(m, Math.min(menuPos.y, window.innerHeight - h - m));
    setMenuStyle({
      left: Math.max(m, Math.min(menuPos.x, window.innerWidth - w - m)),
      top,
      // Plafonné à l'espace restant sous l'ancrage : déplier une section fait
      // défiler le menu au lieu de le faire déborder de la fenêtre.
      maxHeight: window.innerHeight - top - m,
      overflowY: "auto",
    });
  }, [menuPos]);

  // ----- Menu du bouton dépôt (liens contextuels : MR/PR, CI, branche…) -----
  const repoBtnRef = useRef<HTMLButtonElement>(null);
  const [repoMenu, setRepoMenu] = useState<{ x: number; y: number } | null>(null);
  const repoLinks = repoLink ? buildRepoLinks(repoLink, git?.branch) : null;
  // Recherche en cours : le git (donc l'URL auto) n'est pas encore chargé pour ce
  // projet, et aucun lien manuel ne prend le relais. On neutralise le bouton pour
  // ne pas laisser croire qu'on saisit une URL alors que la détection tourne.
  const repoLoading = !repoLink && !git;
  const closeRepoMenu = useCallback(() => setRepoMenu(null), []);
  function toggleRepoMenu() {
    if (repoMenu) {
      closeRepoMenu();
      return;
    }
    const r = repoBtnRef.current?.getBoundingClientRect();
    if (r) setRepoMenu({ x: r.right, y: r.bottom + 4 });
  }
  useEffect(() => {
    if (!repoMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element && e.target.closest(".repo-menu"))) closeRepoMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRepoMenu();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [repoMenu, closeRepoMenu]);
  const openUrlAndClose = (url: string | null) => {
    closeRepoMenu();
    if (url) onOpenUrl(url);
  };
  const RM_W = 240;
  const RM_H = 320;
  const RM_MG = 8;
  const repoMenuStyle: React.CSSProperties | undefined = repoMenu
    ? {
        position: "fixed",
        left: Math.max(RM_MG, Math.min(repoMenu.x - RM_W, window.innerWidth - RM_W - RM_MG)),
        top: Math.max(RM_MG, Math.min(repoMenu.y, window.innerHeight - RM_H - RM_MG)),
      }
    : undefined;

  // Modifications non commitées : le compteur (● N) est masqué au palier réduit.
  // La puce d'état à gauche garde son sens d'origine : gris = arrêté, vert = lancé,
  // orange = tâche en cours (busy).
  const dirty = !!git && git.changes > 0;

  // Service pouvant exposer une BDD (bouton/entrée base de données).
  const dbEligible = project.kind === "service" && project.has_env && !dbDisabled;
  // Y a-t-il des actions repliées (.env / BDD) ? Si oui, le menu ⋯ devient compact
  // et le menu d'actions complet passe en flyout sous « Actions ▸ ».
  const hasFolded = !!foldSecondary && (project.has_env || dbEligible);

  // Contenu du menu d'actions catégorisé (cycle de vie, scripts, git, séquences…).
  // Rendu directement dans le menu ⋯ en mode large, ou en flyout (« Actions ▸ »)
  // au palier étroit.
  const renderActionGroups = () => (
    <>
      {groups.map(({ cat, items }) => {
        const open = !collapsed.has(cat.id);
        return (
          <div className="menu-group" key={cat.id}>
            <button className="menu-head" onClick={() => toggleCat(cat.id)}>
              <span className={"menu-chevron" + (open ? " open" : "")}>▸</span>
              <span className="menu-head-label">{cat.label}</span>
              <span className="menu-count">{items.length}</span>
            </button>
            {open && cat.id === "scripts" && (
              <div className="menu-items menu-grid">
                {groupScripts(items).map((n) =>
                  n.kind === "leaf" ? (
                    <button
                      key={n.action.id}
                      className="menu-item"
                      title={n.action.command + " · clic droit : arguments"}
                      onMouseEnter={scheduleCloseSub}
                      onClick={() => {
                        close();
                        onAction(project, n.action);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        close();
                        onRunScriptArgs(project, n.action);
                      }}
                    >
                      {n.action.label}
                    </button>
                  ) : (
                    <button
                      key={"branch:" + n.prefix}
                      className={
                        "menu-item menu-has-sub" +
                        (openSub?.node.prefix === n.prefix ? " active" : "")
                      }
                      title={`${n.children.length} variantes`}
                      onMouseEnter={(e) => openSubAt(n, e)}
                      onMouseLeave={scheduleCloseSub}
                      onClick={(e) => openSubAt(n, e)}
                    >
                      <span className="menu-has-sub-label">{n.prefix}</span>
                      <span className="menu-sub-caret">▸</span>
                    </button>
                  ),
                )}
              </div>
            )}
            {open && cat.id !== "scripts" && (
              <div className={"menu-items" + (cat.grid ? " menu-grid" : "")}>
                {items.map((a) => (
                  <button
                    key={a.id}
                    className={"menu-item" + (a.danger ? " menu-danger" : "")}
                    style={a.color ? ({ "--item-color": a.color } as React.CSSProperties) : undefined}
                    title={a.command || a.label}
                    onMouseEnter={scheduleCloseSub}
                    onClick={() => {
                      close();
                      if (a.needsBranch) onCheckout(project);
                      else onAction(project, a);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {menuSequences.length > 0 &&
        (() => {
          const open = !collapsed.has("sequences");
          return (
            <div className="menu-group">
              <button className="menu-head" onClick={() => toggleCat("sequences")}>
                <span className={"menu-chevron" + (open ? " open" : "")}>▸</span>
                <span className="menu-head-label">Séquences</span>
                <span className="menu-count">{menuSequences.length}</span>
              </button>
              {open && (
                <div className="menu-items">
                  {menuSequences.map(({ seq, valid }) =>
                    valid ? (
                      <button
                        key={seq.id}
                        className="menu-item menu-seq"
                        style={seq.color ? ({ "--item-color": seq.color } as React.CSSProperties) : undefined}
                        onClick={() => {
                          close();
                          onSequence(project, seq);
                        }}
                      >
                        ⛓ {seq.name}
                      </button>
                    ) : (
                      <button
                        key={seq.id}
                        className="menu-item menu-seq menu-item-invalid"
                        disabled
                        title="Séquence invalide : une action ou séquence a été supprimée"
                      >
                        ⚠ {seq.name}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })()}

      <div className="menu-sep" />
      <button
        className="menu-item"
        onClick={() => {
          close();
          onRefreshGit(project);
        }}
      >
        ↻ Rafraîchir l'état git
      </button>
    </>
  );

  return (
    <div className={"project-row state-" + state} onContextMenu={openAt}>
      <span className={"dot dot-" + (busy ? "busy" : running ? "run" : "stop")} />

      <div className="project-main">
        <div className="project-title">
          {dense && (
            <span
              className={"kind-dot kind-dot-" + project.kind}
              title={KIND_LABEL[project.kind]}
            />
          )}
          <button
            className="project-name project-name-btn"
            title="Voir le détail du projet"
            onClick={() => onOpenDetail(project)}
          >
            {project.name}
          </button>
          {!dense && <span className={"badge badge-" + project.kind}>{KIND_LABEL[project.kind]}</span>}
        </div>
        <div className="project-sub">
          <button
            className="chip chip-branch"
            title={git ? `Branche ${git.branch} — changer de branche` : "Changer de branche"}
            onClick={() => onCheckout(project)}
          >
            <span className="chip-ico">⌥</span>
            {git ? (
              <span className="chip-branch-txt">{git.branch}</span>
            ) : (
              <span className="spinner spinner-xs" />
            )}
          </button>
          {dirty && !hidePort && (
            <span className="chip chip-dirty" title="Modifications non commitées">
              ● {git!.changes}
            </span>
          )}
          {project.port != null &&
            (() => {
              const inUse = portInfo?.in_use ?? false;
              const owned = portInfo?.owned ?? false;
              if (inUse && !owned && !running) {
                return (
                  <span
                    className="chip chip-port-busy"
                    title={`Port occupé par un autre process (PID ${portInfo?.pids.join(", ")})`}
                  >
                    ⚠ :{project.port}
                    <button
                      className="chip-btn"
                      title="Tuer le process qui occupe ce port"
                      onClick={(e) => {
                        e.stopPropagation();
                        onFreePort(project);
                      }}
                    >
                      Libérer
                    </button>
                  </span>
                );
              }
              // Palier réduit : on masque le port purement informatif (libre ou en
              // écoute) pour laisser la place à la branche. L'alerte « port occupé »
              // ci-dessus reste, elle, toujours visible (elle porte une action).
              if (hidePort) return null;
              if (inUse && (owned || running)) {
                return (
                  <span className="chip chip-port-active" title="Service en écoute (lancé par l'app)">
                    :{project.port}
                  </span>
                );
              }
              return (
                <span className="chip chip-port" title="Port du service (libre)">
                  :{project.port}
                </span>
              );
            })()}
          {!hidePort && testResult && (testResult.total > 0 || testResult.exit_code !== 0) && (
            <span
              className={"chip chip-test " + (testResult.failed > 0 ? "test-ko" : "test-ok")}
              title={`Tests : ${testResult.passed} passés, ${testResult.failed} échoués, ${testResult.total} total`}
            >
              🧪 {testResult.passed}✓ {testResult.failed}✗
              {testResult.failed > 0 && (
                <button
                  className="chip-rerun"
                  title="Relancer les tests"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRunTests(project);
                  }}
                >
                  ↻
                </button>
              )}
            </span>
          )}
          {busy && !hidePort && <span className="chip chip-busy">{busy}…</span>}
        </div>
      </div>

      <div className="project-actions">
        <button
          className="btn btn-ghost btn-sm btn-ico"
          title="Voir la console"
          aria-label="Voir la console"
          onClick={() => onOpenConsole(project)}
        >
          <TerminalIcon />
        </button>

        {project.has_env && !foldSecondary && (
          <button
            className="btn btn-ghost btn-sm btn-ico"
            title="Afficher / modifier le fichier .env"
            aria-label="Modifier le .env"
            onClick={() => onEditEnv(project)}
          >
            <EnvIcon />
          </button>
        )}

        {project.kind === "service" && project.has_env && !dbDisabled && !foldSecondary && (
          <button
            className={
              "btn btn-sm btn-ico btn-db" +
              (dbConn ? (dbConn.verified ? " db-ok" : " db-unverified") : "")
            }
            disabled={dbTesting}
            title={
              dbConn
                ? (dbConn.verified
                    ? "Base de données connectée — clic pour voir les tables"
                    : "Connexion BDD non vérifiée — clic pour re-tester") +
                  " · clic droit : configurer"
                : "Configurer / tester la connexion à la base de données"
            }
            // Connecté : clic = page des tables. Configuré non vérifié : re-test.
            // Non configuré : ouvre la modale de configuration.
            onClick={() =>
              dbConn
                ? dbConn.verified
                  ? onDbOpenTables(project)
                  : onDbRetest(project)
                : onDbConnect(project)
            }
            // Clic droit : ouvre la modale de configuration d'un service déjà configuré.
            onContextMenu={
              dbConn
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDbConnect(project);
                  }
                : undefined
            }
          >
            {dbTesting ? <span className="spinner spinner-xs" /> : <DbIcon />}
          </button>
        )}

        <button
          ref={repoBtnRef}
          className={"btn btn-sm btn-ico btn-repo" + (repoLink ? " on" : "") + (repoLoading ? " loading" : "")}
          title={
            repoLoading
              ? "Recherche du dépôt…"
              : repoLink
                ? "Dépôt : liens GitLab / GitHub · clic droit : modifier le lien"
                : "Lier un dépôt Git (clic pour configurer)"
          }
          onClick={() => {
            if (repoLoading) return;
            if (repoLink) toggleRepoMenu();
            else onEditRepo(project);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!repoLoading) onEditRepo(project);
          }}
        >
          {repoLoading ? <span className="spinner spinner-xs" /> : <RepoIcon />}
        </button>

        <button
          ref={actionsBtnRef}
          className="btn btn-ghost btn-sm btn-ico"
          title="Actions (clic droit sur la ligne aussi). Empilable même si occupé."
          aria-label="Actions"
          onClick={openFromButton}
        >
          <DotsIcon />
        </button>

        {project.kind === "package" &&
          (() => {
            const ls = linkStatus;
            const linked = ls?.linked ?? 0;
            const present = ls?.present ?? 0;
            const fullyLinked = present > 0 && linked >= present;
            const label =
              linked === 0
                ? "🔗 Lier"
                : fullyLinked
                  ? "🔗 Lié"
                  : `🔗 Lié ${linked}/${present}`;
            return (
              <button
                className={"btn btn-sm" + (linked > 0 ? " btn-start" : "")}
                title="Gérer la liaison de ce package aux services"
                onClick={() => onLinkPackage(project)}
              >
                {label}
              </button>
            );
          })()}

        {startable ? (
          running ? (
            <button
              className="btn btn-stop btn-sm btn-ico"
              disabled={!!busy}
              onClick={() => onStop(project)}
              title="Arrêter le service"
              aria-label="Arrêter le service"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              className="btn btn-start btn-sm btn-ico"
              disabled={!!busy}
              onClick={() => onStart(project)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEditStartCommand(project);
              }}
              title={`Démarrer — ${project.start_command} · clic droit pour modifier la commande`}
              aria-label="Démarrer le service"
            >
              <PlayIcon />
            </button>
          )
        ) : (
          <span className="btn btn-sm btn-disabled" title="Librairie : pas de démarrage">
            lib
          </span>
        )}
      </div>

      {repoMenu && repoLinks && (
        <div
          className="context-menu repo-menu"
          style={repoMenuStyle}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="menu-title" title={repoLink}>
            {repoLinks.platform === "github" ? "GitHub" : "GitLab"} — {project.name}
          </div>
          <div className="menu-items">
            {repoActions(repoLinks)
              .filter((a) => a.url && !(hiddenRepoActions ?? []).includes(a.key))
              .map((a) => (
                <button
                  key={a.key}
                  className="menu-item"
                  onClick={() => openUrlAndClose(a.url)}
                >
                  {a.label}
                </button>
              ))}
            <button
              className="menu-item"
              onClick={() => {
                closeRepoMenu();
                onEditRepo(project);
              }}
            >
              Modifier le lien…
            </button>
          </div>
        </div>
      )}

      {menuPos && (
        <>
          <div
            ref={menuRef}
            className="context-menu"
            style={{ ...menuStyle, visibility: menuStyle ? "visible" : "hidden" }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="menu-title" title={project.path}>
              {project.name}
            </div>

            {hasFolded ? (
              <div className="menu-items menu-folded">
                {project.has_env && (
                  <button
                    className="menu-item menu-item-ico"
                    onClick={() => {
                      close();
                      onEditEnv(project);
                    }}
                  >
                    <span className="menu-item-ico-glyph"><EnvIcon /></span> .env
                  </button>
                )}
                {dbEligible && (
                  <button
                    className="menu-item menu-item-ico"
                    onClick={() => {
                      close();
                      if (dbConn) {
                        if (dbConn.verified) onDbOpenTables(project);
                        else onDbRetest(project);
                      } else onDbConnect(project);
                    }}
                    onContextMenu={
                      dbConn
                        ? (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            close();
                            onDbConnect(project);
                          }
                        : undefined
                    }
                  >
                    <span className="menu-item-ico-glyph"><DbIcon /></span>
                    {dbConn
                      ? dbConn.verified
                        ? "Base de données"
                        : "Base de données (non vérifiée)"
                      : "Configurer la base de données"}
                  </button>
                )}
                {/* Survol : déploie le menu d'actions complet en flyout latéral. */}
                <button
                  className={"menu-item menu-has-sub" + (actionsFlyout ? " active" : "")}
                  onMouseEnter={openActionsFlyoutAt}
                  onMouseLeave={scheduleCloseFlyout}
                  onClick={openActionsFlyoutAt}
                >
                  <span className="menu-has-sub-label">Actions</span>
                  <span className="menu-sub-caret">▸</span>
                </button>
              </div>
            ) : (
              renderActionGroups()
            )}
          </div>

          {hasFolded && actionsFlyout && (
            <div
              className="context-menu menu-flyout"
              style={{
                position: "fixed",
                left: actionsFlyout.x,
                top: actionsFlyout.y,
                maxHeight: window.innerHeight - actionsFlyout.y - 8,
                overflowY: "auto",
              }}
              onMouseEnter={cancelCloseFlyout}
              onMouseLeave={scheduleCloseFlyout}
              onContextMenu={(e) => e.preventDefault()}
            >
              {renderActionGroups()}
            </div>
          )}

          {openSub && (
            <div
              className="context-submenu"
              style={{
                left: openSub.x,
                top: openSub.y,
                maxHeight: window.innerHeight - openSub.y - 8,
              }}
              onMouseEnter={cancelCloseSub}
              onMouseLeave={scheduleCloseSub}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="menu-sub-title">{openSub.node.prefix}</div>
              {openSub.node.children.map((a) => {
                const suffix = a.label.includes(":")
                  ? a.label.slice(openSub.node.prefix.length + 1)
                  : a.label;
                return (
                  <button
                    key={a.id}
                    className="menu-item"
                    title={a.command + " · clic droit : arguments"}
                    onClick={() => {
                      close();
                      onAction(project, a);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      close();
                      onRunScriptArgs(project, a);
                    }}
                  >
                    {suffix}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
});
