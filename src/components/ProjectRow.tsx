import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { actionAllowed } from "../constants";
import type { ActionDef, GitInfo, PortInfo, Project, Sequence, TestResult } from "../types";

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
  /** Ouvre l'édition de la commande de démarrage du projet (clic droit sur « Démarrer »). */
  onEditStartCommand: (p: Project) => void;
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
  onEditStartCommand,
}: Props) {
  const startable = project.start_command != null;
  const state = busy ? "busy" : running ? "run" : "stop";

  // Actions / séquences proposées selon le type de projet.
  const actions = allActions.filter((a) => actionAllowed(a, project));
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

  const usableSequences = sequences.filter((s) =>
    s.actionIds.every((id) => {
      const a = allActions.find((x) => x.id === id);
      return !a || actionAllowed(a, project);
    }),
  );

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

  const close = useCallback(() => {
    if (subTimer.current) clearTimeout(subTimer.current);
    setOpenSub(null);
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

  return (
    <div className={"project-row state-" + state} onContextMenu={openAt}>
      <span className={"dot dot-" + (busy ? "busy" : running ? "run" : "stop")} />

      <div className="project-main">
        <div className="project-title">
          <span className="project-name">{project.name}</span>
          <span className={"badge badge-" + project.kind}>{KIND_LABEL[project.kind]}</span>
        </div>
        <div className="project-sub">
          <button
            className="chip chip-branch"
            title="Changer de branche"
            onClick={() => onCheckout(project)}
          >
            <span className="chip-ico">⌥</span>
            {git ? git.branch : <span className="spinner spinner-xs" />}
          </button>
          {git && git.changes > 0 && (
            <span className="chip chip-dirty" title="Modifications non commitées">
              ● {git.changes}
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
          {testResult && (testResult.total > 0 || testResult.exit_code !== 0) && (
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
          {busy && <span className="chip chip-busy">{busy}…</span>}
        </div>
      </div>

      <div className="project-actions">
        <button
          className="btn btn-ghost btn-sm"
          title="Voir la console"
          onClick={() => onOpenConsole(project)}
        >
          Console
        </button>

        {project.has_env && (
          <button
            className="btn btn-ghost btn-sm"
            title="Afficher / modifier le fichier .env"
            onClick={() => onEditEnv(project)}
          >
            .env
          </button>
        )}

        <button
          ref={actionsBtnRef}
          className="btn btn-ghost btn-sm"
          title="Actions (clic droit sur la ligne aussi). Empilable même si occupé."
          onClick={openFromButton}
        >
          Actions ▾
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
            <button className="btn btn-stop btn-sm" disabled={!!busy} onClick={() => onStop(project)}>
              ■ Arrêter
            </button>
          ) : (
            <button
              className="btn btn-start btn-sm"
              disabled={!!busy}
              onClick={() => onStart(project)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEditStartCommand(project);
              }}
              title={`Commande : ${project.start_command} — clic droit pour la modifier`}
            >
              ▶ Démarrer
            </button>
          )
        ) : (
          <span className="btn btn-sm btn-disabled" title="Librairie : pas de démarrage">
            lib
          </span>
        )}
      </div>

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
                            title={n.action.command}
                            onMouseEnter={scheduleCloseSub}
                            onClick={() => {
                              close();
                              onAction(project, n.action);
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

            {usableSequences.length > 0 &&
              (() => {
                const open = !collapsed.has("sequences");
                return (
                  <div className="menu-group">
                    <button className="menu-head" onClick={() => toggleCat("sequences")}>
                      <span className={"menu-chevron" + (open ? " open" : "")}>▸</span>
                      <span className="menu-head-label">Séquences</span>
                      <span className="menu-count">{usableSequences.length}</span>
                    </button>
                    {open && (
                      <div className="menu-items">
                        {usableSequences.map((s) => (
                          <button
                            key={s.id}
                            className="menu-item menu-seq"
                            style={s.color ? ({ "--item-color": s.color } as React.CSSProperties) : undefined}
                            onClick={() => {
                              close();
                              onSequence(project, s);
                            }}
                          >
                            ⛓ {s.name}
                          </button>
                        ))}
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
          </div>

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
                    title={a.command}
                    onClick={() => {
                      close();
                      onAction(project, a);
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
