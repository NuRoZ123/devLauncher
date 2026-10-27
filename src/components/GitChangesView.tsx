import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  JobOutcome,
  ConflictVersions,
  FileVersions,
  GitChange,
  GitInfo,
  MergeState,
  Outgoing,
  Project,
  ProjectChangelists,
} from "../types";
import { DiffView } from "./DiffView";
import { buildRepoLinks, repoActions } from "../repo";
import { GitHistoryView } from "./GitHistoryView";
import {
  DEFAULT_LIST_ID,
  emptyChangelists,
  excludedIds,
  listIdOf,
  listsOf,
  newListId,
} from "../changelists";
import { ConflictsModal, OP_LABEL, UpdateModal, type PullTarget } from "./ConflictsModal";
import { MergeView } from "./MergeView";
import { awaitFetch, fetchRepo } from "../gitFetch";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
  type DragEndEvent,
} from "@dnd-kit/core";

/** Fichier déplaçable (render-prop) : la poignée porte les listeners dnd-kit. */
function DraggableFile({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: (p: {
    setNodeRef: (el: HTMLElement | null) => void;
    handle: Record<string, unknown>;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id, disabled });
  return <>{children({ setNodeRef, handle: { ...listeners, ...attributes }, isDragging })}</>;
}

/** Section « Dans l'index » / « Modifications » comme zone de dépôt. */
function DropZone({
  id,
  children,
}: {
  id: string;
  children: (p: { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean }) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <>{children({ setNodeRef, isOver })}</>;
}

interface Props {
  project: Project;
  git?: GitInfo;
  /** Exécutable git (appelé directement, sans bash). */
  gitExe: string;
  onBack: () => void;
  /** Rafraîchit l'état git du projet dans le parent (après commit/push). */
  onChanged: () => void;
  /** Ouvre le sélecteur de branche (même modale que partout ailleurs). */
  /** Change de branche (action en console) et renvoie son issue, null si abandon. */
  onCheckout: (p: Project) => Promise<{ branch: string; isNew: boolean; status: JobOutcome } | null>;
  /** Changelists du projet (façon JetBrains) et leur enregistrement. */
  changelists?: ProjectChangelists;
  onChangelists: (next: ProjectChangelists) => void;
  /** Dépôt en ligne (ex-menu du bouton VCS de la carte) : URL, liens masqués. */
  repoLink: string;
  hiddenRepoActions?: string[];
  onOpenUrl: (url: string) => void;
  onEditRepo: (p: Project) => void;
}

/** Libellé long d'un code de statut git, pour l'infobulle du badge. */
const STATUS_LABEL: Record<string, string> = {
  M: "Modifié",
  A: "Ajouté",
  D: "Supprimé",
  R: "Renommé",
  C: "Copié",
  "?": "Nouveau fichier (pas encore suivi par git)",
  U: "Conflit",
};

/** Rafraîchissement automatique de la page git (fichiers + commits à pousser/récupérer). */
const AUTO_RELOAD_MS = 4000;

/** Identité d'une entrée : un fichier partiellement indexé en a deux (index + modifications). */
function entryKey(c: GitChange): string {
  return (c.staged ? "s:" : "u:") + c.path;
}

/** Comparaison à ouvrir pour une entrée (partiellement indexée : sa seule part). */
function diffSide(c: GitChange): "staged" | "unstaged" | undefined {
  return c.partial ? (c.staged ? "staged" : "unstaged") : undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Page plein écran des modifications non commitées d'un projet : liste des
 * fichiers impactés, diff dépliable par fichier, sélection (stage/unstage) des
 * fichiers à valider, puis commit et push. Montée avec `key={project.id}`.
 */
export function GitChangesView({
  project,
  git,
  gitExe,
  onBack,
  onChanged,
  onCheckout,
  changelists,
  onChangelists,
  repoLink,
  hiddenRepoActions,
  onOpenUrl,
  onEditRepo,
}: Props) {
  // Liens du dépôt en ligne (MR/PR, pipelines, branche…), suivant la branche.
  const repoLinks = repoLink ? buildRepoLinks(repoLink, git?.branch) : null;
  const repoButtons = repoLinks
    ? repoActions(repoLinks).filter((a) => a.url && !(hiddenRepoActions ?? []).includes(a.key))
    : [];
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // busy = opération bloquante (commit/push) ; syncing = git add/reset en tâche
  // de fond (n'empêche pas de continuer à basculer d'autres fichiers).
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Diffs chargés à la demande : chemin → texte du diff (ou "" si vide).
  // Message de commit conservé par projet (retour sur la page, redémarrage).
  const msgKey = "devlauncher.commitMsg." + project.id;
  const [message, setMessage] = useState(() => {
    try {
      return localStorage.getItem(msgKey) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      if (message) localStorage.setItem(msgKey, message);
      else localStorage.removeItem(msgKey);
    } catch {
      /* stockage indisponible : message non conservé */
    }
  }, [msgKey, message]);
  // Résultat du dernier changement de branche lancé depuis cette page.
  const [branchMsg, setBranchMsg] = useState<{ ok: boolean; text: string; detail?: string } | null>(null);
  const [switching, setSwitching] = useState(false);
  // Onglet : modifications en cours ou historique des commits.
  const [tab, setTab] = useState<"changes" | "history">("changes");
  // Menus déroulants : « Commit ▾ » (Commit & Push) et liens du dépôt en ligne.
  const [commitMenu, setCommitMenu] = useState(false);
  const [linksMenu, setLinksMenu] = useState(false);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const linksMenuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!commitMenu && !linksMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!commitMenuRef.current?.contains(t)) setCommitMenu(false);
      if (!linksMenuRef.current?.contains(t)) setLinksMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [commitMenu, linksMenu]);
  // Sortie de la dernière commande (commit/push) affichée en bas de page.
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  // Glisser-déposer (dnd-kit) entre les deux listes.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Commits à pousser / à récupérer (relus avec l'état des fichiers).
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [outgoingOpen, setOutgoingOpen] = useState(true);

  const reload = useCallback(async () => {
    // En parallèle : la liste des commits ne bloque pas celle des fichiers.
    // Contenu identique : on garde l'objet courant (pas de re-rendu inutile lors
    // du rafraîchissement automatique).
    void api
      .gitOutgoing(gitExe, project.path)
      .then((o) => setOutgoing((prev) => (sameJson(prev, o) ? prev : o)))
      .catch(() => setOutgoing(null));
    try {
      const list = await api.gitChanges(gitExe, project.path);
      setChanges((prev) => (sameJson(prev, list) ? prev : list));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [gitExe, project.path]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  // Recharge la liste quand la branche change (ex. checkout depuis cette page) :
  // l'arbre de travail n'est plus le même. On saute le premier rendu (déjà chargé).
  const lastBranch = useRef(git?.branch);
  useEffect(() => {
    if (git?.branch !== lastBranch.current) {
      lastBranch.current = git?.branch;
      reload();
    }
  }, [git?.branch, reload]);

  // ----- Opération en cours (merge/rebase) et conflits -----
  const [mergeState, setMergeState] = useState<MergeState | null>(null);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  // Information non bloquante (ex. le rebase passe au commit suivant, lui aussi en conflit).
  const [conflictInfo, setConflictInfo] = useState<string | null>(null);
  // Fichier ouvert dans la fusion 3 volets.
  const [mergeFile, setMergeFile] = useState<{ file: string; versions: ConflictVersions } | null>(null);
  // Fichier ouvert dans la comparaison 2 volets (HEAD ↔ version de travail).
  const [diffFile, setDiffFile] = useState<{
    path: string;
    orig: string | null;
    versions: FileVersions;
    key: string;
    side?: "staged" | "unstaged";
  } | null>(null);
  // Boîte merge/rebase : "pull" (demandé) ou "rejected" (push rejeté).
  const [updateAsk, setUpdateAsk] = useState<"pull" | "rejected" | null>(null);
  // Push à relancer une fois la mise à jour (et ses conflits) terminée.
  const pendingPush = useRef(false);

  const loadMergeState = useCallback(async (): Promise<MergeState | null> => {
    try {
      const st = await api.gitMergeState(gitExe, project.path);
      setMergeState((prev) => (sameJson(prev, st) ? prev : st));
      return st;
    } catch {
      return null;
    }
  }, [gitExe, project.path]);

  useEffect(() => {
    loadMergeState();
  }, [loadMergeState]);

  const conflicted = new Set(mergeState?.conflicts.map((c) => c.path) ?? []);
  // Les fichiers en conflit sont gérés par la boîte « Conflits », pas par l'index.
  const staged = changes.filter((c) => c.staged && !conflicted.has(c.path));
  const unstaged = changes.filter((c) => !c.staged && !conflicted.has(c.path));

  // ----- Changelists (façon JetBrains, stockées dans la config DevLauncher) -----
  const lists = listsOf(changelists);
  const exIds = excludedIds(changelists);
  // Fichiers que « Tout ajouter » prend : hors listes exclues.
  // Fichiers distincts (un fichier partiellement indexé compte une seule fois).
  const fileCount = new Set(changes.map((c) => c.path)).size;
  const addable = unstaged.filter((c) => !exIds.has(listIdOf(changelists, c.path)));
  const clRef = useRef(changelists);
  clRef.current = changelists;
  /** Applique une modification aux changelists du projet et l'enregistre. */
  const updateCl = useCallback(
    (fn: (cur: ProjectChangelists) => ProjectChangelists) => {
      const cur = clRef.current ?? emptyChangelists();
      const next = fn({ lists: listsOf(cur), files: { ...cur.files } });
      clRef.current = next;
      onChangelists(next);
    },
    [onChangelists],
  );
  /** Range des fichiers dans une liste (la liste par défaut n'est pas stockée). */
  const moveToList = useCallback(
    (paths: string[], listId: string) =>
      updateCl((cur) => {
        for (const p of paths) {
          if (listId === DEFAULT_LIST_ID) delete cur.files[p];
          else cur.files[p] = listId;
        }
        return cur;
      }),
    [updateCl],
  );
  const [editingList, setEditingList] = useState<{ id: string; name: string } | null>(null);
  // Rollback d'une changelist en attente de confirmation.
  const [rollbackAsk, setRollbackAsk] = useState<{ name: string; files: GitChange[] } | null>(null);
  const addList = (name: string, excluded: boolean) => {
    const id = newListId();
    updateCl((cur) => ({ ...cur, lists: [...cur.lists, { id, name, excluded }] }));
    if (!excluded) setEditingList({ id, name });
  };
  const renameList = (id: string, name: string) =>
    updateCl((cur) => ({ ...cur, lists: cur.lists.map((l) => (l.id === id ? { ...l, name: name.trim() || l.name } : l)) }));
  /** Replie / déplie une liste (mémorisé dans la config, comme le reste). */
  const toggleCollapsed = (id: string) =>
    updateCl((cur) => ({ ...cur, lists: cur.lists.map((l) => (l.id === id ? { ...l, collapsed: !l.collapsed } : l)) }));
  const toggleExcluded = (id: string) =>
    updateCl((cur) => ({ ...cur, lists: cur.lists.map((l) => (l.id === id ? { ...l, excluded: !l.excluded } : l)) }));
  /** Supprime une liste : ses fichiers retournent dans la liste par défaut. */
  const removeList = (id: string) =>
    updateCl((cur) => ({
      lists: cur.lists.filter((l) => l.id !== id),
      files: Object.fromEntries(Object.entries(cur.files).filter(([, l]) => l !== id)),
    }));

  // Oublie l'affectation des fichiers qui ne sont plus modifiés (comme
  // JetBrains : un fichier modifié à nouveau repart dans la liste par défaut).
  useEffect(() => {
    if (loading || error || !changelists) return;
    const present = new Set(changes.map((c) => c.path));
    const stale = Object.keys(changelists.files).filter((p) => !present.has(p));
    if (stale.length)
      updateCl((cur) => {
        for (const p of stale) delete cur.files[p];
        return cur;
      });
  }, [changes, loading, error, changelists, updateCl]);


  // ----- Stage / unstage optimiste et groupé -----
  // La bascule est appliquée instantanément à l'état local ; les commandes git
  // (add/reset) sont accumulées puis envoyées en un seul appel groupé, en tâche
  // de fond, sans recharger tout `git status`. Transférer 50 fichiers ne coûte
  // alors qu'un `git add` + un `git reset`, au lieu de 100 process git-bash.
  const changesRef = useRef<GitChange[]>([]);
  changesRef.current = changes;
  // Fichiers en attente d'être envoyés à git (état voulu, dédupliqué par chemin).
  const pendingStage = useRef<Set<string>>(new Set());
  const pendingUnstage = useRef<Set<string>>(new Set());
  const flushTimer = useRef<number | null>(null);
  // Chaîne des flushs en cours : sérialise les appels git (l'index a un verrou,
  // deux `git add`/`reset` concurrents se marcheraient dessus).
  const flushChain = useRef<Promise<void> | null>(null);

  const doFlush = useCallback(async () => {
    const toStage = [...pendingStage.current];
    const toUnstage = [...pendingUnstage.current];
    pendingStage.current.clear();
    pendingUnstage.current.clear();
    if (toStage.length === 0 && toUnstage.length === 0) return;
    try {
      if (toStage.length) await api.gitStage(gitExe, project.path, toStage);
      if (toUnstage.length) await api.gitUnstage(gitExe, project.path, toUnstage);
    } catch (e) {
      setError(String(e));
      // Désynchronisation possible : on relit la vérité git.
      await reload();
    }
  }, [gitExe, project.path, reload]);

  const flush = useCallback(async (): Promise<void> => {
    if (flushTimer.current != null) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const prev = flushChain.current ?? Promise.resolve();
    const p = prev.then(() => doFlush());
    flushChain.current = p;
    setSyncing(true);
    try {
      await p;
    } finally {
      if (flushChain.current === p) {
        flushChain.current = null;
        setSyncing(false);
      }
    }
  }, [doFlush]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current != null) clearTimeout(flushTimer.current);
    // Court délai : regroupe les bascules rapprochées (drag en rafale) en un lot.
    flushTimer.current = window.setTimeout(() => void flushRef.current(), 180);
  }, []);

  /** Bascule l'état stagé de fichiers : instantané en local, git en différé. */
  const setStaged = useCallback(
    (files: string[], stage: boolean) => {
      // On n'agit que sur les fichiers dont l'état change réellement (un fichier
      // partiellement indexé a une entrée de chaque côté : il change toujours).
      const affected = [...new Set(files)].filter((f) =>
        changesRef.current.some((x) => x.path === f && x.staged !== stage),
      );
      if (affected.length === 0) return;
      setChanges((prev) => {
        const out: GitChange[] = [];
        const done = new Set<string>();
        for (const c of prev) {
          if (!affected.includes(c.path)) {
            out.push(c);
            continue;
          }
          if (done.has(c.path)) continue;
          done.add(c.path);
          // git add / git reset réunit les deux entrées d'un fichier partiel.
          const base = prev.find((x) => x.path === c.path && x.staged) ?? c;
          out.push({ ...base, staged: stage, partial: false });
        }
        return out;
      });
      const add = stage ? pendingStage.current : pendingUnstage.current;
      const rem = stage ? pendingUnstage.current : pendingStage.current;
      for (const f of affected) {
        add.add(f);
        rem.delete(f);
      }
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // Envoie les bascules restantes en quittant la page (démontage du composant).
  useEffect(() => () => void flushRef.current(), []);

  // ----- Rafraîchissement automatique -----
  // Relit l'état git à intervalle régulier : fichiers modifiés depuis l'IDE,
  // commit/pull faits en console, commits récupérés par le fetch automatique…
  // Jamais pendant une opération ou tant qu'une bascule stage/unstage n'est pas
  // encore envoyée à git (l'état optimiste serait écrasé), ni fenêtre masquée.
  const autoReloadOk = useRef<() => boolean>(() => false);
  autoReloadOk.current = () =>
    !busy &&
    !syncing &&
    !switching &&
    !document.hidden &&
    flushTimer.current == null &&
    flushChain.current == null &&
    pendingStage.current.size === 0 &&
    pendingUnstage.current.size === 0;
  const autoReloading = useRef(false);
  useEffect(() => {
    const tick = async () => {
      if (autoReloading.current || !autoReloadOk.current()) return;
      autoReloading.current = true;
      try {
        await reload();
        await loadMergeState();
      } finally {
        autoReloading.current = false;
      }
    };
    const iv = window.setInterval(tick, AUTO_RELOAD_MS);
    // Retour sur la fenêtre : relecture immédiate.
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload, loadMergeState]);

  // Dépose d'un fichier : vers « Dans l'index » (staged) le stage ; vers une
  // changelist, le retire de l'index (no-op s'il n'y est pas) et l'y range.
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      if (!e.over) return;
      // id = clé de l'entrée ("s:" / "u:" + chemin).
      const path = String(e.active.id).slice(2);
      const over = String(e.over.id);
      if (over === "staged") return setStaged([path], true);
      setStaged([path], false);
      if (over.startsWith("cl:")) moveToList([path], over.slice(3));
    },
    [setStaged, moveToList],
  );

  /** Pousse la branche ; un rejet (branche distante en avance) propose merge/rebase. */
  const doPush = useCallback(async () => {
    pendingPush.current = false;
    try {
      const out = await api.gitPush(gitExe, project.path);
      setOutput({ ok: true, text: out || "Push effectué." });
      onChanged();
      // Les commits poussés quittent la liste « à pousser ».
      void reload();
    } catch (e) {
      const msg = String(e);
      setOutput({ ok: false, text: msg });
      if (/\[rejected\]|non-fast-forward|fetch first|tip of your current branch is behind/i.test(msg))
        setUpdateAsk("rejected");
    }
  }, [gitExe, project.path, onChanged, reload]);

  /** Commit (et push dans la foulée si `andPush`, comme « Commit and Push » de JetBrains). */
  const commit = useCallback(
    async (andPush = false) => {
      if (busy || staged.length === 0 || !message.trim()) return;
      setBusy(true);
      setError(null);
      try {
        // Applique d'abord les bascules en attente pour que l'index soit à jour.
        await flush();
        const out = await api.gitCommit(gitExe, project.path, message.trim());
        setOutput({ ok: true, text: out || "Commit effectué." });
        // Le message reste en place (réutilisable pour un commit suivant).
        await reload();
        onChanged();
        if (andPush) await doPush();
      } catch (e) {
        setOutput({ ok: false, text: String(e) });
      } finally {
        setBusy(false);
      }
    },
    [gitExe, project.path, busy, staged.length, message, flush, reload, onChanged, doPush],
  );

  const push = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await doPush();
    } finally {
      setBusy(false);
    }
  }, [busy, doPush]);

  /** Fin d'une mise à jour réussie (plus de conflit) : relit l'état, relance le push éventuel. */
  const finishUpdate = useCallback(
    async (text: string) => {
      setConflictsOpen(false);
      setConflictMsg(null);
      setOutput({ ok: true, text });
      await reload();
      onChanged();
      if (pendingPush.current) await doPush();
    },
    [reload, onChanged, doPush],
  );

  /** Relit l'état après une étape ; ouvre la boîte « Conflits » s'il en reste. */
  const checkConflicts = useCallback(async (): Promise<MergeState | null> => {
    const st = await loadMergeState();
    await reload();
    if (st?.operation && st.conflicts.length > 0) setConflictsOpen(true);
    return st;
  }, [loadMergeState, reload]);

  /** Pull (merge ou rebase) ; enchaîne sur la résolution des conflits si besoin. */
  const pull = useCallback(
    async (rebase: boolean, thenPush: boolean, target?: PullTarget) => {
      setUpdateAsk(null);
      setBusy(true);
      setError(null);
      pendingPush.current = thenPush;
      try {
        await flush();
        await awaitFetch(project.path);
        let out = "";
        let ok = true;
        try {
          out = await api.gitPull(gitExe, project.path, rebase, target?.remote, target?.name);
        } catch (e) {
          ok = false;
          out = String(e);
        }
        const st = await checkConflicts();
        if (st?.operation && st.conflicts.length > 0) {
          setOutput({ ok: false, text: out });
        } else if (ok) {
          await finishUpdate(out || "Branche à jour.");
        } else {
          pendingPush.current = false;
          setOutput({ ok: false, text: out });
        }
      } finally {
        setBusy(false);
      }
    },
    [gitExe, project.path, flush, checkConflicts, finishUpdate],
  );

  // Fetch d'affichage (boîte Pull) : passe par fetchRepo, que le pull attend
  // avant de partir (comme le fetch automatique), deux fetch simultanés se
  // disputant les verrous des refs.
  const loadRemoteBranches = useCallback(
    (fetch: boolean) =>
      fetch ? fetchRepo(gitExe, project.path) : api.gitRemoteBranches(gitExe, project.path, false),
    [gitExe, project.path],
  );

  /** git <op> --continue / --abort / --skip. */
  const mergeAction = useCallback(
    async (action: "continue" | "abort" | "skip", opOverride?: string) => {
      const op = opOverride ?? mergeState?.operation;
      if (!op) return;
      setBusy(true);
      setConflictMsg(null);
      setConflictInfo(null);
      try {
        const out = await api.gitMergeAction(gitExe, project.path, op, action);
        if (action === "abort") {
          pendingPush.current = false;
          setConflictsOpen(false);
          setOutput({ ok: true, text: out || `${OP_LABEL[op] ?? op} annulé(e).` });
          await loadMergeState();
          await reload();
          onChanged();
          return;
        }
        // Un rebase peut s'arrêter à nouveau sur le commit suivant.
        const st = await checkConflicts();
        if (st?.operation) {
          if (st.conflicts.length === 0) setConflictMsg(out || null);
        } else await finishUpdate(out || `${OP_LABEL[op] ?? op} terminé(e).`);
      } catch (e) {
        // Un rebase rejoue les commits un par un : --continue/--skip échoue
        // quand le commit SUIVANT est lui aussi en conflit. Ce n'est pas une
        // erreur, c'est l'étape suivante (git renvoie simplement un code ≠ 0).
        const st = action === "abort" ? null : await checkConflicts();
        if (st?.operation && st.conflicts.length > 0) {
          const n = st.conflicts.length;
          const prog = st.total > 0 ? ` ${st.step}/${st.total}` : "";
          setConflictInfo(
            `${action === "skip" ? "Commit ignoré." : "Commit précédent appliqué."} ` +
              `Le commit${prog}${st.commit ? ` « ${st.commit} »` : ""} est à son tour en conflit ` +
              `(${n} fichier${n > 1 ? "s" : ""}).`,
          );
        } else {
          setConflictMsg(String(e));
          await loadMergeState();
        }
      } finally {
        setBusy(false);
      }
    },
    [gitExe, project.path, mergeState?.operation, checkConflicts, finishUpdate, loadMergeState, reload, onChanged],
  );

  /** Après la résolution d'un fichier : finalise automatiquement s'il n'en reste plus. */
  const afterResolve = useCallback(async () => {
    const st = await loadMergeState();
    await reload();
    if (st?.operation && st.conflicts.length === 0) await mergeAction("continue", st.operation);
  }, [loadMergeState, reload, mergeAction]);

  const acceptSide = useCallback(
    async (files: string[], side: "ours" | "theirs") => {
      setBusy(true);
      setConflictMsg(null);
      try {
        await api.gitResolveSide(gitExe, project.path, files, side);
        setMergeFile(null);
        await afterResolve();
      } catch (e) {
        setConflictMsg(String(e));
      } finally {
        setBusy(false);
      }
    },
    [gitExe, project.path, afterResolve],
  );

  const openMerge = useCallback(
    async (file: string) => {
      setBusy(true);
      setConflictMsg(null);
      try {
        const versions = await api.gitConflictVersions(gitExe, project.path, file);
        if (versions.binary)
          setConflictMsg(
            `${file} n'est pas un fichier texte : choisissez « Accepter la vôtre » ou « Accepter l'entrante ».`,
          );
        else setMergeFile({ file, versions });
      } catch (e) {
        setConflictMsg(String(e));
      } finally {
        setBusy(false);
      }
    },
    [gitExe, project.path],
  );

  // ----- Comparaison 2 volets -----
  // Ordre de navigation : celui de l'écran (index, puis chaque changelist).
  const diffOrder = useMemo(() => {
    const ordered = [...staged];
    for (const l of lists) ordered.push(...unstaged.filter((c) => listIdOf(changelists, c.path) === l.id));
    return ordered;
  }, [staged, unstaged, lists, changelists]);

  const openDiff = useCallback(
    async (c: GitChange) => {
      setBusy(true);
      setError(null);
      try {
        const side = diffSide(c);
        const versions = await api.gitFileVersions(gitExe, project.path, c.path, c.orig, side);
        setDiffFile({ path: c.path, orig: c.orig, versions, key: entryKey(c), side });
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [gitExe, project.path],
  );

  /** Enregistre le fichier édité depuis la comparaison, puis relit son état. */
  const saveDiff = useCallback(
    async (content: string): Promise<boolean> => {
      if (!diffFile) return false;
      const { path, orig, side } = diffFile;
      // La part indexée d'un fichier partiel est en lecture seule.
      if (side === "staged") return false;
      setBusy(true);
      try {
        await api.gitWriteWorktreeFile(gitExe, project.path, path, content);
        const versions = await api.gitFileVersions(gitExe, project.path, path, orig, side);
        setDiffFile((d) => (d && d.path === path ? { ...d, versions } : d));
        await reload();
        onChanged();
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [diffFile, gitExe, project.path, reload, onChanged],
  );

  const saveMerge = useCallback(
    async (content: string) => {
      if (!mergeFile) return;
      setBusy(true);
      try {
        await api.gitResolveFile(gitExe, project.path, mergeFile.file, content);
        setMergeFile(null);
        await afterResolve();
      } catch (e) {
        setConflictMsg(String(e));
        setMergeFile(null);
      } finally {
        setBusy(false);
      }
    },
    [gitExe, project.path, mergeFile, afterResolve],
  );

  /** Rollback confirmé : annule les modifications non indexées des fichiers. */
  const doRollback = useCallback(
    async (files: GitChange[]) => {
      setRollbackAsk(null);
      setBusy(true);
      setError(null);
      try {
        // Les bascules en attente d'abord (sinon un git add différé passerait après).
        await flush();
        const tracked = files.filter((c) => !c.untracked).map((c) => c.path);
        const untracked = files.filter((c) => c.untracked).map((c) => c.path);
        await api.gitRollback(gitExe, project.path, tracked, untracked);
        setOutput({
          ok: true,
          text: `Rollback effectué : ${files.length} fichier${files.length > 1 ? "s" : ""} restauré${files.length > 1 ? "s" : ""}.`,
        });
      } catch (e) {
        setOutput({ ok: false, text: String(e) });
      } finally {
        await reload();
        onChanged();
        setBusy(false);
      }
    },
    [flush, gitExe, project.path, reload, onChanged],
  );

  // Actualiser : applique les bascules en attente avant de relire l'état git
  // (sinon un rechargement écraserait l'affichage optimiste non encore synchro).
  const refresh = useCallback(async () => {
    await flush();
    await reload();
    await loadMergeState();
  }, [flush, reload, loadMergeState]);

  /**
   * Change de branche (même action qu'ailleurs, exécutée dans la console du
   * projet) puis affiche ici son issue : réussite, ou échec avec la sortie git.
   */
  const changeBranch = useCallback(async () => {
    const since = Date.now();
    setBranchMsg(null);
    setSwitching(true);
    try {
      await flush();
      const r = await onCheckout(project);
      if (!r) return; // sélecteur fermé sans choisir
      if (r.status === "done") {
        setBranchMsg({
          ok: true,
          text: r.isNew ? `Branche « ${r.branch} » créée et active.` : `Vous êtes maintenant sur « ${r.branch} ».`,
        });
      } else {
        // Sortie de git (console du projet) depuis le lancement : la cause de l'échec.
        const logs = await api.getLogs(project.id).catch(() => []);
        const detail = logs
          .filter((l) => l.ts >= since)
          .map((l) => l.line)
          .slice(-15)
          .join("\n");
        setBranchMsg({
          ok: false,
          text:
            r.status === "cancelled"
              ? `Changement vers « ${r.branch} » annulé.`
              : `Échec du changement de branche vers « ${r.branch} ».`,
          detail: detail || undefined,
        });
      }
      await reload();
      await loadMergeState();
    } finally {
      setSwitching(false);
    }
  }, [flush, onCheckout, project, reload, loadMergeState]);

  const renderRow = (c: GitChange) => {
    return (
      <DraggableFile id={entryKey(c)} disabled={busy} key={entryKey(c)}>
        {({ setNodeRef, handle, isDragging }) => (
          <div className={"gc-file" + (isDragging ? " gc-dragging" : "")}>
            <div className="gc-file-head" ref={setNodeRef}>
              <span
                className="gc-grip"
                title="Glisser vers l'autre liste"
                aria-hidden="true"
                {...handle}
              >
                ⠿
              </span>
              <input
                type="checkbox"
                className="gc-check"
                checked={c.staged}
                disabled={busy}
                title={c.staged ? "Retirer de l'index (untrack)" : "Ajouter à l'index (track)"}
                onChange={() => setStaged([c.path], !c.staged)}
              />
              <span
                className={"gc-status gc-status-" + c.status.replace("?", "u")}
                title={STATUS_LABEL[c.status] ?? c.status}
              >
                {/* Le « ? » brut de git devient « N » (Nouveau), plus parlant. */}
                {c.status === "?" ? "N" : c.status}
              </span>
              <button
                className="gc-path"
                disabled={busy}
                onClick={() => void openDiff(c)}
                title={
                  !c.partial
                    ? "Comparer côte à côte (HEAD ↔ version de travail)"
                    : c.staged
                      ? "Comparer la part indexée (HEAD ↔ index) : ce que prendra le commit"
                      : "Comparer les changements faits après l'ajout à l'index (index ↔ version de travail)"
                }
              >
                {c.orig && <span className="gc-orig">{c.orig} → </span>}
                <span className="gc-name">{c.path}</span>
                {c.partial && (
                  <span
                    className="gc-partial"
                    title={
                      c.staged
                        ? "Fichier modifié à nouveau après l'ajout à l'index : la suite est dans les modifications"
                        : "Changements faits après l'ajout à l'index : non pris par le commit tant qu'ils n'y sont pas ajoutés"
                    }
                  >
                    {c.staged ? "partiel" : "en plus de l'index"}
                  </span>
                )}
                <span className="gc-compare-ico" aria-hidden="true">⇆</span>
              </button>
            </div>
          </div>
        )}
      </DraggableFile>
    );
  };

  const swap = mergeState?.operation === "rebase";
  if (diffFile) {
    const idx = diffOrder.findIndex((c) => entryKey(c) === diffFile.key);
    const step = (d: 1 | -1) => {
      const c = diffOrder[idx + d];
      if (c) void openDiff(c);
    };
    return (
      <DiffView
        key={diffFile.key}
        file={diffFile.path}
        orig={diffFile.orig}
        versions={diffFile.versions}
        busy={busy}
        readOnly={diffFile.side === "staged"}
        leftLabel={diffFile.side === "unstaged" ? "Index (déjà prêt à committer)" : undefined}
        rightLabel={diffFile.side === "staged" ? "Index (ce que prendra le commit)" : undefined}
        index={Math.max(0, idx)}
        total={diffOrder.length}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onSave={saveDiff}
        onClose={() => setDiffFile(null)}
      />
    );
  }

  if (mergeFile && mergeState) {
    return (
      <MergeView
        key={mergeFile.file}
        file={mergeFile.file}
        versions={mergeFile.versions}
        swap={swap}
        leftLabel={(swap ? mergeState.theirs_label : mergeState.ours_label) || "local"}
        rightLabel={(swap ? mergeState.ours_label : mergeState.theirs_label) || "distant"}
        busy={busy}
        onSave={saveMerge}
        onAcceptSide={(side) => acceptSide([mergeFile.file], side)}
        onCancel={() => setMergeFile(null)}
      />
    );
  }

  const opName = mergeState?.operation ? (OP_LABEL[mergeState.operation] ?? mergeState.operation) : "";

  return (
    <div className="settings">
      {rollbackAsk && (
        <div className="modal-backdrop" onMouseDown={() => setRollbackAsk(null)}>
          <div
            className="modal"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === "Escape" && setRollbackAsk(null)}
          >
            <div className="modal-head">
              <h3>Rollback de « {rollbackAsk.name} »</h3>
              <button className="tab-close" onClick={() => setRollbackAsk(null)}>
                ×
              </button>
            </div>
            <p className="cf-p">
              Les modifications non indexées de ces {rollbackAsk.files.length} fichier
              {rollbackAsk.files.length > 1 ? "s" : ""} vont être <b>définitivement perdues</b> :
            </p>
            <div className="gc-rollback-list">
              {rollbackAsk.files.map((c) => (
                <div key={c.path} className="gc-rollback-item">
                  <span className={"gc-status gc-status-" + c.status.replace("?", "u")}>
                    {c.status === "?" ? "N" : c.status}
                  </span>
                  <span className="gc-name">{c.path}</span>
                  <span className="muted">
                    {c.untracked ? "supprimé" : c.partial ? "revient à la version de l'index" : "revient à HEAD"}
                  </span>
                </div>
              ))}
            </div>
            <p className="cf-p cf-hint">
              Les fichiers nouveaux (N) sont supprimés du disque. La partie déjà dans l'index n'est pas touchée.
            </p>
            <div className="modal-footer">
              <button className="btn btn-ghost" autoFocus onClick={() => setRollbackAsk(null)}>
                Annuler
              </button>
              <button className="btn btn-stop" onClick={() => void doRollback(rollbackAsk.files)}>
                Rollback
              </button>
            </div>
          </div>
        </div>
      )}
      {conflictsOpen && mergeState?.operation && (
        <ConflictsModal
          state={mergeState}
          busy={busy}
          message={conflictMsg}
          info={conflictInfo}
          onAccept={acceptSide}
          onMerge={openMerge}
          onAbort={() => mergeAction("abort")}
          onContinue={() => mergeAction("continue")}
          onSkip={() => mergeAction("skip")}
          onClose={() => setConflictsOpen(false)}
        />
      )}
      {updateAsk && (
        <UpdateModal
          rejected={updateAsk === "rejected"}
          current={git?.branch ?? "—"}
          loadBranches={loadRemoteBranches}
          onChoose={(rebase, target) => pull(rebase, updateAsk === "rejected", target)}
          onCancel={() => setUpdateAsk(null)}
        />
      )}
      <div className={"settings-inner detail gc" + (tab === "history" ? " gc-wide" : "")}>
        <button className="tab-close settings-close" onClick={onBack} title="Retour (Échap)">
          ×
        </button>

        <div className="detail-head">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            ← Retour
          </button>
          <h1 className="detail-title">
            {project.name}
            <button
              className="chip chip-branch"
              title={git ? `Branche ${git.branch} — changer de branche` : "Changer de branche"}
              onClick={() => void changeBranch()}
              disabled={busy || switching}
            >
              {switching ? <span className="spinner spinner-xs" /> : <span className="chip-ico">⌥</span>}
              <span className="chip-branch-txt">{git?.branch ?? "—"}</span>
            </button>
            {/* Dépôt en ligne (ex-menu du bouton VCS) : un seul bouton déroulant. */}
            <span className="gc-links" ref={linksMenuRef}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setLinksMenu((o) => !o)}
                title={repoLink || "Dépôt en ligne non lié"}
              >
                {repoLinks ? (repoLinks.platform === "github" ? "GitHub" : "GitLab") : "Dépôt en ligne"} ▾
              </button>
              {linksMenu && (
                <div className="gc-menu">
                  {repoButtons.map((a) => (
                    <button
                      key={a.key}
                      className="menu-item"
                      title={a.url!}
                      onClick={() => {
                        setLinksMenu(false);
                        onOpenUrl(a.url!);
                      }}
                    >
                      {a.label} ↗
                    </button>
                  ))}
                  {repoButtons.length > 0 && <div className="menu-sep" />}
                  <button
                    className="menu-item"
                    onClick={() => {
                      setLinksMenu(false);
                      onEditRepo(project);
                    }}
                  >
                    {repoLink ? "✎ Modifier le lien…" : "＋ Lier le dépôt en ligne…"}
                  </button>
                </div>
              )}
            </span>
          </h1>
          <div className="muted detail-path" title={project.path}>
            {project.path}
          </div>
        </div>

        {branchMsg && (
          <div className={"gc-branch-msg" + (branchMsg.ok ? " ok" : " ko")}>
            <span className="gc-branch-msg-txt">
              {branchMsg.ok ? "✓ " : "✕ "}
              {branchMsg.text}
            </span>
            <button className="tab-close" onClick={() => setBranchMsg(null)} title="Masquer">
              ×
            </button>
            {branchMsg.detail && <pre className="gc-branch-msg-detail">{branchMsg.detail}</pre>}
          </div>
        )}

        <div className="gc-tabs">
          <button className={"gc-tab" + (tab === "changes" ? " on" : "")} onClick={() => setTab("changes")}>
            Modifications
            {changes.length > 0 && <span className="gc-tab-count">{changes.length}</span>}
          </button>
          <button className={"gc-tab" + (tab === "history" ? " on" : "")} onClick={() => setTab("history")}>
            Historique
          </button>
        </div>

        {tab === "history" ? (
          <GitHistoryView gitExe={gitExe} path={project.path} branch={git?.branch} />
        ) : (
        <>

        <div className="gc-toolbar">
          <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={busy || loading} title="Actualiser">
            ↻
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setStaged(addable.map((c) => c.path), true)}
            disabled={busy || addable.length === 0}
            title={exIds.size ? "Hors changelists exclues (« ne jamais committer »)" : undefined}
          >
            Tout ajouter à l'index
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setStaged(staged.map((c) => c.path), false)}
            disabled={busy || staged.length === 0}
          >
            Tout retirer
          </button>
          {/* Changelists : dans la même barre, pour ne pas ajouter une ligne. */}
          <span className="mv-sep" />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => addList("Nouvelle liste", false)}
            title="Nouvelle changelist"
          >
            ＋ Changelist
          </button>
          {!lists.some((l) => l.excluded) && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => addList("Ne jamais committer", true)}
              title="Créer la liste « Ne jamais committer » : modifications locales permanentes, non comptées sur la carte"
            >
              ⊘ Ne jamais committer
            </button>
          )}
          {syncing && (
            <span className="gc-sync muted" title="Synchronisation avec git…">
              <span className="spinner spinner-xs" /> sync…
            </span>
          )}
          <span className="gc-count muted">
            {fileCount} fichier{fileCount > 1 ? "s" : ""} — {staged.length} dans l'index
          </span>
        </div>

        {error && <div className="banner-error">{error}</div>}


        {/* Commits pas encore poussés / commits distants à récupérer. */}
        {outgoing && (outgoing.ahead.length > 0 || outgoing.behind.length > 0) && (
          <section className="detail-section gc-out">
            <div className="gc-cl-head">
              <button
                className="gc-cl-toggle"
                onClick={() => setOutgoingOpen((o) => !o)}
                title={outgoingOpen ? "Replier" : "Déplier"}
              >
                <span className={"gc-caret" + (outgoingOpen ? " open" : "")}>▶</span>
              </button>
              <h2 onClick={() => setOutgoingOpen((o) => !o)}>
                {outgoing.ahead.length > 0 && (
                  <span className="gc-out-ahead">
                    ↑ {outgoing.ahead.length} commit{outgoing.ahead.length > 1 ? "s" : ""} à pousser
                  </span>
                )}
                {outgoing.ahead.length > 0 && outgoing.behind.length > 0 && <span className="muted"> · </span>}
                {outgoing.behind.length > 0 && (
                  <span className="gc-out-behind">
                    ↓ {outgoing.behind.length} à récupérer
                  </span>
                )}
                <span className="muted gc-out-up">
                  {outgoing.upstream ? ` — ${outgoing.upstream}` : " — pas encore de branche distante"}
                </span>
              </h2>
              <span className="gc-cl-actions">
                {outgoing.behind.length > 0 && (
                  <button
                    className="btn btn-sm"
                    disabled={busy || !!mergeState?.operation}
                    onClick={() => setUpdateAsk("pull")}
                  >
                    Pull
                  </button>
                )}
                {outgoing.ahead.length > 0 && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy || !!mergeState?.operation}
                    onClick={push}
                    title={outgoing.upstream ? `git push vers ${outgoing.upstream}` : "git push -u origin HEAD (crée la branche distante)"}
                  >
                    Push
                  </button>
                )}
              </span>
            </div>
            {outgoingOpen && (
              <div className="gc-commits">
                {outgoing.ahead.map((c) => (
                  <div key={"a" + c.hash} className="gc-commit-row" title={`${c.hash} — ${c.author}, ${c.date}`}>
                    <span className="gc-commit-dir gc-out-ahead">↑</span>
                    <code className="gc-commit-hash">{c.hash}</code>
                    <span className="gc-commit-subj">{c.subject}</span>
                    <span className="muted gc-commit-meta">
                      {c.author} · {c.date}
                    </span>
                  </div>
                ))}
                {outgoing.behind.map((c) => (
                  <div key={"b" + c.hash} className="gc-commit-row" title={`${c.hash} — ${c.author}, ${c.date}`}>
                    <span className="gc-commit-dir gc-out-behind">↓</span>
                    <code className="gc-commit-hash">{c.hash}</code>
                    <span className="gc-commit-subj">{c.subject}</span>
                    <span className="muted gc-commit-meta">
                      {c.author} · {c.date}
                    </span>
                  </div>
                ))}
                {!outgoing.upstream && (
                  <small className="muted">Branche locale sans branche distante : le prochain Push la créera.</small>
                )}
                {outgoing.behind.length > 0 && (
                  <small className="muted">Commits distants connus au dernier fetch (Pull pour les récupérer).</small>
                )}
              </div>
            )}
          </section>
        )}

        {mergeState?.operation && (
          <div className={"gc-merge" + (mergeState.conflicts.length ? " gc-merge-conflict" : "")}>
            <span className="gc-merge-txt">
              {mergeState.conflicts.length
                ? `⚠ ${opName}${mergeState.total > 0 ? ` (commit ${mergeState.step}/${mergeState.total})` : ""} en cours : ${mergeState.conflicts.length} fichier${mergeState.conflicts.length > 1 ? "s" : ""} en conflit.`
                : `${opName} en cours : tous les conflits sont résolus.`}
            </span>
            {mergeState.conflicts.length > 0 ? (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setConflictsOpen(true)}>
                Résoudre les conflits…
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => mergeAction("continue")}>
                Finaliser
              </button>
            )}
            <button className="btn btn-sm btn-stop" disabled={busy} onClick={() => mergeAction("abort")}>
              Annuler
            </button>
            {conflictMsg && !conflictsOpen && <pre className="gc-output gc-output-err gc-merge-msg">{conflictMsg}</pre>}
          </div>
        )}

        {loading ? (
          <div className="loading-block">
            <span className="spinner spinner-lg" />
            Lecture de l'état git…
          </div>
        ) : staged.length + unstaged.length === 0 ? (
          <div className="empty">Aucune modification. L'arbre de travail est propre.</div>
        ) : (
          <>
          <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
            <DropZone id="staged">
              {({ setNodeRef, isOver }) => (
                <section
                  ref={setNodeRef}
                  className={"detail-section gc-section" + (isOver ? " gc-drop" : "")}
                >
                  <h2>
                    Dans l'index <span className="muted">({staged.length})</span>
                  </h2>
                  {staged.length === 0 ? (
                    <small className="muted">
                      Aucun fichier suivi. Cochez ou glissez ici des fichiers pour les inclure au commit.
                    </small>
                  ) : (
                    <div className="gc-list">{staged.map(renderRow)}</div>
                  )}
                </section>
              )}
            </DropZone>

            {/* Une section par changelist : glisser un fichier d'une liste à
                l'autre le range, vers « Dans l'index » l'ajoute au commit. */}
            {lists.map((l) => {
              const files = unstaged.filter((c) => listIdOf(changelists, c.path) === l.id);
              const editing = editingList?.id === l.id;
              return (
                <DropZone id={"cl:" + l.id} key={l.id}>
                  {({ setNodeRef, isOver }) => (
                    <section
                      ref={setNodeRef}
                      className={
                        "detail-section gc-section" +
                        (isOver ? " gc-drop" : "") +
                        (l.excluded ? " gc-cl-excluded" : "") +
                        (l.collapsed ? " gc-cl-collapsed" : "")
                      }
                    >
                      <div className="gc-cl-head">
                        <button
                          className="gc-cl-toggle"
                          onClick={() => toggleCollapsed(l.id)}
                          title={l.collapsed ? "Déplier la liste" : "Replier la liste"}
                          aria-expanded={!l.collapsed}
                        >
                          <span className={"gc-caret" + (l.collapsed ? "" : " open")}>▶</span>
                        </button>
                        {editing ? (
                          <input
                            className="gc-cl-name-input"
                            autoFocus
                            value={editingList?.name ?? ""}
                            onChange={(e) => setEditingList({ id: l.id, name: e.target.value })}
                            onBlur={() => {
                              renameList(l.id, editingList?.name ?? "");
                              setEditingList(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") {
                                e.stopPropagation();
                                setEditingList(null);
                              }
                            }}
                          />
                        ) : (
                          <h2
                            onClick={() => toggleCollapsed(l.id)}
                            onDoubleClick={() => setEditingList({ id: l.id, name: l.name })}
                            title="Clic : replier / déplier — double-clic : renommer"
                          >
                            {l.excluded && <span className="gc-cl-ex-ico">⊘ </span>}
                            {l.name} <span className="muted">({files.length})</span>
                          </h2>
                        )}
                        <span className="gc-cl-actions">
                          <label
                            className="chk-inline gc-cl-ex"
                            title="Liste à ne jamais committer : hors du compteur de la carte et de « Tout ajouter à l'index »"
                          >
                            <input type="checkbox" checked={!!l.excluded} onChange={() => toggleExcluded(l.id)} />
                            Ne jamais committer
                          </label>
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy || files.length === 0}
                            onClick={() => setStaged(files.map((c) => c.path), true)}
                            title="Ajouter les fichiers de cette liste à l'index"
                          >
                            ＋ Index
                          </button>
                          <button
                            className="btn btn-ghost btn-sm gc-rollback-btn"
                            disabled={busy || files.length === 0}
                            onClick={() => setRollbackAsk({ name: l.name, files })}
                            title="Rollback : annuler les modifications des fichiers de cette liste (confirmation demandée)"
                          >
                            ↶ Rollback
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setEditingList({ id: l.id, name: l.name })}
                            title="Renommer"
                          >
                            ✎
                          </button>
                          {l.id !== DEFAULT_LIST_ID && (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => removeList(l.id)}
                              title="Supprimer la liste (ses fichiers retournent dans la liste par défaut)"
                            >
                              ✕
                            </button>
                          )}
                        </span>
                      </div>
                      {/* Repliée : seul l'en-tête reste, toujours cible de dépôt. */}
                      {l.collapsed ? null : files.length === 0 ? (
                        <small className="muted">
                          {l.excluded
                            ? "Glissez ici les fichiers à ne jamais committer (config locale…)."
                            : "Aucun fichier. Glissez des fichiers ici pour les ranger dans cette liste."}
                        </small>
                      ) : (
                        <div className="gc-list">{files.map(renderRow)}</div>
                      )}
                    </section>
                  )}
                </DropZone>
              );
            })}
          </DndContext>
          </>
        )}

        <section className="detail-section gc-commit">
          <h2>Valider</h2>
          <textarea
            className="gc-message"
            placeholder="Message de commit…"
            value={message}
            rows={3}
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+Entrée : commit ; Ctrl+Alt+Entrée : commit & push.
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void commit(e.altKey);
            }}
          />
          <div className="gc-actions">
            {/* Bouton scindé : Commit + flèche qui déroule « Commit & Push ». */}
            <div className="split-btn" ref={commitMenuRef}>
              <button
                className="btn btn-primary split-main"
                onClick={() => void commit(false)}
                disabled={busy || staged.length === 0 || !message.trim()}
                title={
                  staged.length === 0
                    ? "Ajoutez au moins un fichier à l'index"
                    : !message.trim()
                      ? "Saisissez un message"
                      : "git commit (Ctrl+Entrée)"
                }
              >
                Commit
              </button>
              <button
                className="btn btn-primary split-caret"
                onClick={() => setCommitMenu((o) => !o)}
                // Même état que « Commit » : son seul choix (Commit & Push) a les mêmes prérequis.
                disabled={busy || staged.length === 0 || !message.trim()}
                title="Autres actions de commit"
                aria-expanded={commitMenu}
              >
                ▾
              </button>
              {commitMenu && (
                <div className="gc-menu split-menu">
                  <button
                    className="menu-item"
                    disabled={staged.length === 0 || !message.trim() || !!mergeState?.operation}
                    onClick={() => {
                      setCommitMenu(false);
                      void commit(true);
                    }}
                    title="git commit puis git push (Ctrl+Alt+Entrée)"
                  >
                    Commit &amp; Push
                  </button>
                </div>
              )}
            </div>
            <button
              className="btn"
              onClick={() => setUpdateAsk("pull")}
              disabled={busy || !!mergeState?.operation}
              title="git pull : intégrer une branche distante (merge ou rebase)"
            >
              Pull
            </button>
            <button className="btn" onClick={push} disabled={busy || !!mergeState?.operation} title="git push">
              Push
            </button>
            {busy && <span className="spinner spinner-xs" />}
          </div>
          {output && (
            <pre className={"gc-output" + (output.ok ? "" : " gc-output-err")}>{output.text}</pre>
          )}
        </section>
        </>
        )}
      </div>
    </div>
  );
}
