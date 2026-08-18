import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, autostart, onLogs, onStatus, pickBashExe } from "./api";
import { BranchModal, type BranchModalState } from "./components/BranchModal";
import { Console } from "./components/Console";
import { ColorPicker } from "./components/ColorPicker";
import { CustomActionManager } from "./components/CustomActionManager";
import { DbConnectionModal, type DbModalState } from "./components/DbConnectionModal";
import { DbWorkspaceView, type DbWsState } from "./components/DbWorkspaceView";
import { DbTableDataView, type DbDataState } from "./components/DbTableDataView";
import { DbTableSchemaView, type DbSchemaState } from "./components/DbTableSchemaView";
import { DbRelationsView, type DbGraphState } from "./components/DbRelationsView";
import { EnvModal, type EnvModalState } from "./components/EnvModal";
import { GitChangesView } from "./components/GitChangesView";
import { PackageLinkModal, type LinkModalState } from "./components/PackageLinkModal";
import { ProjectDetail } from "./components/ProjectDetail";
import { ProjectRow } from "./components/ProjectRow";
import { ProjectSources } from "./components/ProjectSources";
import { RepoLinkModal } from "./components/RepoLinkModal";
import { ScriptArgsModal } from "./components/ScriptArgsModal";
import { SequenceManager } from "./components/SequenceManager";
import { Setup } from "./components/Setup";
import { StartCommandModal } from "./components/StartCommandModal";
import { TaskQueue } from "./components/TaskQueue";
import {
  actionAllowed,
  BUILTIN_ACTIONS,
  CORE_ACTIONS,
  seedActions,
  DEFAULT_GIT_BASH,
  DEFAULT_SEQUENCES,
  START_COMMAND_PLACEHOLDER,
} from "./constants";
import { GeneralSequenceModal } from "./components/GeneralSequenceModal";
import { checkForUpdate, type UpdateAsset, type UpdateInfo } from "./update";
import { expandActions, isSequenceValid } from "./sequences";
import {
  resolveLayout,
  createFolder as createFolderLayout,
  deleteFolder as deleteFolderLayout,
  renameFolder as renameFolderLayout,
  setFolderColor as setFolderColorLayout,
  toggleFolderCollapsed,
  folderKey,
  folderIdOf,
  isFolderKey,
  FOLDER_PREFIX,
  type LayoutNode,
  type LayoutState,
} from "./layout";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  closestCorners,
  type CollisionDetection,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { parseEnv } from "./env";
import { basename, dirname, samePath } from "./paths";
import type {
  ActionDef,
  Config,
  DbConnection,
  DbGraphLayout,
  DbRowUpdate,
  DbSchemaChange,
  GitInfo,
  JobStatus,
  LogLine,
  PortInfo,
  Project,
  ProjectFolder,
  ProjectKind,
  ProjectSource,
  QJob,
  Sequence,
  ServiceDep,
  TestResult,
} from "./types";

type StepToken = { cancelled: boolean; runId: string };
type StepPlan = { action: ActionDef; branch?: string };

/** Sous-onglet d'une table : ses lignes, sa structure, ou ses relations. */
const EMPTY_DB_GRAPH: DbGraphState = {
  tables: [],
  relations: [],
  loading: false,
  loaded: false,
};

type DbTabView = "data" | "schema" | "relations";

/** Un onglet de table : ses données + son historique de navigation (FK). */
type DbTab = {
  id: string;
  data: DbDataState;
  navStack: { state: DbDataState; scrollTop: number }[];
  /** Sous-onglet affiché (données / structure). */
  view: DbTabView;
  /** Structure de la table, chargée à la première ouverture du sous-onglet. */
  schema: DbSchemaState;
};

// Résout un mapping BDD (clés .env) vers ses valeurs concrètes. Le port par
// défaut dépend du pilote quand la clé est absente/vide.
function resolveDbValues(conn: DbConnection, env: Record<string, string>) {
  const val = (k: string) => (k ? env[k] ?? "" : "");
  const portRaw = val(conn.portKey).trim();
  const port = portRaw
    ? Number.parseInt(portRaw, 10)
    : conn.driver === "postgres"
      ? 5432
      : 3306;
  return {
    host: val(conn.hostKey),
    port,
    user: val(conn.userKey),
    password: val(conn.passwordKey),
    database: val(conn.databaseKey),
    portRaw,
    portValid: !(Number.isNaN(port) || port <= 0 || port > 65535),
  };
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// Clé de rendu stable attribuée à chaque ligne de log à la réception :
// permet de mémoïser les lignes de la console (pas de re-parse ANSI ni de
// re-rendu des lignes déjà affichées).
let logSeq = 0;
const tagKey = (l: LogLine): LogLine => {
  l.key = ++logSeq;
  return l;
};

const MAX_LINES = 5000;
// Identité stable pour « aucune exception » (évite de relancer le scan pour rien).
const NO_OVERRIDES: Record<string, string> = {};
const NO_COLORS: Record<string, string> = {};
const NO_LINKS: Record<string, string> = {};
const NO_SOURCES: ProjectSource[] = [];
const KIND_ORDER: ProjectKind[] = ["fullstack", "service", "front", "package"];

/** Assemble un chemin en respectant le séparateur du dossier racine. */
function joinPath(root: string, sub: string): string {
  const sep = root.includes("/") && !root.includes("\\") ? "/" : "\\";
  return root.replace(/[\\/]+$/, "") + sep + sub;
}

/**
 * Migration des anciennes configs (racine unique) vers des sources : reproduit
 * l'archi historique — `services/` (dossier parent, type service),
 * `portail-occupant` (projet front), `packages/` (dossier parent, type package).
 * Les sources vers un dossier absent ne produisent rien au scan.
 */
function migrateSources(root: string): ProjectSource[] {
  if (!root.trim()) return [];
  return [
    {
      id: "legacy-services",
      path: joinPath(root, "services"),
      mode: "parent",
      defaultType: "service",
      overrides: {},
    },
    { id: "legacy-front", path: joinPath(root, "portail-occupant"), mode: "single", type: "front" },
    {
      id: "legacy-packages",
      path: joinPath(root, "packages"),
      mode: "parent",
      defaultType: "package",
      overrides: {},
    },
  ];
}
const KIND_TITLE: Record<ProjectKind, string> = {
  fullstack: "Full-stack",
  service: "Services",
  front: "Front",
  package: "Packages",
};

/** Réduit une liste de projets aux références de services attendues par `package_links`. */
function servicesForLinks(list: Project[]): { id: string; name: string; path: string }[] {
  return list
    .filter((p) => p.kind === "service")
    .map((p) => ({ id: p.id, name: p.name, path: p.path }));
}

// ----- Glisser-déposer du tableau de bord (dnd-kit) -----
// Id du conteneur racine (dépose « hors dossier »).
const ROOT = "root";
// Structure de travail pendant un glissement : la racine (ids de projets libres +
// clés de dossiers) et, par dossier, ses ids de projets membres.
type Struct = { root: string[]; folders: Record<string, string[]> };

/** Struct à partir de l'arbre résolu (config → vue courante), récursif. */
function structFrom(nodes: LayoutNode[]): Struct {
  const folders: Record<string, string[]> = {};
  const walk = (list: LayoutNode[]): string[] =>
    list.map((n) => {
      if (n.type === "folder") {
        folders[n.folder.id] = walk(n.children);
        return folderKey(n.folder.id);
      }
      return n.project.id;
    });
  return { root: walk(nodes), folders };
}

/** Ids composant le sous-arbre d'un dossier (lui-même + descendants), pour
 *  interdire de déposer un dossier dans lui-même ou l'un de ses descendants. */
function subtreeKeys(s: Struct, folderId: string, acc: Set<string>): void {
  acc.add(folderId); // id de conteneur
  acc.add(FOLDER_PREFIX + folderId); // clé triable
  for (const k of s.folders[folderId] ?? []) {
    acc.add(k);
    if (k.startsWith(FOLDER_PREFIX)) subtreeKeys(s, k.slice(FOLDER_PREFIX.length), acc);
  }
}

/** Reconstitue l'état persistable (dossiers + layout) depuis une struct. */
function stateFromStruct(s: Struct, foldersMeta: ProjectFolder[]): LayoutState {
  const folders = foldersMeta.map((f) => ({ ...f, projectIds: s.folders[f.id] ?? f.projectIds }));
  return { folders, layout: s.root };
}

/** Élément triable générique (render-prop) : porte la logique dnd-kit, laisse le
 *  rendu à l'appelant qui branche `setNodeRef`, `style` et la poignée `handle`. */
function Sortable({
  id,
  children,
}: {
  id: string;
  children: (p: {
    setNodeRef: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
    isDragging: boolean;
    handle: Record<string, unknown>;
  }) => React.ReactNode;
}) {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };
  return <>{children({ setNodeRef, style, isDragging, handle: { ...attributes, ...listeners } })}</>;
}

/** Zone de dépôt générique (render-prop). */
function Droppable({
  id,
  children,
}: {
  id: string;
  children: (p: { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean }) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <>{children({ setNodeRef, isOver })}</>;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  // Miroir de `config` pour les callbacks async (évite de les recréer, et lit
  // toujours la dernière config lors d'un test BDD asynchrone).
  const configRef = useRef<Config | null>(null);
  configRef.current = config;
  // Config incomplète chargée du disque (ex. commande de démarrage manquante) :
  // sert à pré-remplir l'écran Setup et à conserver séquences/actions existantes.
  const [partialConfig, setPartialConfig] = useState<Config | null>(null);
  const [ready, setReady] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  /** Téléchargement de l'installeur : nom en cours, chemin final, ou erreur. */
  const [dl, setDl] = useState<{ busy?: string; done?: string; error?: string }>({});
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  // Page de détail d'un projet : suivi par chemin (stable même si le type/id change).
  const [detailPath, setDetailPath] = useState<string | null>(null);
  // Page des modifications git d'un projet (clic sur la pastille « non commité »).
  const [gitChangesPath, setGitChangesPath] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  // Projets « à plat » : projets top-level + sous-projets des fullstack. Sert à
  // tout le suivi indexé par id (démarrage, ports, actions, consoles, séquences),
  // tandis que `projects` reste la liste top-level pour le regroupement/rendu.
  const allProjects = useMemo(
    () => projects.flatMap((p) => (p.children?.length ? [p, ...p.children] : [p])),
    [projects],
  );
  // ----- Glisser-déposer (dnd-kit) & dossiers virtuels -----
  // Élément en cours de déplacement (id de projet ou "folder:<id>"), pour l'overlay.
  const [activeDrag, setActiveDrag] = useState<string | null>(null);
  // Structure transitoire pendant un glissement (conteneurs → ids), mise à jour en
  // direct par dnd-kit ; null hors glissement (on rend alors depuis la config).
  const [dragStruct, setDragStruct] = useState<Struct | null>(null);
  const dragStructRef = useRef<Struct | null>(null);
  // Dossier dont on édite le nom en place (null = aucun), + saisie courante.
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  // Menu contextuel d'un dossier (clic droit sur l'entête) : renommer/couleur/supprimer.
  const [folderMenu, setFolderMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // État déplié des projets fullstack (par id), session uniquement.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((p: Project) => {
    setExpandedRows((prev) => {
      const n = new Set(prev);
      if (n.has(p.id)) n.delete(p.id);
      else n.add(p.id);
      return n;
    });
  }, []);
  const [gitMap, setGitMap] = useState<Record<string, GitInfo>>({});
  const [portInfo, setPortInfo] = useState<Record<string, PortInfo>>({});
  const [pkgLinks, setPkgLinks] = useState<Record<string, { linked: number; present: number }>>(
    {},
  );
  const [linkVersion, setLinkVersion] = useState(0);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const [jobs, setJobs] = useState<QJob[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const jobsRef = useRef<QJob[]>([]);
  const tokensRef = useRef<Map<string, StepToken>>(new Map());
  const jobCancelRef = useRef<Set<string>>(new Set());
  const projectChains = useRef<Map<string, Promise<void>>>(new Map());
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Trace une opération non annulable (scan, libération de port…) dans la file.
  const track = useCallback(
    async <T,>(title: string, projectName: string, run: () => Promise<T>): Promise<T> => {
      const job: QJob = {
        id: uid(),
        title,
        projectId: "",
        projectName,
        steps: [{ id: uid(), label: title, status: "running" }],
        status: "running",
        cancellable: false,
      };
      setJobs((js) => [job, ...js]);
      const finish = (st: JobStatus) =>
        setJobs((js) =>
          js.map((j) =>
            j.id === job.id
              ? { ...j, status: st, steps: j.steps.map((s) => ({ ...s, status: st })) }
              : j,
          ),
        );
      try {
        const r = await run();
        finish("done");
        return r;
      } catch (e) {
        finish("failed");
        throw e;
      }
    },
    [],
  );
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [activeConsole, setActiveConsole] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<Set<string>>(new Set());
  const [closedTabs, setClosedTabs] = useState<Set<string>>(new Set());
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const logBuf = useRef<LogLine[]>([]);

  const [linkModal, setLinkModal] = useState<LinkModalState | null>(null);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const linkModalRef = useRef<LinkModalState | null>(null);
  useEffect(() => {
    linkModalRef.current = linkModal;
  }, [linkModal]);

  const [generalSeq, setGeneralSeq] = useState<Sequence | null>(null);
  const [seqMenuOpen, setSeqMenuOpen] = useState(false);

  const [splitPct, setSplitPct] = useState<number>(() => {
    const v = Number(localStorage.getItem("dl.splitPct"));
    return v >= 25 && v <= 78 ? v : 54;
  });
  const mainRef = useRef<HTMLDivElement>(null);
  const draggingSplit = useRef(false);

  // Repli progressif des lignes de projet selon la largeur du volet. La mesure est
  // recalculée à chaque changement de `splitPct` (glissement du splitter → re-rendu
  // React garanti) et via ResizeObserver + resize fenêtre en filet. L'état n'est mis
  // à jour qu'au franchissement d'un palier (pas de re-rendu à chaque pixel).
  // Seuils sur clientWidth (padding inclus). Facilement ajustables.
  const projectsRef = useRef<HTMLElement>(null);
  const [rowLayout, setRowLayout] = useState({ dense: false, hidePort: false, fold: false });
  const measurePanel = useCallback(() => {
    const el = projectsRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const next = { dense: w < 560, hidePort: w < 520, fold: w < 480 };
    setRowLayout((prev) =>
      prev.dense === next.dense && prev.hidePort === next.hidePort && prev.fold === next.fold
        ? prev
        : next,
    );
  }, []);
  // Mesure directe après chaque re-rendu déclenché par le splitter, l'arrivée des
  // projets ou un changement de vue (le volet se (re)monte). useLayoutEffect : avant
  // peinture, pas de scintillement.
  useLayoutEffect(() => {
    measurePanel();
  }, [measurePanel, splitPct, view, detailPath, projects.length]);
  useEffect(() => {
    const el = projectsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measurePanel());
    ro.observe(el);
    window.addEventListener("resize", measurePanel);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measurePanel);
    };
  }, [measurePanel, view, detailPath]);

  // Mémorise la largeur du panneau (persistée entre les sessions).
  useEffect(() => {
    localStorage.setItem("dl.splitPct", String(splitPct));
  }, [splitPct]);

  const [branchModal, setBranchModal] = useState<BranchModalState | null>(null);
  const branchResolver = useRef<
    ((r: { branch: string; isNew: boolean } | null) => void) | null
  >(null);

  const [envModal, setEnvModal] = useState<EnvModalState | null>(null);
  const [dbModal, setDbModal] = useState<DbModalState | null>(null);
  const [dbTesting, setDbTesting] = useState<Set<string>>(new Set());
  // Espaces de travail BDD ouverts en parallèle, indexés par id de projet.
  // Les onglets sont à plat (chaque onglet porte son projectId) et TOUS restent
  // montés : basculer d'une base à l'autre ne perd donc aucune saisie en cours.
  const [dbWsMap, setDbWsMap] = useState<Record<string, DbWsState>>({});
  const dbWsMapRef = useRef<Record<string, DbWsState>>({});
  dbWsMapRef.current = dbWsMap;
  /** Base actuellement affichée (null = aucune / tableau de bord). */
  const [activeDbId, setActiveDbId] = useState<string | null>(null);
  const activeDbIdRef = useRef<string | null>(null);
  activeDbIdRef.current = activeDbId;
  // Réduit (masqué) mais toujours monté : rend le tableau de bord et sa console
  // accessibles sans perdre les onglets ni les saisies en cours de la BDD.
  const [dbWsHidden, setDbWsHidden] = useState(false);
  /** Colonnes déjà lues, par « projet:table » (listes déroulantes de structure). */
  const colCacheRef = useRef<Map<string, string[]>>(new Map());
  /** Graphe des clés étrangères par base. */
  const [dbGraphMap, setDbGraphMap] = useState<Record<string, DbGraphState>>({});
  /** true = l'onglet « Schéma de la base » est affiché, par base. */
  const [dbGraphOpenMap, setDbGraphOpenMap] = useState<Record<string, boolean>>({});
  const [dbTabs, setDbTabs] = useState<DbTab[]>([]);
  // Miroir de `dbTabs` : lit l'état courant hors du cycle de rendu (chargement
  // de la structure déclenché juste après un setDbTabs).
  const dbTabsRef = useRef<DbTab[]>([]);
  dbTabsRef.current = dbTabs;
  /** Onglet actif par base. */
  const [dbActiveTabMap, setDbActiveTabMap] = useState<Record<string, string | null>>({});
  /** Modifications en attente par onglet (pastille sur l'onglet). */
  const [dbDirty, setDbDirty] = useState<Record<string, number>>({});

  // ----- Espace actif dérivé + écritures ciblées -----
  const dbWs = activeDbId ? dbWsMap[activeDbId] ?? null : null;
  const dbGraph = (activeDbId ? dbGraphMap[activeDbId] : undefined) ?? EMPTY_DB_GRAPH;
  const dbGraphOpen = activeDbId ? dbGraphOpenMap[activeDbId] ?? false : false;
  const dbActiveTab = activeDbId ? dbActiveTabMap[activeDbId] ?? null : null;
  /** Espace actif lu de façon synchrone (hors cycle de rendu). */
  const activeWs = () =>
    activeDbIdRef.current ? dbWsMapRef.current[activeDbIdRef.current] ?? null : null;
  const patchWs = (pid: string, fn: (s: DbWsState) => DbWsState) =>
    setDbWsMap((m) => (m[pid] ? { ...m, [pid]: fn(m[pid]) } : m));
  const setDbGraph = (
    updater: DbGraphState | ((g: DbGraphState) => DbGraphState),
    pid = activeDbIdRef.current,
  ) => {
    if (!pid) return;
    setDbGraphMap((m) => {
      const cur = m[pid] ?? EMPTY_DB_GRAPH;
      return { ...m, [pid]: typeof updater === "function" ? updater(cur) : updater };
    });
  };
  const setDbGraphOpen = (v: boolean, pid = activeDbIdRef.current) => {
    if (!pid) return;
    setDbGraphOpenMap((m) => ({ ...m, [pid]: v }));
  };
  const setDbActiveTab = (id: string | null, pid = activeDbIdRef.current) => {
    if (!pid) return;
    setDbActiveTabMap((m) => ({ ...m, [pid]: id }));
  };
  // Verrou synchrone : empêche plusieurs chargements de page concurrents
  // (les événements de scroll arrivent plus vite que la mise à jour d'état).
  const loadingMoreRef = useRef(false);
  // Incrémenté à chaque chargement complet (pas lors d'un ajout de page).
  const dbLoadSeq = useRef(0);

  // Échap ferme l'overlay le plus haut : BDD → tâches → réglages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // BDD ouverte et visible : Échap la réduit (conserve onglets + saisies).
      if (dbWs && !dbWsHidden) setDbWsHidden(true);
      else if (jobsOpen) setJobsOpen(false);
      else if (view === "settings") setView("dashboard");
      else if (gitChangesPath) setGitChangesPath(null);
      else if (detailPath) setDetailPath(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dbWs, dbWsHidden, jobsOpen, view, detailPath, gitChangesPath]);

  // Repli copier/couper : dans la WebView, Ctrl/Cmd+C ne recopie pas toujours le
  // contenu d'un champ. On force l'action via execCommand (idempotent : si la
  // copie native fonctionne aussi, elle porte sur la même sélection).
  useEffect(() => {
    const onCopyKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "c" && k !== "x") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const field = el as HTMLInputElement | HTMLTextAreaElement;
        const { selectionStart: s, selectionEnd: en } = field;
        if (s == null || en == null || s === en) return; // rien de sélectionné
        try {
          document.execCommand(k === "x" ? "cut" : "copy");
        } catch {
          /* ignore */
        }
      } else if (k === "c") {
        // Hors champ : copier la sélection de texte (ex. sortie de console).
        const sel = window.getSelection();
        if (sel && sel.toString()) {
          try {
            document.execCommand("copy");
          } catch {
            /* ignore */
          }
        }
      }
    };
    window.addEventListener("keydown", onCopyKey);
    return () => window.removeEventListener("keydown", onCopyKey);
  }, []);

  const bash = config?.git_bash_path ?? DEFAULT_GIT_BASH;
  const sources = config?.sources ?? NO_SOURCES;
  const startCmd = config?.start_command ?? "";
  const cmdOverrides = config?.command_overrides ?? NO_OVERRIDES;
  const projectLinks = config?.project_links ?? NO_LINKS;
  const sequences = config?.sequences ?? [];
  const customActions = config?.custom_actions ?? [];
  const actionColors = config?.action_colors ?? NO_COLORS;
  const allActions = useMemo(
    () => [...BUILTIN_ACTIONS, ...customActions].map((a) => ({ ...a, color: actionColors[a.id] })),
    [customActions, actionColors],
  );
  const resolveAction = useCallback(
    (id: string) => allActions.find((a) => a.id === id),
    [allActions],
  );

  // ----- Chargement initial de la config -----
  useEffect(() => {
    api.loadConfig().then((c) => {
      // La commande de démarrage fait partie de la config minimale : si elle
      // manque (ancienne config), on repasse par l'écran Setup pré-rempli.
      // (On ne dépend plus de projects_root : les nouvelles configs n'en ont pas.)
      if (c && c.start_command) {
        // Les actions par défaut ne sont semées qu'une seule fois : après quoi
        // le drapeau est persisté, et les suppressions de l'utilisateur tiennent.
        const alreadySeeded = c.actions_seeded ?? false;
        // Migration à effectuer : jamais migré, aucune source, mais une ancienne
        // racine unique existe. Une fois migré (drapeau posé), on ne re-migre pas,
        // même si l'utilisateur retire ensuite toutes ses sources.
        const needsMigration = !c.sources_migrated && !c.sources?.length && !!c.projects_root;
        // Spread d'abord : préserve tout champ non listé ici (ex. db_layouts),
        // qui serait sinon perdu au démarrage puis effacé à la 1re écriture.
        const next: Config = {
          ...c,
          projects_root: c.projects_root,
          sources: needsMigration ? migrateSources(c.projects_root) : (c.sources ?? []),
          sources_migrated: true,
          git_bash_path: c.git_bash_path || DEFAULT_GIT_BASH,
          start_command: c.start_command,
          command_overrides: c.command_overrides ?? NO_OVERRIDES,
          project_links: c.project_links ?? {},
          sequences: c.sequences?.length ? c.sequences : DEFAULT_SEQUENCES,
          custom_actions: alreadySeeded ? (c.custom_actions ?? []) : seedActions(c.custom_actions ?? []),
          action_colors: c.action_colors ?? {},
          actions_seeded: true,
          db_connections: c.db_connections ?? {},
          db_row_limit: c.db_row_limit ?? 200,
          db_disabled: c.db_disabled ?? {},
        };
        setConfig(next);
        // Fige le semis d'actions et/ou la migration des sources dès le 1er lancement.
        if (!alreadySeeded || needsMigration) void api.saveConfig(next);
      } else if (c) {
        setPartialConfig(c);
      }
      setReady(true);
    });
  }, []);

  // ----- Vérification d'une nouvelle version (GitHub) : au démarrage + toutes les 6 h -----
  useEffect(() => {
    const run = () => checkForUpdate().then((u) => u && setUpdate(u)).catch(() => {});
    run();
    const iv = setInterval(run, 6 * 60 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // ----- Logs (bufferisés puis flush périodique) -----
  useEffect(() => {
    const unBatch = onLogs((arr) => {
      for (const l of arr) logBuf.current.push(tagKey(l));
    });
    const iv = setInterval(() => {
      if (!logBuf.current.length) return;
      const batch = logBuf.current;
      logBuf.current = [];
      setLogs((prev) => {
        const next = { ...prev };
        // copie de chaque tampon au plus UNE fois par flush (et non par ligne)
        const touched = new Set<string>();
        for (const l of batch) {
          if (!touched.has(l.target)) {
            next[l.target] = next[l.target] ? next[l.target].slice() : [];
            touched.add(l.target);
          }
          next[l.target].push(l);
        }
        for (const t of touched) {
          const arr = next[t];
          if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
        }
        return next;
      });
    }, 150);
    return () => {
      unBatch.then((u) => u());
      clearInterval(iv);
    };
  }, []);

  // ----- Statut des process -----
  useEffect(() => {
    const un = onStatus((s) => {
      setRunning((prev) => {
        const n = new Set(prev);
        if (s.running) n.add(s.id);
        else n.delete(s.id);
        return n;
      });
    });
    return () => {
      un.then((u) => u());
    };
  }, []);

  // ----- Splitter (redimensionnement projets / console) -----
  useEffect(() => {
    function move(e: MouseEvent) {
      if (!draggingSplit.current || !mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      let pct = ((e.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(25, Math.min(78, pct));
      setSplitPct(pct);
    }
    function up() {
      if (!draggingSplit.current) return;
      draggingSplit.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  function startSplit(e: React.MouseEvent) {
    e.preventDefault();
    draggingSplit.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // ----- Git info -----
  const refreshGitFor = useCallback(
    async (p: Project) => {
      try {
        const g = await api.gitInfo(bash, p.path);
        setGitMap((m) => ({ ...m, [p.id]: g }));
      } catch {
        /* ignore */
      }
    },
    [bash],
  );

  // ----- Scan -----
  // Un scan est coûteux (git par projet) : on interdit les scans concurrents.
  // scanPendingRef mémorise qu'une modification est arrivée pendant un scan pour
  // le rejouer une seule fois à la fin (coalescing) ; rescanRef pointe toujours
  // vers la dernière version de `rescan` (donc l'état le plus récent).
  const scanBusyRef = useRef(false);
  const scanPendingRef = useRef(false);
  const rescanRef = useRef<() => void>(() => {});
  const rescan = useCallback(async () => {
    // Un scan tourne déjà : on note qu'il faudra le refaire, sans lancer en //.
    if (scanBusyRef.current) {
      scanPendingRef.current = true;
      return;
    }
    setScanError(null);
    if (!sources.length) {
      setProjects([]);
      return;
    }
    scanBusyRef.current = true;
    setScanning(true);
    try {
      await track("Scan des projets", "", async () => {
        const list = await api.scanProjects(sources, startCmd, cmdOverrides);
        setProjects(list);
        setGitMap({}); // recharge l'état git
        const ids = await api.runningIds();
        setRunning(new Set(ids));
        const hists = await Promise.all(ids.map((id) => api.getLogs(id)));
        setLogs((prev) => {
          const next = { ...prev };
          ids.forEach((id, i) => {
            if (hists[i].length) next[id] = hists[i].map(tagKey);
          });
          return next;
        });
        // la tâche reste « en cours » tant que les branches ne sont pas chargées
        await Promise.all(list.map((p) => refreshGitFor(p)));
      });
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
      scanBusyRef.current = false;
      // Une modification est survenue pendant le scan : on rejoue une fois, avec
      // la dernière version de rescan (donc les dernières sources).
      if (scanPendingRef.current) {
        scanPendingRef.current = false;
        rescanRef.current();
      }
    }
  }, [sources, startCmd, cmdOverrides, refreshGitFor, track]);

  // rescanRef suit toujours la dernière closure de rescan (pour le re-jeu ci-dessus).
  useEffect(() => {
    rescanRef.current = rescan;
  }, [rescan]);

  // Ne rescanne que si une valeur pertinente au scan change réellement. On compare
  // le *contenu* des sources / overrides (et non la référence, reconstruite à chaque
  // save) : sinon toute sauvegarde de réglage (couleurs, actions…) relançait un scan.
  // Debounce : plusieurs modifications rapprochées (typage de sous-dossiers, ajouts)
  // ne déclenchent qu'un seul scan une fois la salve terminée.
  useEffect(() => {
    if (!config) return;
    const t = setTimeout(() => rescanRef.current(), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(config?.sources ?? []),
    config?.git_bash_path,
    config?.start_command,
    JSON.stringify(config?.command_overrides ?? {}),
  ]);

  // ----- Vérification des ports (polling régulier via netstat -ano) -----
  const portsBusy = useRef(false);
  const refreshPorts = useCallback(async () => {
    if (portsBusy.current) return; // pas d'empilement si le backend est lent
    const ports = [...new Set(allProjects.filter((p) => p.port != null).map((p) => p.port!))];
    if (!ports.length) {
      setPortInfo({});
      return;
    }
    portsBusy.current = true;
    try {
      const infos = await api.portsStatus(ports);
      const byPort = new Map(infos.map((i) => [i.port, i]));
      const next: Record<string, PortInfo> = {};
      for (const p of allProjects) {
        if (p.port != null) {
          const info = byPort.get(p.port);
          if (info) next[p.id] = info;
        }
      }
      setPortInfo(next);
    } catch {
      /* ignore */
    } finally {
      portsBusy.current = false;
    }
  }, [allProjects]);

  useEffect(() => {
    refreshPorts();
    const iv = setInterval(refreshPorts, 4000);
    return () => clearInterval(iv);
  }, [refreshPorts, running]);

  const onFreePort = useCallback(
    async (p: Project) => {
      if (p.port == null) return;
      setBusyFor(p.id, "Libération du port");
      try {
        await track(`Libérer le port ${p.port}`, p.name, () => api.freePort(p.port!));
      } catch (e) {
        console.error(e);
      } finally {
        setBusyFor(p.id, null);
        refreshPorts();
      }
    },
    [refreshPorts, track],
  );

  // ----- État de liaison des packages (combien de services les utilisent / lient) -----
  const refreshPkgLinks = useCallback(
    async (list: Project[]) => {
      const pkgs = list.filter((p) => p.kind === "package");
      if (!pkgs.length) {
        setPkgLinks({});
        return;
      }
      const services = servicesForLinks(list);
      const result: Record<string, { linked: number; present: number }> = {};
      await Promise.all(
        pkgs.map(async (p) => {
          try {
            const meta = await api.readPackageJson(p.path);
            const links = await api.packageLinks(services, meta.name);
            const present = links.filter((s) => s.present);
            result[p.id] = {
              present: present.length,
              linked: present.filter((s) => s.linked).length,
            };
          } catch {
            result[p.id] = { present: 0, linked: 0 };
          }
        }),
      );
      setPkgLinks(result);
    },
    [],
  );

  useEffect(() => {
    refreshPkgLinks(projects);
  }, [projects, linkVersion, refreshPkgLinks]);

  // Services dont le port est occupé par un process qui n'est PAS le nôtre.
  const orphanPorts = useMemo(
    () =>
      allProjects.filter((p) => {
        const i = portInfo[p.id];
        return p.port != null && !!i?.in_use && !i.owned && !running.has(p.id);
      }),
    [allProjects, portInfo, running],
  );

  const freeAllPorts = useCallback(async () => {
    await track("Libérer tous les ports", "", async () => {
      for (const p of orphanPorts) {
        if (p.port == null) continue;
        setBusyFor(p.id, "Libération du port");
        try {
          await api.freePort(p.port);
        } catch (e) {
          console.error(e);
        } finally {
          setBusyFor(p.id, null);
        }
      }
    });
    refreshPorts();
  }, [orphanPorts, refreshPorts, track]);

  // ----- Busy -----
  const setBusyFor = (id: string, label: string | null) =>
    setBusy((b) => {
      const n = { ...b };
      if (label) n[id] = label;
      else delete n[id];
      return n;
    });

  // ----- Modal de branche (renvoie une promesse) -----
  const askBranch = useCallback(
    (p: Project): Promise<{ branch: string; isNew: boolean } | null> => {
      setBranchModal({
        projectId: p.id,
        projectName: p.name,
        current: gitMap[p.id]?.branch ?? "—",
        branches: [],
        loading: true,
      });
      api
        .listBranches(bash, p.path)
        .then((bs) =>
          setBranchModal((m) =>
            m && m.projectId === p.id ? { ...m, branches: bs, loading: false } : m,
          ),
        )
        .catch(() =>
          setBranchModal((m) => (m && m.projectId === p.id ? { ...m, loading: false } : m)),
        );
      return new Promise<{ branch: string; isNew: boolean } | null>((resolve) => {
        branchResolver.current = resolve;
      });
    },
    [bash, gitMap],
  );

  function closeBranch(result: { branch: string; isNew: boolean } | null) {
    branchResolver.current?.(result);
    branchResolver.current = null;
    setBranchModal(null);
  }

  // ----- Console : ouvrir / épingler un onglet -----
  const openConsole = useCallback((id: string) => {
    // ré-affiche un onglet qu'on aurait fermé
    setClosedTabs((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    setOpenTabs((s) => {
      if (s.has(id)) return s;
      const n = new Set(s);
      n.add(id);
      return n;
    });
    setActiveConsole(id);
  }, []);

  // Masque un onglet (sans toucher aux logs) : il réapparaît via « Console ».
  const closeConsole = useCallback((id: string) => {
    setClosedTabs((s) => {
      const n = new Set(s);
      n.add(id);
      return n;
    });
    setOpenTabs((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);

  // ----- Actions -----
  const startProject = useCallback(
    async (p: Project) => {
      if (!p.start_command) return;
      openConsole(p.id);
      try {
        await api.startService(p.id, p.path, p.start_command, bash, p.port);
      } catch (e) {
        console.error(e);
      }
    },
    [bash, openConsole],
  );

  const stopProject = useCallback(async (p: Project) => {
    try {
      await api.stopService(p.id);
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Écrit une ligne directement dans la console d'un projet (pour les actions
  // qui ne passent pas par un process : liaison de package).
  const pushLocal = useCallback(
    (target: string, line: string, stream: "out" | "err" | "sys" = "sys") => {
      logBuf.current.push(tagKey({ target, line, stream, ts: Date.now() }));
    },
    [],
  );

  // Après (dé)liaison d'un package dans un service : on arrête le service s'il
  // tournait, on retire le package de node_modules, npm install, puis on relance.
  const postLink = useCallback(
    async (svcId: string, svcPath: string, depName: string, token?: StepToken) => {
      const project = projects.find((p) => p.id === svcId);
      const wasRunning = running.has(svcId);
      const rid = () => token?.runId ?? uid();
      openConsole(svcId);
      setBusyFor(svcId, "MAJ du lien…");
      try {
        if (token?.cancelled) return;
        if (wasRunning) {
          pushLocal(svcId, "■ arrêt avant mise à jour du lien", "sys");
          await api.stopService(svcId);
        }
        if (token?.cancelled) return;
        // Supprime uniquement CE package dans node_modules, où qu'il soit :
        //  - à la racine       node_modules/<nom>
        //  - dans un sous-dossier (scoped, ou autre)  node_modules/*/<nom>
        //  - copies imbriquées (hoisting)  */node_modules/<nom>
        // On ne supprime que de VRAIS packages (présence d'un package.json) ou
        // un lien symbolique déjà posé — jamais un dossier homonyme quelconque.
        // rm -rf gère aussi bien un dossier réel qu'un symlink. Ensuite npm
        // install réinstalle en lien symbolique (package.json -> chemin local).
        const base = depName.split("/").pop() ?? depName;
        const rmCmd =
          `name="${depName}"; base="${base}"; ` +
          `{ printf '%s\\n' "node_modules/$name"; ` +
          `find node_modules -mindepth 2 -maxdepth 2 -name "$base" ! -path "*/.bin/*" 2>/dev/null; ` +
          `find node_modules -path "*/node_modules/$name" -prune 2>/dev/null; } ` +
          `| sort -u | while IFS= read -r d; do ` +
          `[ -n "$d" ] || continue; ` +
          `if [ -L "$d" ] || [ -f "$d/package.json" ]; then echo "suppression: $d"; rm -rf "$d"; fi; ` +
          `done`;
        await api.runAction(rid(), svcId, svcPath, rmCmd, bash);
        if (token?.cancelled) return;
        await api.runAction(rid(), svcId, svcPath, "npm install", bash);
        if (token?.cancelled) return;
        if (wasRunning && project?.start_command) {
          pushLocal(svcId, "▶ redémarrage", "sys");
          await api.startService(svcId, svcPath, project.start_command, bash, project.port);
        }
      } catch (e) {
        pushLocal(svcId, `✖ ${e}`, "err");
      } finally {
        setBusyFor(svcId, null);
      }
    },
    [bash, projects, running, openConsole, pushLocal],
  );

  // Lie (chemin local) ou restaure (version) le package dans tous les services
  // qui le déclarent. Renvoie un code (0 = succès).
  const runPackageDep = useCallback(
    async (p: Project, link: boolean, token?: StepToken): Promise<number> => {
      try {
        const meta = await api.readPackageJson(p.path);
        const value = link ? `../../packages/${p.name}` : meta.version;
        const services = await api.packageLinks(servicesForLinks(projects), meta.name);
        const present = services.filter((s) => s.present);
        pushLocal(p.id, `$ ${link ? "Lier" : "Restaurer"} ${meta.name} → ${value}`, "sys");
        if (!present.length) {
          pushLocal(p.id, `Aucun service n'utilise ${meta.name} — rien à faire.`, "sys");
          return 0;
        }
        for (const s of present) {
          if (token?.cancelled) break;
          try {
            await api.setDepVersion(s.path, meta.name, value);
            pushLocal(p.id, `✔ ${s.name} — reinstallation…`, "out");
            await postLink(s.id, s.path, meta.name, token);
          } catch (e) {
            pushLocal(p.id, `✖ ${s.name} : ${e}`, "err");
          }
        }
        pushLocal(p.id, `✔ terminé (${present.length} service${present.length > 1 ? "s" : ""})`, "sys");
        setLinkVersion((v) => v + 1);
        return token?.cancelled ? 1 : 0;
      } catch (e) {
        pushLocal(p.id, `✖ ${e}`, "err");
        return 1;
      }
    },
    [projects, pushLocal, postLink],
  );

  // Exécute une action (bash, démarrage/arrêt, tests, ou opération de package).
  const executeAction = useCallback(
    async (p: Project, a: ActionDef, branch?: string, token?: StepToken): Promise<number> => {
      const runId = token?.runId ?? uid();
      if (a.kind === "start") {
        await startProject(p);
        return 0;
      }
      if (a.kind === "stop") {
        if (running.has(p.id)) await stopProject(p);
        return 0;
      }
      if (a.kind === "restart") {
        if (running.has(p.id)) await stopProject(p);
        await startProject(p);
        return 0;
      }
      if (a.kind === "link") return runPackageDep(p, true, token);
      if (a.kind === "restore") return runPackageDep(p, false, token);
      if (a.kind === "test") {
        openConsole(p.id);
        try {
          const res = await api.runTests(runId, p.id, p.path, a.command || "npm run test:sq", bash);
          setTestResults((m) => ({ ...m, [p.id]: res }));
          return res.failed > 0 ? 1 : 0;
        } catch (e) {
          console.error(e);
          return 1;
        }
      }
      const cmd = a.command.replace("{branch}", branch ?? "");
      return api.runAction(runId, p.id, p.path, cmd, bash);
    },
    [bash, running, openConsole, startProject, stopProject, runPackageDep],
  );

  // ----- File d'exécution (jobs) -----
  function patchStep(jobId: string, stepId: string, status: JobStatus) {
    setJobs((js) =>
      js.map((j) =>
        j.id === jobId
          ? { ...j, steps: j.steps.map((s) => (s.id === stepId ? { ...s, status } : s)) }
          : j,
      ),
    );
  }
  function patchJob(jobId: string, status: JobStatus) {
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, status } : j)));
  }
  function createJob(title: string, project: Project, plan: StepPlan[]): QJob {
    const steps = plan.map((s) => {
      const id = uid();
      tokensRef.current.set(id, { cancelled: false, runId: uid() });
      return { id, label: s.action.label, status: "pending" as JobStatus };
    });
    return {
      id: uid(),
      title,
      projectId: project.id,
      projectName: project.name,
      steps,
      status: "pending",
      cancellable: true,
    };
  }

  const processJob = useCallback(
    async (job: QJob, project: Project, plan: StepPlan[]) => {
      if (jobCancelRef.current.has(job.id)) {
        job.steps.forEach((s) => patchStep(job.id, s.id, "cancelled"));
        patchJob(job.id, "cancelled");
        jobCancelRef.current.delete(job.id);
        return;
      }
      patchJob(job.id, "running");
      openConsole(project.id);
      setBusyFor(project.id, job.title);
      let failed = false;
      let cancelled = false;
      for (let i = 0; i < plan.length; i++) {
        const step = job.steps[i];
        const token = tokensRef.current.get(step.id)!;
        if (token.cancelled) {
          patchStep(job.id, step.id, "cancelled");
          cancelled = true;
          continue;
        }
        patchStep(job.id, step.id, "running");
        let code = 1;
        try {
          code = await executeAction(project, plan[i].action, plan[i].branch, token);
        } catch (e) {
          console.error(e);
          code = 1;
        }
        if (token.cancelled) {
          patchStep(job.id, step.id, "cancelled");
          cancelled = true;
          for (let k = i + 1; k < job.steps.length; k++) {
            const t = tokensRef.current.get(job.steps[k].id);
            if (t) t.cancelled = true;
            patchStep(job.id, job.steps[k].id, "cancelled");
          }
          break;
        }
        if (code !== 0) {
          patchStep(job.id, step.id, "failed");
          failed = true;
          for (let k = i + 1; k < job.steps.length; k++) {
            patchStep(job.id, job.steps[k].id, "cancelled");
          }
          break;
        }
        patchStep(job.id, step.id, "done");
      }
      setBusyFor(project.id, null);
      refreshGitFor(project);
      patchJob(job.id, cancelled ? "cancelled" : failed ? "failed" : "done");
      job.steps.forEach((s) => tokensRef.current.delete(s.id));
      jobCancelRef.current.delete(job.id);
    },
    [executeAction, openConsole, refreshGitFor],
  );

  // Enchaîne les jobs d'un même projet (file d'attente par projet) : si une
  // action tourne déjà, la nouvelle attend la fin de la précédente.
  const chain = useCallback(
    (job: QJob, project: Project, plan: StepPlan[]): Promise<void> => {
      const prev = projectChains.current.get(project.id) ?? Promise.resolve();
      const next = prev.then(() => processJob(job, project, plan)).catch(() => {});
      projectChains.current.set(project.id, next);
      return next;
    },
    [processJob],
  );

  const runActionOn = useCallback(
    (p: Project, a: ActionDef, branch?: string) => {
      const plan: StepPlan[] = [{ action: a, branch }];
      const job = createJob(a.label, p, plan);
      setJobs((js) => [job, ...js]);
      return chain(job, p, plan);
    },
    [chain],
  );

  const runSequenceOn = useCallback(
    async (p: Project, seq: Sequence) => {
      if (!isSequenceValid(seq, allActions, sequences)) return; // séquence invalide : on ne joue pas
      const plan: StepPlan[] = [];
      for (const a of expandActions(seq, allActions, sequences)) {
        if (!actionAllowed(a, p)) continue;
        if (a.needsBranch) {
          const b = await askBranch(p);
          if (!b) continue;
          // Nouvelle branche → création (-b) au lieu d'un simple checkout.
          const action =
            b.isNew && a.command.includes("git checkout {branch}")
              ? { ...a, command: a.command.replace("git checkout {branch}", "git checkout -b {branch}") }
              : a;
          plan.push({ action, branch: b.branch });
        } else {
          plan.push({ action: a });
        }
      }
      if (!plan.length) return;
      const job = createJob(`Séquence « ${seq.name} »`, p, plan);
      setJobs((js) => [job, ...js]);
      await chain(job, p, plan);
    },
    [askBranch, chain, allActions, sequences],
  );

  const cancelStep = useCallback((jobId: string, stepId: string) => {
    const token = tokensRef.current.get(stepId);
    if (token) {
      token.cancelled = true;
      api.cancelAction(token.runId);
    }
    setJobs((js) =>
      js.map((j) =>
        j.id === jobId
          ? {
              ...j,
              steps: j.steps.map((s) =>
                s.id === stepId && (s.status === "running" || s.status === "pending")
                  ? { ...s, status: "cancelled" }
                  : s,
              ),
            }
          : j,
      ),
    );
  }, []);

  const cancelJob = useCallback((jobId: string) => {
    jobCancelRef.current.add(jobId);
    const job = jobsRef.current.find((j) => j.id === jobId);
    job?.steps.forEach((s) => {
      const t = tokensRef.current.get(s.id);
      if (t && (s.status === "running" || s.status === "pending")) {
        t.cancelled = true;
        api.cancelAction(t.runId);
      }
    });
    setJobs((js) =>
      js.map((j) =>
        j.id === jobId
          ? {
              ...j,
              status: "cancelled",
              steps: j.steps.map((s) =>
                s.status === "done" || s.status === "failed" ? s : { ...s, status: "cancelled" },
              ),
            }
          : j,
      ),
    );
  }, []);

  const clearJobs = useCallback(() => {
    setJobs((js) => js.filter((j) => j.status === "running" || j.status === "pending"));
  }, []);

  // Handlers stables passés aux lignes de projets (nécessaire pour que leur
  // mémoïsation tienne : une arrow inline casserait React.memo).
  const onStartRow = useCallback(
    (p: Project) => {
      const a = resolveAction("start");
      if (a) runActionOn(p, a);
    },
    [resolveAction, runActionOn],
  );
  const onStopRow = useCallback(
    (p: Project) => {
      const a = resolveAction("stop");
      if (a) runActionOn(p, a);
    },
    [resolveAction, runActionOn],
  );
  const onRunTestsRow = useCallback(
    (p: Project) => {
      const a = resolveAction("test");
      if (a) runActionOn(p, a);
    },
    [resolveAction, runActionOn],
  );
  const onOpenConsoleRow = useCallback((p: Project) => openConsole(p.id), [openConsole]);

  // Commande saisie manuellement dans la console d'un projet.
  const runCommandIn = useCallback(
    (target: string, command: string) => {
      const p = projects.find((pr) => pr.id === target);
      if (!p) return;
      runActionOn(p, { id: `cmd-${uid()}`, label: command, command, kind: "bash" });
    },
    [projects, runActionOn],
  );

  const checkout = useCallback(
    async (p: Project) => {
      const res = await askBranch(p);
      if (!res || res.branch === gitMap[p.id]?.branch) return;
      // Nouvelle branche → création (-b) ; sinon bascule simple (git crée le
      // tracking local d'une branche distante au besoin).
      const command = res.isNew ? "git checkout -b {branch}" : "git checkout {branch}";
      await runActionOn(
        p,
        { id: "checkout", label: "Changer de branche", command },
        res.branch,
      );
    },
    [askBranch, gitMap, runActionOn],
  );

  // ----- Édition du fichier .env -----
  const openEnv = useCallback(
    (p: Project) => {
      setEnvModal({
        projectId: p.id,
        projectName: p.name,
        path: p.path,
        original: "",
        running: running.has(p.id),
        loading: true,
        saving: false,
      });
      api
        .readEnv(p.path)
        .then((content) =>
          setEnvModal((m) =>
            m && m.projectId === p.id ? { ...m, original: content, loading: false } : m,
          ),
        )
        .catch((e) =>
          setEnvModal((m) =>
            m && m.projectId === p.id
              ? { ...m, loading: false, error: String(e) }
              : m,
          ),
        );
    },
    [running],
  );

  const saveEnv = useCallback(
    async (content: string) => {
      const m = envModal;
      if (!m) return;
      const p = projects.find((x) => x.id === m.projectId);
      if (!p) return;
      const changed = content !== m.original;
      setEnvModal((cur) => (cur ? { ...cur, saving: true, error: undefined } : cur));
      try {
        await api.saveEnv(p.path, content);
        // Redémarrage uniquement si le contenu a réellement changé et que le
        // service tourne (même logique que l'action « Redémarrer »).
        if (changed && running.has(p.id) && p.start_command) {
          pushLocal(p.id, "▶ .env modifié — redémarrage du service", "sys");
          await stopProject(p);
          await startProject(p);
        }
        setEnvModal(null);
      } catch (e) {
        setEnvModal((cur) => (cur ? { ...cur, saving: false, error: String(e) } : cur));
      }
    },
    [envModal, projects, running, pushLocal, stopProject, startProject],
  );

  // ----- Liaison package <-> service -----
  const openPackageLinks = useCallback(
    async (p: Project) => {
      setLinkModal({
        pkg: p,
        depName: "",
        version: "",
        folder: p.name,
        services: [],
        loading: true,
      });
      try {
        const meta = await api.readPackageJson(p.path);
        const services = await api.packageLinks(servicesForLinks(projects), meta.name);
        setLinkModal((m) =>
          m && m.pkg.id === p.id
            ? { ...m, depName: meta.name, version: meta.version, services, loading: false }
            : m,
        );
      } catch (e) {
        setLinkModal((m) =>
          m && m.pkg.id === p.id ? { ...m, loading: false, error: String(e) } : m,
        );
      }
    },
    [projects],
  );

  const applyLink = useCallback(
    async (svc: ServiceDep, link: boolean) => {
      const m = linkModalRef.current;
      if (!m) return;
      const value = link ? `../../packages/${m.folder}` : m.version;
      setLinkBusy(svc.id);
      try {
        await api.setDepVersion(svc.path, m.depName, value);
        await postLink(svc.id, svc.path, m.depName);
        const services = await api.packageLinks(servicesForLinks(projects), m.depName);
        setLinkModal((cur) => (cur && cur.pkg.id === m.pkg.id ? { ...cur, services } : cur));
        setLinkVersion((v) => v + 1);
      } catch (e) {
        setLinkModal((cur) => (cur ? { ...cur, error: String(e) } : cur));
      } finally {
        setLinkBusy(null);
      }
    },
    [projects, postLink],
  );

  // ----- Séquences générales (multi-services) -----
  const runGeneralSequence = useCallback(
    async (seq: Sequence, targetIds: string[], branch: string) => {
      if (!isSequenceValid(seq, allActions, sequences)) return; // séquence invalide : on ne joue pas
      const expanded = expandActions(seq, allActions, sequences);
      const targets = allProjects.filter((p) => targetIds.includes(p.id));
      const built = targets
        .map((p) => {
          const plan: StepPlan[] = [];
          for (const a of expanded) {
            if (!actionAllowed(a, p)) continue;
            if (a.needsBranch && !branch) continue;
            plan.push({ action: a, branch: a.needsBranch ? branch : undefined });
          }
          return { job: createJob(`Séquence « ${seq.name} »`, p, plan), project: p, plan };
        })
        .filter((b) => b.plan.length > 0);
      if (!built.length) return;
      setJobs((js) => [...built.map((b) => b.job), ...js]);
      // chaque projet s'exécute dans sa propre file (en parallèle entre projets)
      built.forEach((b) => chain(b.job, b.project, b.plan));
    },
    [allProjects, chain, allActions, sequences],
  );

  // ----- Actions globales -----
  const startAll = useCallback(() => {
    allProjects
      .filter((p) => p.start_command && !running.has(p.id) && !busy[p.id])
      .forEach((p) => startProject(p));
  }, [allProjects, running, busy, startProject]);

  const stopAll = useCallback(() => {
    allProjects.filter((p) => running.has(p.id)).forEach((p) => stopProject(p));
  }, [allProjects, running, stopProject]);

  const restartAll = useCallback(() => {
    const a = resolveAction("restart");
    if (!a) return;
    allProjects
      .filter((p) => p.start_command && running.has(p.id))
      .forEach((p) => runActionOn(p, a));
  }, [allProjects, running, runActionOn, resolveAction]);

  // ----- Config -----
  const persist = useCallback(async (next: Config) => {
    setConfig(next);
    await api.saveConfig(next);
  }, []);

  // ----- Connexion base de données -----
  const openDb = useCallback(
    (p: Project) => {
      setDbModal({
        projectId: p.id,
        projectName: p.name,
        env: {},
        keys: [],
        saved: config?.db_connections?.[p.id] ?? null,
        loading: true,
      });
      api
        .readEnv(p.path)
        .then((content) => {
          const env = parseEnv(content);
          setDbModal((m) =>
            m && m.projectId === p.id
              ? { ...m, env, keys: Object.keys(env), loading: false }
              : m,
          );
        })
        .catch((e) =>
          setDbModal((m) =>
            m && m.projectId === p.id ? { ...m, loading: false, error: String(e) } : m,
          ),
        );
    },
    [config],
  );

  // Résout les valeurs (clés .env → valeurs) et teste la connexion côté Rust.
  const resolveAndTest = useCallback(
    async (
      conn: DbConnection,
      env: Record<string, string>,
    ): Promise<{ ok: boolean; message: string }> => {
      const v = resolveDbValues(conn, env);
      if (!v.portValid) {
        return { ok: false, message: `Port invalide : « ${v.portRaw} »` };
      }
      try {
        const version = await api.dbConnect(
          conn.driver,
          v.host,
          v.port,
          v.user,
          v.password,
          v.database,
        );
        return { ok: true, message: version };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [],
  );

  // Persiste le mapping (sans identifiants) avec le drapeau `verified` : c'est
  // lui qui pilote la couleur du bouton BDD.
  const saveDbConn = useCallback(
    async (projectId: string, conn: DbConnection, ok: boolean) => {
      const cfg = configRef.current;
      if (!cfg) return;
      const saved: DbConnection = { ...conn, verified: ok };
      await persist({
        ...cfg,
        db_connections: { ...cfg.db_connections, [projectId]: saved },
      });
    },
    [persist],
  );

  // Enregistre le mapping puis teste la connexion (depuis la modale).
  const dbConnect = useCallback(
    async (conn: DbConnection): Promise<{ ok: boolean; message: string }> => {
      const m = dbModal;
      if (!m) return { ok: false, message: "Fenêtre fermée." };
      const result = await resolveAndTest(conn, m.env);
      await saveDbConn(m.projectId, conn, result.ok);
      setDbModal((cur) => (cur ? { ...cur, saved: { ...conn, verified: result.ok } } : cur));
      // La modale se ferme en cas de succès : on trace le résultat côté service.
      pushLocal(
        m.projectId,
        result.ok ? `✓ BDD connectée — ${result.message}` : `✗ BDD : ${result.message}`,
        "sys",
      );
      return result;
    },
    [dbModal, resolveAndTest, saveDbConn, pushLocal],
  );

  // Re-teste la connexion enregistrée directement depuis le bouton BDD de la
  // ligne (relit le .env pour résoudre les valeurs). Affiche un loader et met à
  // jour l'état vérifié/non-vérifié selon le résultat.
  const retestDb = useCallback(
    async (p: Project) => {
      const conn = configRef.current?.db_connections?.[p.id];
      if (!conn || dbTesting.has(p.id)) return;
      setDbTesting((s) => new Set(s).add(p.id));
      try {
        const content = await api.readEnv(p.path).catch(() => "");
        const result = await resolveAndTest(conn, parseEnv(content));
        await saveDbConn(p.id, conn, result.ok);
        pushLocal(
          p.id,
          result.ok ? `✓ BDD connectée — ${result.message}` : `✗ BDD : ${result.message}`,
          "sys",
        );
      } finally {
        setDbTesting((s) => {
          const n = new Set(s);
          n.delete(p.id);
          return n;
        });
      }
    },
    [dbTesting, resolveAndTest, saveDbConn, pushLocal],
  );

  // ----- Espace de travail BDD : liste des tables + onglets -----

  /** Ouvre l'espace de travail d'un service : connexion + liste des tables. */
  const openDbWorkspace = useCallback(
    async (p: Project) => {
      const conn = configRef.current?.db_connections?.[p.id];
      if (!conn) return;
      // Espace déjà ouvert pour ce projet : on l'active simplement au lieu de
      // tout reconstruire — les onglets et saisies en cours sont préservés.
      if (dbWsMapRef.current[p.id]) {
        setActiveDbId(p.id);
        setDbWsHidden(false);
        return;
      }
      setActiveDbId(p.id);
      setDbWsHidden(false);
      setDbWsMap((m) => ({
        ...m,
        [p.id]: {
          projectId: p.id,
          projectName: p.name,
          driver: conn.driver,
          database: "",
          tables: [],
          loading: true,
        },
      }));
      setDbActiveTabMap((m) => ({ ...m, [p.id]: null }));
      setDbGraphMap((m) => ({ ...m, [p.id]: EMPTY_DB_GRAPH }));
      setDbGraphOpenMap((m) => ({ ...m, [p.id]: false }));
      graphAskedRef.current.delete(p.id);
      const content = await api.readEnv(p.path).catch(() => "");
      const v = resolveDbValues(conn, parseEnv(content));
      // Diagnostic : trace la cible réellement résolue (clé base → valeur), pour
      // lever toute ambiguïté quand plusieurs services partagent un serveur.
      pushLocal(
        p.id,
        `🗄 Connexion ${p.name} → ${v.host}:${v.port}/${v.database || "(vide)"} ` +
          `[base via ${conn.databaseKey || "?"}]`,
        "sys",
      );
      const patch = (fn: (s: DbWsState) => DbWsState) => patchWs(p.id, fn);
      if (!v.portValid) {
        patch((s) => ({ ...s, loading: false, error: `Port invalide : « ${v.portRaw} »` }));
        await saveDbConn(p.id, conn, false);
        return;
      }
      try {
        const tables = await api.dbTables(
          conn.driver,
          v.host,
          v.port,
          v.user,
          v.password,
          v.database,
        );
        patch((s) => ({ ...s, database: v.database, tables, loading: false }));
        await saveDbConn(p.id, conn, true);
      } catch (e) {
        patch((s) => ({ ...s, loading: false, error: String(e) }));
        await saveDbConn(p.id, conn, false);
      }
    },
    [saveDbConn, pushLocal],
  );

  /** Recharge la liste des tables sans toucher aux onglets ouverts. */
  const refreshWsTables = useCallback(async () => {
    const ws = activeWs();
    if (!ws) return;
    const pid = ws.projectId;
    const conn = configRef.current?.db_connections?.[pid];
    const p = projects.find((x) => x.id === pid);
    if (!conn || !p) return;
    patchWs(pid, (s) => ({ ...s, loading: true, error: undefined }));
    const content = await api.readEnv(p.path).catch(() => "");
    const v = resolveDbValues(conn, parseEnv(content));
    if (!v.portValid) {
      patchWs(pid, (s) => ({ ...s, loading: false, error: `Port invalide : « ${v.portRaw} »` }));
      return;
    }
    try {
      const tables = await api.dbTables(conn.driver, v.host, v.port, v.user, v.password, v.database);
      patchWs(pid, (s) => ({ ...s, database: v.database, tables, loading: false }));
    } catch (e) {
      patchWs(pid, (s) => ({ ...s, loading: false, error: String(e) }));
    }
  }, [projects]);

  /** Charge (ou recharge) un onglet : page 0, avec limite et filtre donnés. */
  const loadTab = useCallback(
    async (tabId: string, projectId: string, table: string, limit: number, filter: string) => {
      const conn = configRef.current?.db_connections?.[projectId];
      const p = projects.find((x) => x.id === projectId);
      if (!conn || !p) return;
      const loadId = ++dbLoadSeq.current;
      setDbTabs((ts) =>
        ts.map((t) =>
          t.id !== tabId
            ? t
            : {
                ...t,
                data: {
                  ...t.data,
                  projectId,
                  projectName: p.name,
                  driver: conn.driver,
                  table,
                  // Conserve l'affichage si on recharge la même table.
                  columns: t.data.table === table ? t.data.columns : [],
                  types: t.data.table === table ? t.data.types : [],
                  editors: t.data.table === table ? t.data.editors : [],
                  enums: t.data.table === table ? t.data.enums : [],
                  required: t.data.table === table ? t.data.required : [],
                  fks: t.data.table === table ? t.data.fks : [],
                  rows: t.data.table === table ? t.data.rows : [],
                  loadId,
                  limit,
                  filter,
                  loading: true,
                  hasMore: false,
                  loadingMore: false,
                  restoreScroll: undefined,
                  error: undefined,
                },
              },
        ),
      );
      // N'applique le résultat que si l'onglet n'a pas été rechargé entre-temps.
      const applyFresh = (fn: (d: DbDataState) => DbDataState) =>
        setDbTabs((ts) =>
          ts.map((t) =>
            t.id === tabId && t.data.loadId === loadId ? { ...t, data: fn(t.data) } : t,
          ),
        );
      const content = await api.readEnv(p.path).catch(() => "");
      const v = resolveDbValues(conn, parseEnv(content));
      if (!v.portValid) {
        applyFresh((d) => ({ ...d, loading: false, error: `Port invalide : « ${v.portRaw} »` }));
        return;
      }
      try {
        const data = await api.dbTableRows(
          conn.driver,
          v.host,
          v.port,
          v.user,
          v.password,
          v.database,
          table,
          limit,
          0,
          filter,
        );
        applyFresh((d) => ({
          ...d,
          database: v.database,
          columns: data.columns,
          types: data.types,
          editors: data.editors,
          enums: data.enums,
          required: data.required,
          fks: data.fks,
          rows: data.rows,
          loading: false,
          hasMore: data.rows.length >= limit,
        }));
      } catch (e) {
        applyFresh((d) => ({ ...d, loading: false, error: String(e) }));
      }
    },
    [projects],
  );

  /** Ouvre une table dans un onglet (ou réactive l'onglet existant). */
  const openTableTab = useCallback(
    (table: string) => {
      const ws = dbWs;
      if (!ws) return;
      // Ouvrir une table quitte le schéma général (clic sur une boîte).
      setDbGraphOpen(false);
      const existing = dbTabs.find(
        (t) => t.data.projectId === ws.projectId && t.data.table === table,
      );
      if (existing) {
        setDbActiveTab(existing.id);
        return;
      }
      const id = uid();
      const limit = configRef.current?.db_row_limit ?? 200;
      const data: DbDataState = {
        projectId: ws.projectId,
        projectName: ws.projectName,
        driver: ws.driver,
        database: ws.database,
        table,
        columns: [],
        types: [],
        editors: [],
        enums: [],
        required: [],
        fks: [],
        rows: [],
        loadId: 0,
        limit,
        filter: "",
        loading: true,
        hasMore: false,
        loadingMore: false,
      };
      setDbTabs((ts) => [
        ...ts,
        { id, data, navStack: [], view: "data", schema: { table: "", loading: false } },
      ]);
      setDbActiveTab(id);
      void loadTab(id, ws.projectId, table, limit, "");
    },
    [dbWs, dbTabs, loadTab],
  );

  /** Charge la structure de la table affichée dans un onglet. */
  const loadTabSchema = useCallback(
    async (tabId: string) => {
      const tab = dbTabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const { projectId, table } = tab.data;
      const conn = configRef.current?.db_connections?.[projectId];
      const p = projects.find((x) => x.id === projectId);
      if (!conn || !p || !table) return;
      // `schema.table` identifie le chargement en cours : un second chargement
      // (autre table) le remplace et rend obsolètes les patchs du premier.
      const patch = (fn: (s: DbSchemaState) => DbSchemaState) =>
        setDbTabs((ts) =>
          ts.map((t) =>
            t.id === tabId && t.schema.table === table ? { ...t, schema: fn(t.schema) } : t,
          ),
        );
      setDbTabs((ts) =>
        ts.map((t) => (t.id === tabId ? { ...t, schema: { table, loading: true } } : t)),
      );
      const content = await api.readEnv(p.path).catch(() => "");
      const v = resolveDbValues(conn, parseEnv(content));
      if (!v.portValid) {
        patch((s) => ({ ...s, loading: false, error: `Port invalide : « ${v.portRaw} »` }));
        return;
      }
      try {
        const info = await api.dbTableSchema(
          conn.driver,
          v.host,
          v.port,
          v.user,
          v.password,
          v.database,
          table,
        );
        patch((s) => ({ ...s, info, loading: false }));
      } catch (e) {
        patch((s) => ({ ...s, loading: false, error: String(e) }));
      }
    },
    [projects],
  );

  /** Charge le graphe des clés étrangères de la base (une seule lecture, quel
   *  que soit le nombre de vues qui l'affichent). */
  const loadDbGraph = useCallback(async () => {
    const ws = activeWs();
    if (!ws) return;
    const pid = ws.projectId;
    const conn = configRef.current?.db_connections?.[pid];
    const p = projects.find((x) => x.id === pid);
    if (!conn || !p) return;
    setDbGraph((g) => ({ ...g, loading: true, error: undefined }), pid);
    const content = await api.readEnv(p.path).catch(() => "");
    const v = resolveDbValues(conn, parseEnv(content));
    if (!v.portValid) {
      setDbGraph((g) => ({ ...g, loading: false, error: `Port invalide : « ${v.portRaw} »` }), pid);
      return;
    }
    try {
      const data = await api.dbGraph(
        conn.driver,
        v.host,
        v.port,
        v.user,
        v.password,
        v.database,
      );
      setDbGraph({ ...data, loading: false, loaded: true }, pid);
    } catch (e) {
      setDbGraph((g) => ({ ...g, loading: false, error: String(e) }), pid);
    }
  }, [projects]);

  /** Enregistre la disposition du schéma d'un projet (positions + courbures). */
  const saveGraphLayout = useCallback(
    (projectId: string, layout: DbGraphLayout) => {
      const cfg = configRef.current;
      if (!cfg) return;
      void persist({
        ...cfg,
        db_layouts: { ...(cfg.db_layouts ?? {}), [projectId]: layout },
      });
    },
    [persist],
  );

  /** Charge le graphe à la première demande seulement (le ref évite un second
   *  chargement lorsque plusieurs vues s'affichent dans le même rendu). */
  const graphAskedRef = useRef<Set<string>>(new Set());
  const ensureDbGraph = useCallback(() => {
    const pid = activeDbIdRef.current;
    if (!pid || graphAskedRef.current.has(pid)) return;
    graphAskedRef.current.add(pid);
    void loadDbGraph();
  }, [loadDbGraph]);

  /** Colonnes d'une table, pour les listes déroulantes de l'onglet Structure.
   *  Mémorisées par « projet:table » et vidées au changement d'espace de travail. */
  const loadTableColumns = useCallback(
    async (target: string): Promise<string[]> => {
      const ws = activeWs();
      if (!ws) return [];
      const cacheKey = `${ws.projectId}:${target}`;
      const hit = colCacheRef.current.get(cacheKey);
      if (hit) return hit;
      const conn = configRef.current?.db_connections?.[ws.projectId];
      const p = projects.find((x) => x.id === ws.projectId);
      if (!conn || !p) return [];
      const content = await api.readEnv(p.path).catch(() => "");
      const v = resolveDbValues(conn, parseEnv(content));
      if (!v.portValid) return [];
      try {
        const cols = await api.dbTableColumns(
          conn.driver,
          v.host,
          v.port,
          v.user,
          v.password,
          v.database,
          target,
        );
        colCacheRef.current.set(cacheKey, cols);
        return cols;
      } catch {
        return [];
      }
    },
    [projects],
  );

  /** Applique les modifications de structure d'un onglet (ALTER TABLE). */
  const applyTabSchema = useCallback(
    async (
      tabId: string,
      changes: DbSchemaChange[],
    ): Promise<{ ok: boolean; message: string }> => {
      const tab = dbTabsRef.current.find((t) => t.id === tabId);
      if (!tab) return { ok: false, message: "Onglet fermé." };
      const { projectId, table, limit, filter } = tab.data;
      const conn = configRef.current?.db_connections?.[projectId];
      const p = projects.find((x) => x.id === projectId);
      if (!conn || !p) return { ok: false, message: "Service introuvable." };
      const content = await api.readEnv(p.path).catch(() => "");
      const v = resolveDbValues(conn, parseEnv(content));
      if (!v.portValid) return { ok: false, message: `Port invalide : « ${v.portRaw} »` };
      try {
        const res = await api.dbAlterTable(
          conn.driver,
          v.host,
          v.port,
          v.user,
          v.password,
          v.database,
          table,
          changes,
        );
        const summary = `${res.added} ajoutée(s), ${res.modified} modifiée(s), ${res.dropped} supprimée(s)`;
        pushLocal(projectId, `🧬 ${table} : ${summary}`, "sys");
        for (const s of res.statements) pushLocal(projectId, `   ${s}`, "sys");
        // Les colonnes ont changé : le cache des listes déroulantes (de cette
        // base) est périmé.
        for (const k of [...colCacheRef.current.keys()])
          if (k.startsWith(`${projectId}:`)) colCacheRef.current.delete(k);
        // Une contrainte a pu créer ou supprimer une clé étrangère.
        if (graphAskedRef.current.has(projectId)) void loadDbGraph();
        // Les colonnes ont changé : structure *et* données doivent être relues.
        await loadTabSchema(tabId);
        void loadTab(tabId, projectId, table, limit, filter);
        return { ok: true, message: summary };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [projects, loadTabSchema, loadTab, pushLocal, loadDbGraph],
  );

  /** Bascule entre les sous-onglets d'une table ; charge la structure au besoin. */
  const setTabView = useCallback(
    (tabId: string, view: DbTabView) => {
      setDbTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, view } : t)));
      if (view === "relations") {
        ensureDbGraph();
        return;
      }
      if (view !== "schema") return;
      const tab = dbTabsRef.current.find((t) => t.id === tabId);
      // Structure absente ou obsolète (la table a changé en suivant une FK).
      if (tab && !tab.schema.loading && tab.schema.table !== tab.data.table) {
        void loadTabSchema(tabId);
      }
    },
    [loadTabSchema, ensureDbGraph],
  );

  const closeDbTab = useCallback(
    (id: string) => {
      const tab = dbTabs.find((t) => t.id === id);
      const pid = tab?.data.projectId;
      // Onglet suivant choisi parmi ceux de la MÊME base.
      const sameProject = dbTabs.filter((t) => t.data.projectId === pid);
      const idx = sameProject.findIndex((t) => t.id === id);
      const remaining = sameProject.filter((t) => t.id !== id);
      setDbTabs((ts) => ts.filter((t) => t.id !== id));
      if (pid && dbActiveTabMap[pid] === id) {
        setDbActiveTab(remaining[Math.min(idx, remaining.length - 1)]?.id ?? null, pid);
      }
      setDbDirty((d) => {
        const n = { ...d };
        delete n[id];
        return n;
      });
    },
    [dbTabs, dbActiveTabMap],
  );

  /** Active (affiche) une base déjà ouverte. */
  const focusDbWorkspace = useCallback((pid: string) => {
    setActiveDbId(pid);
    setDbWsHidden(false);
  }, []);

  /** Ferme entièrement une base (onglets + état) ; active une autre s'il reste. */
  const closeDbWorkspace = useCallback((pid: string) => {
    const closedIds = new Set(
      dbTabsRef.current.filter((t) => t.data.projectId === pid).map((t) => t.id),
    );
    setDbTabs((ts) => ts.filter((t) => t.data.projectId !== pid));
    setDbDirty((d) => {
      const n = { ...d };
      for (const k of Object.keys(n)) if (closedIds.has(k)) delete n[k];
      return n;
    });
    setDbWsMap((m) => {
      const n = { ...m };
      delete n[pid];
      return n;
    });
    setDbActiveTabMap((m) => {
      const n = { ...m };
      delete n[pid];
      return n;
    });
    setDbGraphMap((m) => {
      const n = { ...m };
      delete n[pid];
      return n;
    });
    setDbGraphOpenMap((m) => {
      const n = { ...m };
      delete n[pid];
      return n;
    });
    graphAskedRef.current.delete(pid);
    for (const k of [...colCacheRef.current.keys()])
      if (k.startsWith(`${pid}:`)) colCacheRef.current.delete(k);
    setActiveDbId((cur) => {
      if (cur !== pid) return cur;
      const rest = Object.keys(dbWsMapRef.current).filter((x) => x !== pid);
      return rest[0] ?? null;
    });
  }, []);

  /** Scroll infini : ajoute la page suivante (OFFSET) aux lignes de l'onglet. */
  const loadMoreTab = useCallback(
    async (tabId: string) => {
      const tab = dbTabs.find((t) => t.id === tabId);
      if (!tab) return;
      const d = tab.data;
      if (d.loading || d.loadingMore || !d.hasMore || loadingMoreRef.current) return;
      const conn = configRef.current?.db_connections?.[d.projectId];
      const p = projects.find((x) => x.id === d.projectId);
      if (!conn || !p) return;
      loadingMoreRef.current = true;
      const { table, filter, limit, loadId } = d;
      const offset = d.rows.length;
      setDbTabs((ts) =>
        ts.map((t) => (t.id === tabId ? { ...t, data: { ...t.data, loadingMore: true } } : t)),
      );
      // Garde anti-course : même onglet, même chargement, même nombre de lignes.
      const applyFresh = (fn: (x: DbDataState) => DbDataState) =>
        setDbTabs((ts) =>
          ts.map((t) =>
            t.id === tabId && t.data.loadId === loadId && t.data.rows.length === offset
              ? { ...t, data: fn(t.data) }
              : t,
          ),
        );
      try {
        const content = await api.readEnv(p.path).catch(() => "");
        const v = resolveDbValues(conn, parseEnv(content));
        if (!v.portValid) {
          applyFresh((x) => ({ ...x, loadingMore: false }));
          return;
        }
        const data = await api.dbTableRows(
          conn.driver,
          v.host,
          v.port,
          v.user,
          v.password,
          v.database,
          table,
          limit,
          offset,
          filter,
        );
        applyFresh((x) => ({
          ...x,
          rows: [...x.rows, ...data.rows],
          loadingMore: false,
          hasMore: data.rows.length >= limit,
        }));
      } catch (e) {
        applyFresh((x) => ({ ...x, loadingMore: false, error: String(e) }));
      } finally {
        loadingMoreRef.current = false;
      }
    },
    [dbTabs, projects],
  );

  /** Change la taille de page (persistée en config) et recharge l'onglet. */
  const changeTabLimit = useCallback(
    (tabId: string, limit: number) => {
      const tab = dbTabs.find((t) => t.id === tabId);
      if (!tab) return;
      const cfg = configRef.current;
      if (cfg && cfg.db_row_limit !== limit) void persist({ ...cfg, db_row_limit: limit });
      void loadTab(tabId, tab.data.projectId, tab.data.table, limit, tab.data.filter);
    },
    [dbTabs, persist, loadTab],
  );

  const changeTabFilter = useCallback(
    (tabId: string, filter: string) => {
      const tab = dbTabs.find((t) => t.id === tabId);
      if (!tab) return;
      void loadTab(tabId, tab.data.projectId, tab.data.table, tab.data.limit, filter);
    },
    [dbTabs, loadTab],
  );

  const refreshTab = useCallback(
    (tabId: string) => {
      const tab = dbTabs.find((t) => t.id === tabId);
      if (!tab) return;
      void loadTab(tabId, tab.data.projectId, tab.data.table, tab.data.limit, tab.data.filter);
    },
    [dbTabs, loadTab],
  );

  /** Suit une clé étrangère dans l'onglet : empile la vue puis charge la cible. */
  const navigateTabFk = useCallback(
    (tabId: string, targetTable: string, filter: string, scrollTop: number) => {
      const tab = dbTabs.find((t) => t.id === tabId);
      if (!tab) return;
      setDbTabs((ts) =>
        ts.map((t) =>
          t.id === tabId ? { ...t, navStack: [...t.navStack, { state: t.data, scrollTop }] } : t,
        ),
      );
      void loadTab(
        tabId,
        tab.data.projectId,
        targetTable,
        configRef.current?.db_row_limit ?? 200,
        filter,
      );
    },
    [dbTabs, loadTab],
  );

  /** Retour : restaure la vue précédente de l'onglet (lignes + scroll). */
  const goBackTab = useCallback((tabId: string) => {
    setDbTabs((ts) =>
      ts.map((t) => {
        if (t.id !== tabId || t.navStack.length === 0) return t;
        const snap = t.navStack[t.navStack.length - 1];
        return {
          ...t,
          data: { ...snap.state, restoreScroll: { top: snap.scrollTop, token: Date.now() } },
          navStack: t.navStack.slice(0, -1),
        };
      }),
    );
  }, []);

  /** Applique en une transaction les changements en attente d'un onglet. */
  const applyTabChanges = useCallback(
    async (
      tabId: string,
      inserts: { column: string; value: string | null }[][],
      updates: DbRowUpdate[],
      deletes: (string | null)[][],
    ): Promise<{ ok: boolean; message: string }> => {
      const tab = dbTabs.find((t) => t.id === tabId);
      if (!tab) return { ok: false, message: "Onglet fermé." };
      const cur = tab.data;
      if (inserts.length === 0 && updates.length === 0 && deletes.length === 0)
        return { ok: true, message: "Rien à enregistrer." };
      const conn = configRef.current?.db_connections?.[cur.projectId];
      const p = projects.find((x) => x.id === cur.projectId);
      if (!conn || !p) return { ok: false, message: "Service introuvable." };
      const content = await api.readEnv(p.path).catch(() => "");
      const v = resolveDbValues(conn, parseEnv(content));
      if (!v.portValid) return { ok: false, message: `Port invalide : « ${v.portRaw} »` };
      try {
        const res = await api.dbApplyChanges(
          conn.driver,
          v.host,
          v.port,
          v.user,
          v.password,
          v.database,
          cur.table,
          cur.columns,
          inserts,
          updates,
          deletes,
        );
        const summary = `${res.inserted} ajoutée(s), ${res.updated} modifiée(s), ${res.deleted} supprimée(s)`;
        pushLocal(cur.projectId, `💾 ${cur.table} : ${summary}`, "sys");
        await loadTab(tabId, cur.projectId, cur.table, cur.limit, cur.filter);
        return { ok: true, message: summary };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [dbTabs, projects, loadTab, pushLocal],
  );
  const onSetupSubmit = useCallback(
    async (srcs: ProjectSource[], b: string, cmd: string) => {
      // Conserve les séquences / actions d'une éventuelle config incomplète
      // (cas d'une ancienne config sans commande de démarrage).
      await persist({
        ...partialConfig,
        projects_root: partialConfig?.projects_root ?? "",
        sources: srcs,
        sources_migrated: true,
        git_bash_path: b,
        start_command: cmd,
        command_overrides: partialConfig?.command_overrides ?? {},
        project_links: partialConfig?.project_links ?? {},
        sequences: partialConfig?.sequences?.length ? partialConfig.sequences : DEFAULT_SEQUENCES,
        custom_actions: seedActions(partialConfig?.custom_actions ?? []),
        action_colors: partialConfig?.action_colors ?? {},
        actions_seeded: true,
        db_connections: partialConfig?.db_connections ?? {},
        db_row_limit: partialConfig?.db_row_limit ?? 200,
        db_disabled: partialConfig?.db_disabled ?? {},
      });
      setPartialConfig(null);
    },
    [persist, partialConfig],
  );

  // ----- Commande de démarrage (modal, ouverte par clic droit) -----
  // project = null : édition de la commande par défaut ; sinon, édition de
  // l'exception propre à ce projet.
  const [cmdModal, setCmdModal] = useState<{ project: Project | null } | null>(null);
  const openStartCommand = useCallback(() => setCmdModal({ project: null }), []);
  const openProjectCommand = useCallback((p: Project) => setCmdModal({ project: p }), []);
  const saveStartCommand = useCallback(
    async (cmd: string | null) => {
      const m = cmdModal;
      setCmdModal(null);
      if (!config || !m) return;
      // Le rescan (déclenché par le changement de config) applique la nouvelle
      // commande aux projets ; ceux déjà lancés la prendront au redémarrage.
      if (m.project) {
        const next = { ...(config.command_overrides ?? {}) };
        if (cmd == null) {
          if (!(m.project.id in next)) return;
          delete next[m.project.id];
        } else {
          if (next[m.project.id] === cmd) return;
          next[m.project.id] = cmd;
        }
        await persist({ ...config, command_overrides: next });
      } else {
        if (cmd == null || cmd === config.start_command) return;
        await persist({ ...config, start_command: cmd });
      }
    },
    [cmdModal, config, persist],
  );

  // ----- Lien de dépôt (ouverture + édition) -----
  // Lien effectif d'un projet : override manuel (config), sinon URL détectée (git).
  const repoLinkFor = useCallback(
    (p: Project) => projectLinks[p.id] || gitMap[p.id]?.repo_url || "",
    [projectLinks, gitMap],
  );
  const [repoModal, setRepoModal] = useState<{ project: Project } | null>(null);
  const openUrl = useCallback((url: string) => {
    if (url) void api.openUrl(url);
  }, []);
  const editRepo = useCallback((p: Project) => setRepoModal({ project: p }), []);
  const saveRepoLink = useCallback(
    async (url: string | null) => {
      const m = repoModal;
      setRepoModal(null);
      if (!config || !m) return;
      const next = { ...(config.project_links ?? {}) };
      if (url == null) {
        if (!(m.project.id in next)) return;
        delete next[m.project.id]; // revient à la détection auto
      } else {
        if (next[m.project.id] === url) return;
        next[m.project.id] = url;
      }
      // project_links ne fait pas partie des déclencheurs de scan : pas de rescan.
      await persist({ ...config, project_links: next });
    },
    [repoModal, config, persist],
  );

  // ----- Page de détail d'un projet -----
  const openDetail = useCallback((p: Project) => setDetailPath(p.path), []);

  // ----- Page des modifications git -----
  const openGitChanges = useCallback((p: Project) => setGitChangesPath(p.path), []);

  // Change le type d'un projet : met à jour sa source ET migre les réglages
  // indexés par id (id = "<kind>:<name>", donc l'id change avec le type).
  const changeProjectType = useCallback(
    async (p: Project, kind: ProjectKind) => {
      if (!config || p.kind === kind) return;
      const oldId = p.id;
      const newId = `${kind}:${p.name}`;
      const nextSources = (config.sources ?? []).map((s) => {
        if (s.mode === "single" && samePath(s.path, p.path)) return { ...s, type: kind };
        if (s.mode === "parent" && samePath(s.path, dirname(p.path))) {
          return { ...s, overrides: { ...(s.overrides ?? {}), [basename(p.path)]: kind } };
        }
        return s;
      });
      const renameKey = <T,>(m: Record<string, T> | undefined): Record<string, T> => {
        const next = { ...(m ?? {}) };
        if (oldId in next) {
          next[newId] = next[oldId];
          delete next[oldId];
        }
        return next;
      };
      await persist({
        ...config,
        sources: nextSources,
        command_overrides: renameKey(config.command_overrides),
        project_links: renameKey(config.project_links),
        repo_actions_hidden: renameKey(config.repo_actions_hidden),
        db_connections: renameKey(config.db_connections),
        db_disabled: renameKey(config.db_disabled),
        db_layouts: renameKey(config.db_layouts),
      });
    },
    [config, persist],
  );

  const setProjectCommand = useCallback(
    async (p: Project, cmd: string | null) => {
      if (!config) return;
      const next = { ...(config.command_overrides ?? {}) };
      if (cmd == null) {
        if (!(p.id in next)) return;
        delete next[p.id];
      } else {
        if (next[p.id] === cmd) return;
        next[p.id] = cmd;
      }
      await persist({ ...config, command_overrides: next });
    },
    [config, persist],
  );

  const setProjectRepo = useCallback(
    async (p: Project, url: string | null) => {
      if (!config) return;
      const next = { ...(config.project_links ?? {}) };
      if (url == null) {
        if (!(p.id in next)) return;
        delete next[p.id];
      } else {
        if (next[p.id] === url) return;
        next[p.id] = url;
      }
      await persist({ ...config, project_links: next });
    },
    [config, persist],
  );

  const toggleDbDisabled = useCallback(
    async (p: Project, disabled: boolean) => {
      if (!config) return;
      const next = { ...(config.db_disabled ?? {}) };
      if (disabled) next[p.id] = true;
      else delete next[p.id];
      await persist({ ...config, db_disabled: next });
    },
    [config, persist],
  );

  const toggleRepoAction = useCallback(
    async (p: Project, key: string, hidden: boolean) => {
      if (!config) return;
      const map = { ...(config.repo_actions_hidden ?? {}) };
      const cur = new Set(map[p.id] ?? []);
      if (hidden) cur.add(key);
      else cur.delete(key);
      if (cur.size) map[p.id] = [...cur];
      else delete map[p.id];
      await persist({ ...config, repo_actions_hidden: map });
    },
    [config, persist],
  );

  // ----- Arguments d'un script (clic droit sur un script du menu Actions) -----
  const [scriptArgsModal, setScriptArgsModal] = useState<{
    project: Project;
    action: ActionDef;
  } | null>(null);
  const onRunScriptArgs = useCallback(
    (p: Project, a: ActionDef) => setScriptArgsModal({ project: p, action: a }),
    [],
  );
  const runScriptWithArgs = useCallback(
    (args: string) => {
      const m = scriptArgsModal;
      setScriptArgsModal(null);
      if (!m) return;
      // Arguments passés au script après `--` (convention npm).
      const command = args ? `${m.action.command} -- ${args}` : m.action.command;
      void runActionOn(m.project, { ...m.action, command }, undefined);
    },
    [scriptArgsModal, runActionOn],
  );

  // ----- Onglets console (ordre personnalisable) -----
  const consoleTabs = useMemo(() => {
    const ids = new Set<string>([
      ...running,
      ...openTabs,
      ...Object.keys(logs).filter((k) => logs[k]?.length),
    ]);
    for (const c of closedTabs) ids.delete(c); // onglets masqués
    const projOrder = allProjects.map((p) => p.id);
    const arr = [...ids];
    arr.sort((a, b) => {
      const ia = tabOrder.indexOf(a);
      const ib = tabOrder.indexOf(b);
      if (ia !== -1 || ib !== -1) {
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      }
      return projOrder.indexOf(a) - projOrder.indexOf(b);
    });
    return arr.map((id) => ({
      id,
      name: allProjects.find((p) => p.id === id)?.name ?? id.split(":").pop() ?? id,
      running: running.has(id),
    }));
  }, [running, openTabs, closedTabs, logs, allProjects, tabOrder]);

  useEffect(() => {
    if (activeConsole && consoleTabs.find((t) => t.id === activeConsole)) return;
    setActiveConsole(consoleTabs[0]?.id ?? null);
  }, [consoleTabs, activeConsole]);

  // Organisation du tableau de bord : liste à plat ordonnée + dossiers virtuels.
  // `projects` = projets top-level (les enfants fullstack restent imbriqués sous
  // leur parent, jamais dans le layout ni un dossier).
  const cfgFolders = config?.folders ?? [];
  const cfgLayout = config?.project_layout ?? [];
  const layoutNodes = useMemo(
    () => resolveLayout(projects, cfgFolders, cfgLayout),
    [projects, cfgFolders, cfgLayout],
  );

  // Persiste un nouvel état d'organisation (dossiers + ordre racine).
  const persistLayout = useCallback(
    (next: LayoutState) => {
      if (!config) return;
      void persist({ ...config, folders: next.folders, project_layout: next.layout });
    },
    [config, persist],
  );
  // « Fige » l'ordre racine visible actuel dans le layout avant une mutation :
  // sans ça, la 1re action après migration (layout vide) placerait mal l'élément,
  // les autres projets n'étant pas encore explicitement ordonnés.
  const materialized = useCallback((): LayoutState => {
    const rootKeys = layoutNodes.map((n) =>
      n.type === "folder" ? folderKey(n.folder.id) : n.project.id,
    );
    return { folders: cfgFolders, layout: rootKeys };
  }, [layoutNodes, cfgFolders]);

  // Vue courante : struct transitoire pendant un glissement, sinon dérivée de la config.
  const viewStruct = useMemo(() => dragStruct ?? structFrom(layoutNodes), [dragStruct, layoutNodes]);
  const projById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const sensors = useSensors(
    // Seuil de 5 px : un simple clic sur un bouton de la ligne ne démarre pas un drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Conteneur (parent) d'une clé dans une struct donnée. Une clé de dossier
  // ("folder:<id>") vit dans son parent (racine ou autre dossier) → on la cherche ;
  // un id de conteneur (folder.id, sans préfixe) se désigne lui-même.
  const containerOf = useCallback((s: Struct, id: string): string | null => {
    if (id === ROOT) return ROOT;
    if (s.folders[id] !== undefined) return id; // id = conteneur dossier
    if (s.root.includes(id)) return ROOT;
    for (const fid in s.folders) if (s.folders[fid].includes(id)) return fid;
    return null;
  }, []);
  const itemsOf = (s: Struct, c: string): string[] => (c === ROOT ? s.root : s.folders[c] ?? []);
  const withItems = (s: Struct, c: string, items: string[]): Struct =>
    c === ROOT ? { ...s, root: items } : { ...s, folders: { ...s.folders, [c]: items } };

  // Détection de collision : parmi les zones sous le curseur on garde la plus
  // *spécifique* (plus petite aire) — l'entête d'un dossier (son item triable)
  // permet de le placer avant/entre d'autres, tandis que son *corps* (imbriqué,
  // plus petit) sert à ranger dedans. Quand on glisse un DOSSIER, on exclut son
  // propre sous-arbre pour éviter les cycles (dossier dans lui-même/descendant).
  // Dossiers REPLIÉS (pas de corps → l'entête sert de zone de dépôt) : selon ce
  // qu'on glisse, on retire l'un des deux « ids » du dossier fermé pour lever
  // l'ambiguïté sur son entête :
  // - un PROJET → on retire la clé de tri (survol = « ranger dedans », conteneur) ;
  // - un DOSSIER → on retire le conteneur (survol = réordonner ; pour imbriquer
  //   dans un dossier fermé, le déplier d'abord).
  const collapsedSortKeys = useMemo(
    () => new Set(cfgFolders.filter((f) => f.collapsed).map((f) => folderKey(f.id))),
    [cfgFolders],
  );
  const collapsedContainerIds = useMemo(
    () => new Set(cfgFolders.filter((f) => f.collapsed).map((f) => f.id)),
    [cfgFolders],
  );
  const collision: CollisionDetection = useCallback(
    (args) => {
      const activeId = String(args.active.id);
      const draggingFolder = isFolderKey(activeId);
      const exclude = draggingFolder ? collapsedContainerIds : collapsedSortKeys;
      let containers = args.droppableContainers.filter((c) => !exclude.has(String(c.id)));
      if (draggingFolder) {
        const blocked = new Set<string>();
        subtreeKeys(viewStruct, folderIdOf(activeId), blocked);
        containers = containers.filter((c) => !blocked.has(String(c.id)));
      }
      const within = pointerWithin({ ...args, droppableContainers: containers });
      if (within.length > 1) {
        const area = (id: string | number) => {
          const r = args.droppableRects.get(id);
          return r ? r.width * r.height : Number.POSITIVE_INFINITY;
        };
        within.sort((a, b) => area(a.id) - area(b.id));
      }
      return within.length ? within : closestCorners({ ...args, droppableContainers: containers });
    },
    [viewStruct, collapsedSortKeys, collapsedContainerIds],
  );

  const setStruct = (s: Struct) => {
    dragStructRef.current = s;
    setDragStruct(s);
  };
  const onDragStart = useCallback(
    (e: DragStartEvent) => {
      const s = structFrom(layoutNodes);
      setActiveDrag(String(e.active.id));
      setStruct(s);
    },
    [layoutNodes],
  );
  const onDragOver = useCallback(
    (e: DragOverEvent) => {
      const s = dragStructRef.current;
      if (!s || !e.over) return;
      const activeId = String(e.active.id);
      const overId = String(e.over.id);
      const from = containerOf(s, activeId);
      const to = containerOf(s, overId);
      if (!from || !to || from === to) return;
      // Anti-cycle : ne pas faire entrer un dossier dans son propre sous-arbre.
      if (isFolderKey(activeId)) {
        const blocked = new Set<string>();
        subtreeKeys(s, folderIdOf(activeId), blocked);
        if (blocked.has(to)) return;
      }
      const fromItems = itemsOf(s, from).filter((x) => x !== activeId);
      const toItems = [...itemsOf(s, to)];
      const oi = overId === to ? toItems.length : toItems.indexOf(overId);
      toItems.splice(oi < 0 ? toItems.length : oi, 0, activeId);
      setStruct(withItems(withItems(s, from, fromItems), to, toItems));
    },
    [containerOf],
  );
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const s = dragStructRef.current;
      setActiveDrag(null);
      setDragStruct(null);
      dragStructRef.current = null;
      if (!s || !e.over) return;
      const activeId = String(e.active.id);
      const overId = String(e.over.id);
      const to = containerOf(s, overId);
      const from = containerOf(s, activeId);
      let next = s;
      if (from && to && from === to) {
        const items = itemsOf(s, to);
        const oldI = items.indexOf(activeId);
        const newI = overId === to ? items.length - 1 : items.indexOf(overId);
        if (oldI >= 0 && newI >= 0 && oldI !== newI) next = withItems(s, to, arrayMove(items, oldI, newI));
      }
      persistLayout(stateFromStruct(next, cfgFolders));
    },
    [containerOf, persistLayout, cfgFolders],
  );
  const onDragCancel = useCallback(() => {
    setActiveDrag(null);
    setDragStruct(null);
    dragStructRef.current = null;
  }, []);

  const onNewFolder = useCallback(
    () => persistLayout(createFolderLayout(materialized(), "Nouveau dossier")),
    [materialized, persistLayout],
  );
  const onDeleteFolder = useCallback(
    (id: string) => persistLayout(deleteFolderLayout(materialized(), id)),
    [materialized, persistLayout],
  );
  const onToggleFolder = useCallback(
    (id: string) => persistLayout(toggleFolderCollapsed({ folders: cfgFolders, layout: cfgLayout }, id)),
    [cfgFolders, cfgLayout, persistLayout],
  );
  const onFolderColor = useCallback(
    (id: string, color?: string) =>
      persistLayout(setFolderColorLayout({ folders: cfgFolders, layout: cfgLayout }, id, color)),
    [cfgFolders, cfgLayout, persistLayout],
  );
  const commitFolderName = useCallback(() => {
    if (!editingFolder) return;
    persistLayout(
      renameFolderLayout({ folders: cfgFolders, layout: cfgLayout }, editingFolder, folderNameDraft),
    );
    setEditingFolder(null);
  }, [editingFolder, folderNameDraft, cfgFolders, cfgLayout, persistLayout]);
  const closeFolderMenu = useCallback(() => setFolderMenu(null), []);
  // Ferme le menu contextuel du dossier sur Échap.
  useEffect(() => {
    if (!folderMenu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeFolderMenu();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [folderMenu, closeFolderMenu]);

  // Projet affiché en détail (suivi par chemin, stable au changement de type).
  // On exclut le parent fullstack (purement structurel) : il partage son chemin
  // avec son sous-projet commun, et n'ouvre jamais de page de détail lui-même.
  const detailProject = detailPath
    ? allProjects.find((p) => p.path === detailPath && p.kind !== "fullstack") ?? null
    : null;
  // Referme la page si son projet a disparu (source retirée), hors période de scan.
  useEffect(() => {
    if (detailPath && !scanning && !allProjects.some((p) => p.path === detailPath)) {
      setDetailPath(null);
    }
  }, [detailPath, scanning, allProjects]);

  // Projet dont on affiche les modifications git (même suivi par chemin).
  const gitChangesProject = gitChangesPath
    ? allProjects.find((p) => p.path === gitChangesPath && p.kind !== "fullstack") ?? null
    : null;
  useEffect(() => {
    if (gitChangesPath && !scanning && !allProjects.some((p) => p.path === gitChangesPath)) {
      setGitChangesPath(null);
    }
  }, [gitChangesPath, scanning, allProjects]);

  const serviceSequences = useMemo(() => sequences.filter((s) => !s.global), [sequences]);
  const globalSequences = useMemo(() => sequences.filter((s) => !!s.global), [sequences]);

  // Télécharge un installeur de mise à jour sans ouvrir le navigateur.
  const downloadUpdate = useCallback(async (asset: UpdateAsset) => {
    setDl({ busy: asset.name });
    try {
      const path = await api.downloadFile(asset.url, asset.name);
      setDl({ done: path });
    } catch (e) {
      setDl({ error: String(e) });
    }
  }, []);

  const runningCount = running.size;
  const canStartAny = allProjects.some(
    (p) => p.start_command && !running.has(p.id) && !busy[p.id],
  );
  const canStopAny = runningCount > 0;
  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "pending").length;

  // Rend une ligne de projet. `nested` = sous-projet d'un fullstack (indenté,
  // sans chip branche ni bouton dépôt : git géré au niveau du parent).
  const renderRow = (p: Project, nested = false) => (
    <ProjectRow
      key={p.id}
      project={p}
      git={gitMap[p.id]}
      running={running.has(p.id)}
      busy={busy[p.id]}
      portInfo={portInfo[p.id]}
      linkStatus={pkgLinks[p.id]}
      testResult={testResults[p.id]}
      actions={allActions}
      sequences={serviceSequences}
      onStart={onStartRow}
      onStop={onStopRow}
      onAction={runActionOn}
      onSequence={runSequenceOn}
      onOpenConsole={onOpenConsoleRow}
      onCheckout={checkout}
      onRefreshGit={refreshGitFor}
      onLinkPackage={openPackageLinks}
      onFreePort={onFreePort}
      onRunTests={onRunTestsRow}
      onEditEnv={openEnv}
      onDbConnect={openDb}
      onDbRetest={retestDb}
      onDbOpenTables={openDbWorkspace}
      dbConn={config?.db_connections?.[p.id]}
      dbTesting={dbTesting.has(p.id)}
      dbDisabled={!!config?.db_disabled?.[p.id]}
      onEditStartCommand={openProjectCommand}
      repoLink={repoLinkFor(p)}
      onOpenUrl={openUrl}
      onEditRepo={editRepo}
      onOpenDetail={openDetail}
      onOpenGitChanges={openGitChanges}
      hiddenRepoActions={config?.repo_actions_hidden?.[p.id]}
      onRunScriptArgs={onRunScriptArgs}
      dense={rowLayout.dense}
      hidePort={rowLayout.hidePort}
      foldSecondary={rowLayout.fold}
      nested={nested}
      expanded={expandedRows.has(p.id)}
      onToggleExpand={toggleExpanded}
    />
  );

  // Rend une ligne de projet triable (dnd-kit) : poignée « grip » + la ligne
  // (un projet fullstack embarque ses enfants). Le conteneur (racine/dossier) est
  // porté par le SortableContext parent.
  const renderProjectItem = (p: Project) => {
    const isFs = p.kind === "fullstack";
    return (
      <Sortable id={p.id} key={p.id}>
        {({ setNodeRef, style, isDragging, handle }) => (
          <div
            ref={setNodeRef}
            style={style}
            className={
              "dnd-item" +
              (isFs ? " project-block" + (expandedRows.has(p.id) ? " expanded" : "") : "") +
              (isDragging ? " dragging" : "")
            }
          >
            <span className="row-grip" title="Glisser pour déplacer" {...handle}>
              ⠿
            </span>
            <div className="dnd-item-body">
              {renderRow(p)}
              {isFs && expandedRows.has(p.id) && (p.children ?? []).map((c) => renderRow(c, true))}
            </div>
          </div>
        )}
      </Sortable>
    );
  };

  // Rend un dossier virtuel : entête (poignée, repli, nom, options) + ses enfants
  // (projets ET sous-dossiers, SortableContext imbriqué). Le dossier est lui-même
  // triable dans son parent et une zone de dépôt (`useDroppable`).
  const renderFolder = (folder: ProjectFolder, childKeys: string[]) => {
    const fkey = folderKey(folder.id);
    const collapsed = !!folder.collapsed;
    const editing = editingFolder === folder.id;
    // Entête. `intoOver` = un projet/dossier est survolé pour être rangé dedans
    // (cas replié : l'entête EST la zone de dépôt, d'où la surbrillance).
    const head = (handle: Record<string, unknown>, intoOver: boolean) => (
      <div
        className={"folder-head" + (intoOver ? " into" : "")}
        style={folder.color ? ({ "--folder-color": folder.color } as React.CSSProperties) : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFolderMenu({ id: folder.id, x: e.clientX, y: e.clientY });
        }}
      >
        <span className="row-grip folder-grip" title="Glisser le dossier" {...handle}>
          ⠿
        </span>
        <button
          className={"fs-chevron" + (collapsed ? "" : " open")}
          title={collapsed ? "Déplier le dossier" : "Replier le dossier"}
          onClick={() => onToggleFolder(folder.id)}
        >
          ▸
        </button>
        <span className="folder-ico" aria-hidden="true">
          📁
        </span>
        {editing ? (
          <input
            className="folder-name-input"
            autoFocus
            value={folderNameDraft}
            onChange={(e) => setFolderNameDraft(e.target.value)}
            onBlur={commitFolderName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitFolderName();
              else if (e.key === "Escape") setEditingFolder(null);
            }}
          />
        ) : (
          <button
            className="folder-name"
            title="Double-clic pour renommer · clic droit pour les options"
            onDoubleClick={() => {
              setFolderNameDraft(folder.name);
              setEditingFolder(folder.id);
            }}
          >
            {folder.name}
          </button>
        )}
        <span className="folder-count">{childKeys.length}</span>
      </div>
    );
    return (
      <Sortable id={fkey} key={folder.id}>
        {({ setNodeRef, style, isDragging, handle }) => (
          <div ref={setNodeRef} style={style} className={"folder" + (isDragging ? " dragging" : "")}>
            {collapsed ? (
              // Replié : l'entête devient la zone de dépôt « ranger dedans ».
              <Droppable id={folder.id}>
                {({ setNodeRef: setDropRef, isOver }) => (
                  <div ref={setDropRef}>{head(handle, isOver)}</div>
                )}
              </Droppable>
            ) : (
              <>
                {head(handle, false)}
                <Droppable id={folder.id}>
                  {({ setNodeRef: setDropRef, isOver }) => (
                    <div ref={setDropRef} className={"folder-body" + (isOver ? " into" : "")}>
                      <SortableContext items={childKeys} strategy={verticalListSortingStrategy}>
                        {childKeys.map((k) => renderChild(k))}
                      </SortableContext>
                      {childKeys.length === 0 && (
                        <div className="folder-empty">Glissez un projet ou un dossier ici</div>
                      )}
                    </div>
                  )}
                </Droppable>
              </>
            )}
          </div>
        )}
      </Sortable>
    );
  };

  // Rend une clé enfant (projet ou sous-dossier) selon son type — récursif.
  const renderChild = (key: string) => {
    if (isFolderKey(key)) {
      const f = cfgFolders.find((x) => x.id === folderIdOf(key));
      if (!f) return null;
      return renderFolder(f, viewStruct.folders[f.id] ?? []);
    }
    const p = projById.get(key);
    return p ? renderProjectItem(p) : null;
  };

  // Aperçu suivant le curseur pendant un glissement (DragOverlay).
  const renderOverlay = () => {
    if (!activeDrag) return null;
    if (isFolderKey(activeDrag)) {
      const f = cfgFolders.find((x) => x.id === folderIdOf(activeDrag));
      return f ? (
        <div className="folder drag-overlay">
          <div className="folder-head">
            <span className="folder-ico">📁</span>
            <span className="folder-name">{f.name}</span>
          </div>
        </div>
      ) : null;
    }
    const p = projById.get(activeDrag);
    return p ? (
      <div className="dnd-item drag-overlay">
        <div className="dnd-item-body">{renderRow(p)}</div>
      </div>
    ) : null;
  };

  // ----- Rendu -----
  if (!ready) return <div className="boot"><span className="spinner" /> Chargement…</div>;
  if (!config)
    return (
      <Setup
        initialSources={partialConfig?.sources ?? []}
        initialBash={partialConfig?.git_bash_path || DEFAULT_GIT_BASH}
        initialCommand={partialConfig?.start_command ?? ""}
        onSubmit={onSetupSubmit}
      />
    );

  return (
    <div className="app">
      {update && !updateDismissed && (
        <div className="update-banner">
          <span>
            🎉 Une nouvelle version est disponible : <b>v{update.version}</b>
            <span className="update-cur"> (installée : v{update.current})</span>
          </span>
          <span className="update-actions">
            {dl.done ? (
              <>
                <span className="update-done" title={dl.done}>
                  ✓ Téléchargé dans Téléchargements
                </span>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => api.revealPath(dl.done!)}
                  title={dl.done}
                >
                  Ouvrir le dossier
                </button>
              </>
            ) : (
              <>
                {dl.error && <span className="update-err">{dl.error}</span>}
                {update.msi || update.exe ? (
                  ([update.msi, update.exe].filter(Boolean) as UpdateAsset[]).map((a) => (
                    <button
                      key={a.name}
                      className="btn btn-primary btn-sm"
                      disabled={!!dl.busy}
                      onClick={() => downloadUpdate(a)}
                      title={`${a.name}${a.size ? ` — ${(a.size / 1048576).toFixed(1)} Mo` : ""}`}
                    >
                      {dl.busy === a.name ? (
                        <span className="spinner spinner-xs" />
                      ) : (
                        `⬇ ${a.name.toLowerCase().endsWith(".msi") ? ".msi" : ".exe"}`
                      )}
                    </button>
                  ))
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => api.openUrl(update.url)}
                    title="Aucun installeur trouvé : ouvrir la page de la release"
                  >
                    Télécharger
                  </button>
                )}
              </>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setUpdateDismissed(true)}
              title="Masquer jusqu'au prochain démarrage"
            >
              Plus tard
            </button>
          </span>
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="brand-logo">⚡</span>
          <span className="brand-name">DevLauncher</span>
          <span className="brand-version" title={`Version ${__APP_VERSION__}`}>
            v{__APP_VERSION__}
          </span>
        </div>
        <div className="topbar-stats">
          {scanning && (
            <span className="stat scanning">
              <span className="spinner" /> analyse…
            </span>
          )}
        </div>
        <div className="topbar-actions">
          <button
            className="btn btn-start"
            onClick={startAll}
            onContextMenu={(e) => {
              e.preventDefault();
              openStartCommand();
            }}
            disabled={view === "settings" || !canStartAny}
            title={`Commande par défaut : ${startCmd || "non définie"} — clic droit pour la modifier`}
          >
            ▶ Tout démarrer
          </button>
          <button
            className="btn btn-stop"
            onClick={stopAll}
            disabled={view === "settings" || !canStopAny}
          >
            ■ Tout arrêter
          </button>
          <button
            className="btn btn-ghost"
            onClick={restartAll}
            disabled={view === "settings" || !canStopAny}
            title="Redémarrer tous les services actuellement allumés"
          >
            ⟳ Tout redémarrer
          </button>
          <button
            className="btn btn-warn"
            onClick={freeAllPorts}
            disabled={view === "settings" || orphanPorts.length === 0}
            title="Tuer les process externes qui occupent les ports de tes services"
          >
            ⚠ Libérer tout{orphanPorts.length > 0 ? ` (${orphanPorts.length})` : ""}
          </button>
          <div className="dropdown">
            <button
              className="btn btn-ghost"
              disabled={view === "settings"}
              onClick={() => setSeqMenuOpen((o) => !o)}
              title="Lancer une séquence sur plusieurs services"
            >
              ⛓ Séquences ▾
            </button>
            {seqMenuOpen && (
              <>
                <div className="dropdown-backdrop" onClick={() => setSeqMenuOpen(false)} />
                <div className="dropdown-menu">
                  <div className="menu-label">Séquences générales</div>
                  {globalSequences.length === 0 && (
                    <div className="menu-empty">
                      Aucune. Créez-en une dans ⚙ Réglages (case « Générale »).
                    </div>
                  )}
                  {globalSequences.map((s) =>
                    isSequenceValid(s, allActions, sequences) ? (
                      <button
                        key={s.id}
                        className="menu-item menu-seq"
                        style={s.color ? ({ "--item-color": s.color } as React.CSSProperties) : undefined}
                        onClick={() => {
                          setSeqMenuOpen(false);
                          setGeneralSeq(s);
                        }}
                      >
                        ⛓ {s.name}
                      </button>
                    ) : (
                      <button
                        key={s.id}
                        className="menu-item menu-seq menu-item-invalid"
                        disabled
                        title="Séquence invalide : une action ou séquence a été supprimée"
                      >
                        ⚠ {s.name}
                      </button>
                    ),
                  )}
                </div>
              </>
            )}
          </div>
          <button
            className="btn btn-ghost"
            onClick={rescan}
            disabled={scanning}
            title="Re-scanner les dossiers"
          >
            ↻ Scanner
          </button>
          <button
            className={"btn btn-ghost" + (jobsOpen ? " active" : "")}
            onClick={() => setJobsOpen((o) => !o)}
            title="File des actions / séquences en cours"
          >
            ≡ Tâches{activeJobs > 0 ? ` (${activeJobs})` : ""}
          </button>
          <button
            className={"btn btn-ghost" + (view === "settings" ? " active" : "")}
            onClick={() => setView((v) => (v === "settings" ? "dashboard" : "settings"))}
          >
            ⚙ Réglages
          </button>
        </div>
      </header>

      {view === "settings" ? (
        <SettingsView
          config={config}
          projects={allProjects}
          onPersist={persist}
          onClose={() => setView("dashboard")}
        />
      ) : gitChangesProject ? (
        <GitChangesView
          key={gitChangesProject.id}
          project={gitChangesProject}
          git={gitMap[gitChangesProject.id]}
          bash={bash}
          onBack={() => setGitChangesPath(null)}
          onChanged={() => refreshGitFor(gitChangesProject)}
          onCheckout={checkout}
        />
      ) : detailProject ? (
        <ProjectDetail
          key={detailProject.id}
          project={detailProject}
          config={config}
          git={gitMap[detailProject.id]}
          dbConn={config.db_connections?.[detailProject.id]}
          dbDisabled={!!config.db_disabled?.[detailProject.id]}
          running={running.has(detailProject.id)}
          busy={busy[detailProject.id]}
          onBack={() => setDetailPath(null)}
          onChangeType={changeProjectType}
          onSaveCommand={setProjectCommand}
          onSaveRepo={setProjectRepo}
          onStart={onStartRow}
          onStop={onStopRow}
          onEditEnv={openEnv}
          onOpenUrl={openUrl}
          onDbConfigure={openDb}
          onDbOpenTables={openDbWorkspace}
          onDbRetest={retestDb}
          onToggleDbDisabled={toggleDbDisabled}
          hiddenRepoActions={config.repo_actions_hidden?.[detailProject.id]}
          onToggleRepoAction={toggleRepoAction}
        />
      ) : (
        <div className="main" ref={mainRef}>
          <section className="projects" ref={projectsRef} style={{ width: `${splitPct}%` }}>
            {scanError && <div className="banner-error">{scanError}</div>}

            {scanning && projects.length === 0 && (
              <div className="loading-block">
                <span className="spinner spinner-lg" />
                Analyse des projets…
              </div>
            )}

            {/* Ligne cliquable au-dessus des projets : créer un dossier virtuel. */}
            {projects.length > 0 && (
              <button className="add-folder-line" onClick={onNewFolder}>
                <span className="add-folder-plus">+</span> Nouveau dossier
              </button>
            )}
            {projects.length > 0 && (
              <DndContext
                sensors={sensors}
                collisionDetection={collision}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragEnd={onDragEnd}
                onDragCancel={onDragCancel}
              >
                <Droppable id={ROOT}>
                  {({ setNodeRef }) => (
                    <div ref={setNodeRef} className="root-list">
                      <SortableContext items={viewStruct.root} strategy={verticalListSortingStrategy}>
                        {viewStruct.root.map((key) => renderChild(key))}
                      </SortableContext>
                    </div>
                  )}
                </Droppable>
                <DragOverlay>{renderOverlay()}</DragOverlay>
              </DndContext>
            )}
            {folderMenu &&
              (() => {
                const f = cfgFolders.find((x) => x.id === folderMenu.id);
                if (!f) return null;
                const W = 210;
                const left = Math.max(8, Math.min(folderMenu.x, window.innerWidth - W - 8));
                const top = Math.max(8, Math.min(folderMenu.y, window.innerHeight - 180));
                return (
                  <>
                    <div
                      className="dropdown-backdrop"
                      onClick={closeFolderMenu}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        closeFolderMenu();
                      }}
                    />
                    <div
                      className="context-menu folder-menu"
                      style={{ position: "fixed", left, top, width: W }}
                    >
                      <div className="menu-title">{f.name}</div>
                      <button
                        className="menu-item"
                        onClick={() => {
                          closeFolderMenu();
                          setFolderNameDraft(f.name);
                          setEditingFolder(f.id);
                        }}
                      >
                        ✎ Renommer
                      </button>
                      <div className="menu-item folder-menu-color">
                        <span>🎨 Couleur</span>
                        <ColorPicker
                          value={f.color}
                          onChange={(c) => onFolderColor(f.id, c || undefined)}
                        />
                      </div>
                      <div className="menu-sep" />
                      <button
                        className="menu-item menu-danger"
                        onClick={() => {
                          closeFolderMenu();
                          onDeleteFolder(f.id);
                        }}
                      >
                        🗑 Supprimer
                      </button>
                    </div>
                  </>
                );
              })()}
            {projects.length === 0 && !scanning && !scanError && (
              <div className="empty">
                {sources.length === 0
                  ? "Aucun projet configuré. Ajoutez-en dans ⚙ Réglages → Projets."
                  : "Aucun projet trouvé dans les sources configurées. Vérifiez ⚙ Réglages → Projets."}
              </div>
            )}
          </section>

          <div className="splitter" onMouseDown={startSplit} title="Glisser pour redimensionner" />

          <section className="console-pane">
            <Console
              tabs={consoleTabs}
              active={activeConsole}
              setActive={setActiveConsole}
              lines={activeConsole ? logs[activeConsole] ?? [] : []}
              onReorder={setTabOrder}
              onRunCommand={runCommandIn}
              onClear={() => {
                if (!activeConsole) return;
                api.clearLogs(activeConsole);
                setLogs((prev) => ({ ...prev, [activeConsole]: [] }));
              }}
              onClose={closeConsole}
            />
          </section>
        </div>
      )}

      {branchModal && (
        <BranchModal
          state={branchModal}
          onConfirm={(branch, isNew) => closeBranch({ branch, isNew })}
          onCancel={() => closeBranch(null)}
        />
      )}

      {linkModal && (
        <PackageLinkModal
          state={linkModal}
          busyId={linkBusy}
          onApply={applyLink}
          onClose={() => setLinkModal(null)}
        />
      )}

      {envModal && (
        <EnvModal
          state={envModal}
          onSave={saveEnv}
          onCancel={() => setEnvModal(null)}
        />
      )}

      {dbModal && (
        <DbConnectionModal
          state={dbModal}
          onConnect={dbConnect}
          onCancel={() => setDbModal(null)}
        />
      )}

      {/* Chaque base ouverte a son propre espace, tous montés en permanence :
          basculer de l'une à l'autre ne perd aucune saisie. Seule la base active
          et non réduite est visible. */}
      {Object.values(dbWsMap).map((ws) => {
        const pid = ws.projectId;
        const wsTabs = dbTabs.filter((t) => t.data.projectId === pid);
        const graphThis = dbGraphMap[pid] ?? EMPTY_DB_GRAPH;
        const graphOpenThis = dbGraphOpenMap[pid] ?? false;
        const activeTabThis = dbActiveTabMap[pid] ?? null;
        const visible = pid === activeDbId && !dbWsHidden;
        return (
          <DbWorkspaceView
            key={pid}
            state={ws}
            hidden={!visible}
            tabs={wsTabs.map((t) => ({
              id: t.id,
              label: t.data.table,
              dirty: dbDirty[t.id] ?? 0,
            }))}
            activeId={graphOpenThis ? null : activeTabThis}
            graphOpen={graphOpenThis}
            onOpenGraph={() => {
              setDbGraphOpen(true, pid);
              ensureDbGraph();
            }}
            onOpenTable={openTableTab}
            onSelectTab={(id) => {
              setDbGraphOpen(false, pid);
              setDbActiveTab(id, pid);
            }}
            onCloseTab={closeDbTab}
            onRefreshTables={refreshWsTables}
            onMinimize={() => setDbWsHidden(true)}
            onClose={() => closeDbWorkspace(pid)}
          >
            {/* Tous les onglets restent montés (état local préservé) ; seul
                l'onglet actif est visible. */}
            {wsTabs.map((t) => (
              <div
                key={t.id}
                className="dbws-tabpanel"
                style={{ display: t.id === activeTabThis && !graphOpenThis ? "flex" : "none" }}
              >
                <div className="dbsub-tabs">
                  <button
                    className={"dbsub-tab" + (t.view === "data" ? " on" : "")}
                    onClick={() => setTabView(t.id, "data")}
                    title="Lignes de la table"
                  >
                    ▤ Données
                  </button>
                  <button
                    className={"dbsub-tab" + (t.view === "schema" ? " on" : "")}
                    onClick={() => setTabView(t.id, "schema")}
                    title="Colonnes, types, contraintes et index"
                  >
                    🧬 Structure
                  </button>
                  <button
                    className={"dbsub-tab" + (t.view === "relations" ? " on" : "")}
                    onClick={() => setTabView(t.id, "relations")}
                    title="Schéma des tables liées par clé étrangère"
                  >
                    🔗 Relations
                  </button>
                </div>
                {/* Les deux vues restent montées : les modifications en attente du
                    tableau survivent au passage par la structure. */}
                <div
                  className="dbsub-panel"
                  style={{ display: t.view === "data" ? "flex" : "none" }}
                >
                  <DbTableDataView
                    state={t.data}
                    active={visible && !graphOpenThis && t.id === activeTabThis && t.view === "data"}
                    onLimitChange={(n) => changeTabLimit(t.id, n)}
                    onFilterChange={(f) => changeTabFilter(t.id, f)}
                    onRefresh={() => refreshTab(t.id)}
                    onApply={(ins, upd, del) => applyTabChanges(t.id, ins, upd, del)}
                    onLoadMore={() => loadMoreTab(t.id)}
                    onNavigateFk={(table, filter, scrollTop) =>
                      navigateTabFk(t.id, table, filter, scrollTop)
                    }
                    onBack={() => goBackTab(t.id)}
                    canBack={t.navStack.length > 0}
                    onDirtyChange={(n) =>
                      setDbDirty((d) => (d[t.id] === n ? d : { ...d, [t.id]: n }))
                    }
                  />
                </div>
                <div
                  className="dbsub-panel"
                  style={{ display: t.view === "schema" ? "flex" : "none" }}
                >
                  <DbTableSchemaView
                    table={t.data.table}
                    state={t.schema}
                    active={visible && !graphOpenThis && t.id === activeTabThis && t.view === "schema"}
                    driver={ws.driver}
                    tables={ws.tables}
                    onLoadColumns={loadTableColumns}
                    onRefresh={() => loadTabSchema(t.id)}
                    onOpenTable={openTableTab}
                    onApply={(changes) => applyTabSchema(t.id, changes)}
                  />
                </div>
                <div
                  className="dbsub-panel"
                  style={{ display: t.view === "relations" ? "flex" : "none" }}
                >
                  <DbRelationsView
                    state={graphThis}
                    focus={t.data.table}
                    onRefresh={loadDbGraph}
                    onOpenTable={openTableTab}
                  />
                </div>
              </div>
            ))}
            {/* Schéma général : monté avec les onglets, visible seul quand actif. */}
            <div
              className="dbws-tabpanel"
              style={{ display: graphOpenThis ? "flex" : "none" }}
            >
              <DbRelationsView
                state={graphThis}
                active={graphOpenThis && visible}
                savedLayout={config?.db_layouts?.[pid] ?? null}
                onSaveLayout={(layout) => saveGraphLayout(pid, layout)}
                onRefresh={loadDbGraph}
                onOpenTable={openTableTab}
              />
            </div>
          </DbWorkspaceView>
        );
      })}

      {/* Barre des bases ouvertes (bas-droite) : bascule + fermeture. */}
      {Object.keys(dbWsMap).length > 0 &&
        (dbWsHidden || Object.keys(dbWsMap).length > 1) && (
          <div className="dbws-taskbar">
            {Object.values(dbWsMap).map((ws) => {
              const pid = ws.projectId;
              const total = dbTabs
                .filter((t) => t.data.projectId === pid)
                .reduce((a, t) => a + (dbDirty[t.id] ?? 0), 0);
              const current = pid === activeDbId && !dbWsHidden;
              return (
                <div key={pid} className={"dbws-pill" + (current ? " on" : "")}>
                  <button
                    className="dbws-pill-main"
                    onClick={() => focusDbWorkspace(pid)}
                    title="Afficher cette base (vos saisies sont conservées)"
                  >
                    <span className="dbws-restore-ico">🗄</span>
                    <span className="dbws-restore-label">
                      {ws.database || ws.projectName}
                    </span>
                    {total > 0 && (
                      <span
                        className="dbws-restore-badge"
                        title={`${total} modification(s) non enregistrée(s)`}
                      >
                        {total}
                      </span>
                    )}
                  </button>
                  <button
                    className="dbws-pill-close"
                    onClick={() => closeDbWorkspace(pid)}
                    title="Fermer cette base"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

      {cmdModal && (
        <StartCommandModal
          project={cmdModal.project}
          defaultCommand={startCmd}
          override={cmdModal.project ? cmdOverrides[cmdModal.project.id] ?? null : null}
          onSave={saveStartCommand}
          onCancel={() => setCmdModal(null)}
        />
      )}

      {scriptArgsModal && (
        <ScriptArgsModal
          projectName={scriptArgsModal.project.name}
          action={scriptArgsModal.action}
          onRun={runScriptWithArgs}
          onCancel={() => setScriptArgsModal(null)}
        />
      )}

      {repoModal && (
        <RepoLinkModal
          project={repoModal.project}
          autoUrl={gitMap[repoModal.project.id]?.repo_url ?? ""}
          override={projectLinks[repoModal.project.id] ?? null}
          onSave={saveRepoLink}
          onCancel={() => setRepoModal(null)}
        />
      )}

      {generalSeq && (
        <GeneralSequenceModal
          sequence={generalSeq}
          projects={projects}
          actions={allActions}
          sequences={sequences}
          onRun={(ids, branch) => {
            const seq = generalSeq;
            setGeneralSeq(null);
            runGeneralSequence(seq, ids, branch);
          }}
          onClose={() => setGeneralSeq(null)}
        />
      )}

      {jobsOpen && (
        <TaskQueue
          jobs={jobs}
          onCancelJob={cancelJob}
          onCancelStep={cancelStep}
          onClear={clearJobs}
          onClose={() => setJobsOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vue Réglages
// ---------------------------------------------------------------------------

type SettingsTab = "general" | "projects" | "startup" | "actions" | "sequences" | "database";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "Général" },
  { id: "projects", label: "Projets" },
  { id: "startup", label: "Démarrage" },
  { id: "actions", label: "Actions" },
  { id: "sequences", label: "Séquences" },
  { id: "database", label: "Base de données" },
];

function SettingsView({
  config,
  projects,
  onPersist,
  onClose,
}: {
  config: Config;
  projects: Project[];
  onPersist: (c: Config) => Promise<void>;
  onClose: () => void;
}) {
  // Brouillon de travail : source de vérité pendant l'édition. La persistance est
  // automatique (immédiate sur ajout/suppression, différée sur la saisie de texte),
  // l'utilisateur n'a donc plus rien à « enregistrer ».
  const [draft, setDraft] = useState<Config>(config);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [seqTab, setSeqTab] = useState<"project" | "general">("project");
  const [autoStart, setAutoStart] = useState(false);
  const [pending, setPending] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const draftRef = useRef(draft);
  const pendingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settingsActions = [...BUILTIN_ACTIONS, ...draft.custom_actions].map((a) => ({
    ...a,
    color: draft.action_colors[a.id],
  }));
  const missingRequired = !draft.git_bash_path.trim() || !draft.start_command.trim();

  useEffect(() => {
    autostart.isEnabled().then(setAutoStart).catch(() => {});
  }, []);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const d = draftRef.current;
    // On ne persiste jamais une config invalide (un champ requis vidé). Les
    // sources peuvent être vides (l'utilisateur peut tout retirer puis ré-ajouter).
    if (!d.git_bash_path.trim() || !d.start_command.trim()) {
      return;
    }
    pendingRef.current = false;
    setPending(false);
    await onPersist({
      ...d,
      projects_root: d.projects_root.trim(),
      git_bash_path: d.git_bash_path.trim(),
      start_command: d.start_command.trim(),
      // Les exceptions vidées reviennent à la commande par défaut.
      command_overrides: Object.fromEntries(
        Object.entries(d.command_overrides)
          .map(([id, cmd]) => [id, cmd.trim()])
          .filter(([, cmd]) => cmd),
      ),
      sequences: d.sequences,
      custom_actions: d.custom_actions,
      action_colors: d.action_colors,
      actions_seeded: d.actions_seeded,
      db_connections: d.db_connections ?? {},
      db_row_limit: d.db_row_limit ?? 200,
      db_disabled: d.db_disabled ?? {},
    });
    setSavedAt(Date.now());
  }, [onPersist]);

  // Flush du brouillon en attente à la fermeture de la vue (démontage).
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      if (pendingRef.current) flushRef.current();
    },
    [],
  );

  // Applique une modification au brouillon puis planifie sa sauvegarde.
  // `debounce` diffère l'écriture (saisie de texte) pour ne pas persister à chaque frappe.
  function patch(partial: Partial<Config>, debounce = false) {
    const next = { ...draftRef.current, ...partial };
    draftRef.current = next;
    setDraft(next);
    pendingRef.current = true;
    setPending(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (debounce) {
      saveTimer.current = setTimeout(() => void flush(), 500);
    } else {
      void flush();
    }
  }

  // Sauvegarde immédiate sur ajout/suppression (la taille change), différée sur édition.
  const commitActions = (next: ActionDef[]) =>
    patch({ custom_actions: next }, next.length === draftRef.current.custom_actions.length);
  const commitSequences = (next: Sequence[]) =>
    patch({ sequences: next }, next.length === draftRef.current.sequences.length);

  // Couleur d'affichage d'une action : "" = réinitialise (retire l'entrée).
  // Débouncé : le picker « Perso. » émet onChange en continu pendant le drag ;
  // l'aperçu (draft) se met à jour tout de suite, la sauvegarde après 500 ms.
  const setColor = (id: string, color: string) => {
    const next = { ...draftRef.current.action_colors };
    if (color) next[id] = color;
    else delete next[id];
    patch({ action_colors: next }, true);
  };

  const overrides = draft.command_overrides;

  async function toggleAutoStart(v: boolean) {
    try {
      if (v) await autostart.enable();
      else await autostart.disable();
      setAutoStart(v);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="settings">
      <div className="settings-inner">
        <button className="tab-close settings-close" onClick={onClose} title="Fermer">
          ×
        </button>
        <div className="tabs settings-tabs">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              className={"tab" + (tab === t.id ? " on" : "")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "projects" && (
          <>
            <h2>Projets</h2>
            <p className="muted">
              Ajoutez un <b>projet</b> (un dossier = un projet), ou un <b>dossier parent</b> dont
              chaque sous-dossier devient un projet à typer (Service, Front ou Package). Les dossiers
              parents sont réanalysés à chaque scan : un nouveau sous-dossier apparaît automatiquement.
            </p>
            <ProjectSources
              sources={draft.sources}
              onChange={(s) => patch({ sources: s })}
              addButtonsOnTop
            />
          </>
        )}

        {tab === "general" && (
          <>
            <h2>Chemins</h2>
            <label className="field">
              <span>Chemin de Git Bash</span>
              <div className="field-row">
                <input
                  value={draft.git_bash_path}
                  onChange={(e) => patch({ git_bash_path: e.target.value }, true)}
                  onBlur={() => void flush()}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const p = await pickBashExe();
                    if (p) patch({ git_bash_path: p });
                  }}
                >
                  Parcourir…
                </button>
              </div>
              {!draft.git_bash_path.trim() && (
                <small className="field-error">Champ requis pour enregistrer.</small>
              )}
            </label>

            <label className="autostart-row">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => toggleAutoStart(e.target.checked)}
              />
              <span>Lancer DevLauncher au démarrage de Windows</span>
            </label>
          </>
        )}

        {tab === "startup" && (
          <>
            <h2>Démarrage</h2>
            <label className="field">
              <span>Commande de démarrage par défaut</span>
              <small className="muted">
                Exécutée dans le dossier de chaque projet démarrable (via Git Bash), sauf exception
                ci-dessous. Aussi modifiable par clic droit sur « Tout démarrer ».
              </small>
              <div className="field-row">
                <input
                  value={draft.start_command}
                  onChange={(e) => patch({ start_command: e.target.value }, true)}
                  onBlur={() => void flush()}
                  placeholder={START_COMMAND_PLACEHOLDER}
                />
              </div>
              {!draft.start_command.trim() && (
                <small className="field-error">Champ requis pour enregistrer.</small>
              )}
            </label>

            <div className="field">
              <span>Exceptions par projet</span>
              <small className="muted">
                Ces projets démarrent avec leur propre commande au lieu de la commande par défaut.
                Aussi modifiable par clic droit sur le bouton « Démarrer » d'un projet.
              </small>
              {Object.entries(overrides).map(([id, cmd]) => (
                <div className="field-row override-row" key={id}>
                  <span className="override-name" title={id}>
                    {projects.find((p) => p.id === id)?.name ?? id.split(":").pop() ?? id}
                  </span>
                  <input
                    value={cmd}
                    onChange={(e) => patch({ command_overrides: { ...overrides, [id]: e.target.value } }, true)}
                    onBlur={() => void flush()}
                    placeholder={START_COMMAND_PLACEHOLDER}
                  />
                  <button
                    className="btn btn-ghost"
                    title="Supprimer l'exception (revient à la commande par défaut)"
                    onClick={() => {
                      const n = { ...overrides };
                      delete n[id];
                      patch({ command_overrides: n });
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="field-row override-row">
                <select
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id) patch({ command_overrides: { ...overrides, [id]: draft.start_command } });
                  }}
                >
                  <option value="">+ Ajouter une exception…</option>
                  {projects
                    .filter(
                      (p) =>
                        p.kind !== "package" &&
                        p.kind !== "fullstack" &&
                        !(p.id in overrides),
                    )
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </>
        )}

        {tab === "actions" && (
          <>
            <h2>Actions</h2>
            <p className="muted">
              Actions (nom + commande) disponibles dans le menu Actions des projets et dans les
              séquences. Les actions de base (npm, tests, nettoyage) sont modifiables et
              supprimables ici. La pastille attribue une couleur au libellé (menu + séquences).
              Décochez « Projets » pour réserver une action aux séquences (masquée du menu des
              projets).
            </p>
            <CustomActionManager
              actions={draft.custom_actions}
              colors={draft.action_colors}
              onChange={commitActions}
              onColor={setColor}
            />

            <h2>Actions fixes</h2>
            <p className="muted">
              Actions intégrées non modifiables (Démarrer, Git…) — vous pouvez tout de même leur
              attribuer une couleur.
            </p>
            <div className="fixed-actions">
              {CORE_ACTIONS.map((a) => (
                <div className="fixed-action-row" key={a.id}>
                  <ColorPicker
                    value={draft.action_colors[a.id]}
                    onChange={(c) => setColor(a.id, c)}
                  />
                  <span
                    className="fixed-action-label"
                    style={draft.action_colors[a.id] ? { color: draft.action_colors[a.id] } : undefined}
                  >
                    {a.label}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "sequences" && (
          <>
            <h2>Séquences d'actions</h2>
            <div className="tabs">
              <button
                className={"tab" + (seqTab === "project" ? " on" : "")}
                onClick={() => setSeqTab("project")}
              >
                Par projet
              </button>
              <button
                className={"tab" + (seqTab === "general" ? " on" : "")}
                onClick={() => setSeqTab("general")}
              >
                Générales
              </button>
            </div>
            <p className="muted">
              {seqTab === "project"
                ? "Jouées depuis le menu Actions d'un projet. Elles s'arrêtent si une action échoue."
                : "Jouées depuis le menu ⛓ Séquences, sur plusieurs projets à la fois. Une étape peut être une action ou une séquence existante. Choisissez ici les projets cibles."}
            </p>
            <SequenceManager
              sequences={draft.sequences}
              mode={seqTab}
              projects={projects}
              actions={settingsActions}
              onChange={commitSequences}
            />
          </>
        )}

        {tab === "database" && (
          <>
            <h2>Services sans base de données</h2>
            <p className="muted settings-hint">
              Cochez un service pour indiquer qu'il n'a pas de base : son bouton base de
              données est alors masqué dans la liste des projets.
            </p>
            {(() => {
              const services = projects.filter((p) => p.kind === "service");
              if (services.length === 0) {
                return <p className="muted">Aucun service détecté.</p>;
              }
              const disabled = draft.db_disabled ?? {};
              return (
                <div className="db-disabled-list">
                  {services.map((p) => (
                    <label className="autostart-row" key={p.id}>
                      <input
                        type="checkbox"
                        checked={!!disabled[p.id]}
                        onChange={(e) => {
                          const next = { ...(draftRef.current.db_disabled ?? {}) };
                          if (e.target.checked) next[p.id] = true;
                          else delete next[p.id];
                          patch({ db_disabled: next });
                        }}
                      />
                      <span>{p.name}</span>
                      {draft.db_connections?.[p.id] && !disabled[p.id] && (
                        <span className="chip chip-db-ok">connexion configurée</span>
                      )}
                    </label>
                  ))}
                </div>
              );
            })()}
          </>
        )}

        <div className="settings-footer">
          <span className={"settings-status" + (!pending && savedAt ? " saved" : "")}>
            {missingRequired ? (
              "⚠ Complétez les champs requis (onglet Général / Démarrage)"
            ) : pending ? (
              <>
                <span className="spinner" /> Enregistrement…
              </>
            ) : savedAt ? (
              "✓ Modifications enregistrées automatiquement"
            ) : (
              "Enregistrement automatique activé"
            )}
          </span>
          <button className="btn btn-primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
