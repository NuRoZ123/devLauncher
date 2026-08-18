import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { GitChange, GitInfo, Project } from "../types";
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
  bash: string;
  onBack: () => void;
  /** Rafraîchit l'état git du projet dans le parent (après commit/push). */
  onChanged: () => void;
  /** Ouvre le sélecteur de branche (même modale que partout ailleurs). */
  onCheckout: (p: Project) => void;
}

/** Libellé long d'un code de statut git, pour l'infobulle du badge. */
const STATUS_LABEL: Record<string, string> = {
  M: "Modifié",
  A: "Ajouté",
  D: "Supprimé",
  R: "Renommé",
  C: "Copié",
  "?": "Non suivi",
  U: "Conflit",
};

/** Découpe un diff git en lignes typées pour la coloration. */
type DiffLine = { text: string; kind: "add" | "del" | "hunk" | "meta" | "ctx" };
function parseDiff(diff: string): DiffLine[] {
  return diff.split("\n").map((text) => {
    let kind: DiffLine["kind"] = "ctx";
    if (text.startsWith("@@")) kind = "hunk";
    else if (text.startsWith("+++") || text.startsWith("---")) kind = "meta";
    else if (/^(diff |index |new file|deleted file|rename |similarity |old mode|new mode|Binary )/.test(text))
      kind = "meta";
    else if (text.startsWith("+")) kind = "add";
    else if (text.startsWith("-")) kind = "del";
    return { text, kind };
  });
}

/**
 * Page plein écran des modifications non commitées d'un projet : liste des
 * fichiers impactés, diff dépliable par fichier, sélection (stage/unstage) des
 * fichiers à valider, puis commit et push. Montée avec `key={project.id}`.
 */
export function GitChangesView({ project, git, bash, onBack, onChanged, onCheckout }: Props) {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // busy = opération bloquante (commit/push) ; syncing = git add/reset en tâche
  // de fond (n'empêche pas de continuer à basculer d'autres fichiers).
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Diffs chargés à la demande : chemin → texte du diff (ou "" si vide).
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  // Sortie de la dernière commande (commit/push) affichée en bas de page.
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  // Glisser-déposer (dnd-kit) entre les deux listes.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const reload = useCallback(async () => {
    try {
      const list = await api.gitChanges(bash, project.path);
      setChanges(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [bash, project.path]);

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

  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);

  const loadDiff = useCallback(
    async (c: GitChange) => {
      if (diffs[c.path] !== undefined) return;
      try {
        const d = await api.gitDiff(bash, project.path, c.path, c.untracked);
        setDiffs((m) => ({ ...m, [c.path]: d }));
      } catch (e) {
        setDiffs((m) => ({ ...m, [c.path]: `Erreur : ${e}` }));
      }
    },
    [bash, project.path, diffs],
  );

  const toggleExpand = useCallback(
    (c: GitChange) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(c.path)) next.delete(c.path);
        else {
          next.add(c.path);
          loadDiff(c);
        }
        return next;
      });
    },
    [loadDiff],
  );

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
      if (toStage.length) await api.gitStage(bash, project.path, toStage);
      if (toUnstage.length) await api.gitUnstage(bash, project.path, toUnstage);
    } catch (e) {
      setError(String(e));
      // Désynchronisation possible : on relit la vérité git.
      await reload();
    }
  }, [bash, project.path, reload]);

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
      // On n'agit que sur les fichiers dont l'état change réellement.
      const affected = files.filter((f) => {
        const c = changesRef.current.find((x) => x.path === f);
        return c && c.staged !== stage;
      });
      if (affected.length === 0) return;
      setChanges((prev) =>
        prev.map((c) => (affected.includes(c.path) ? { ...c, staged: stage } : c)),
      );
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

  // Dépose d'un fichier : vers « Dans l'index » (staged) le stage, vers
  // « Modifications » (unstaged) le unstage (no-op s'il y est déjà).
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      if (!e.over) return;
      const path = String(e.active.id);
      setStaged([path], e.over.id === "staged");
    },
    [setStaged],
  );

  const commit = useCallback(async () => {
    if (busy || staged.length === 0 || !message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Applique d'abord les bascules en attente pour que l'index soit à jour.
      await flush();
      const out = await api.gitCommit(bash, project.path, message.trim());
      setOutput({ ok: true, text: out || "Commit effectué." });
      setMessage("");
      await reload();
      onChanged();
    } catch (e) {
      setOutput({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }, [bash, project.path, busy, staged.length, message, flush, reload, onChanged]);

  const push = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.gitPush(bash, project.path);
      setOutput({ ok: true, text: out || "Push effectué." });
      onChanged();
    } catch (e) {
      setOutput({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }, [bash, project.path, busy, onChanged]);

  // Actualiser : applique les bascules en attente avant de relire l'état git
  // (sinon un rechargement écraserait l'affichage optimiste non encore synchro).
  const refresh = useCallback(async () => {
    await flush();
    await reload();
  }, [flush, reload]);

  const renderRow = (c: GitChange) => {
    const open = expanded.has(c.path);
    const diff = diffs[c.path];
    return (
      <DraggableFile id={c.path} disabled={busy} key={(c.staged ? "s:" : "u:") + c.path}>
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
                {c.status}
              </span>
              <button className="gc-path" onClick={() => toggleExpand(c)} title="Afficher / masquer le diff">
                <span className={"gc-caret" + (open ? " open" : "")}>▶</span>
                {c.orig && <span className="gc-orig">{c.orig} → </span>}
                <span className="gc-name">{c.path}</span>
              </button>
            </div>
            {open && (
              <pre className="gc-diff">
                {diff === undefined ? (
                  <span className="muted">Chargement du diff…</span>
                ) : diff.trim() === "" ? (
                  <span className="muted">Aucun diff textuel (fichier binaire ou vide).</span>
                ) : (
                  parseDiff(diff).map((l, i) => (
                    <span key={i} className={"gc-dl gc-dl-" + l.kind}>
                      {l.text || " "}
                      {"\n"}
                    </span>
                  ))
                )}
              </pre>
            )}
          </div>
        )}
      </DraggableFile>
    );
  };

  return (
    <div className="settings">
      <div className="settings-inner detail gc">
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
              onClick={() => onCheckout(project)}
              disabled={busy}
            >
              <span className="chip-ico">⌥</span>
              <span className="chip-branch-txt">{git?.branch ?? "—"}</span>
            </button>
          </h1>
          <div className="muted detail-path" title={project.path}>
            {project.path}
          </div>
        </div>

        <div className="gc-toolbar">
          <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={busy || loading}>
            ↻ Actualiser
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setStaged(unstaged.map((c) => c.path), true)}
            disabled={busy || unstaged.length === 0}
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
          {syncing && (
            <span className="gc-sync muted" title="Synchronisation avec git…">
              <span className="spinner spinner-xs" /> sync…
            </span>
          )}
          <span className="gc-count muted">
            {changes.length} fichier{changes.length > 1 ? "s" : ""} — {staged.length} dans l'index
          </span>
        </div>

        {error && <div className="banner-error">{error}</div>}

        {loading ? (
          <div className="loading-block">
            <span className="spinner spinner-lg" />
            Lecture de l'état git…
          </div>
        ) : changes.length === 0 ? (
          <div className="empty">Aucune modification. L'arbre de travail est propre.</div>
        ) : (
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

            <DropZone id="unstaged">
              {({ setNodeRef, isOver }) => (
                <section
                  ref={setNodeRef}
                  className={"detail-section gc-section" + (isOver ? " gc-drop" : "")}
                >
                  <h2>
                    Modifications <span className="muted">({unstaged.length})</span>
                  </h2>
                  {unstaged.length === 0 ? (
                    <small className="muted">Tout est dans l'index. Glissez ici pour retirer.</small>
                  ) : (
                    <div className="gc-list">{unstaged.map(renderRow)}</div>
                  )}
                </section>
              )}
            </DropZone>
          </DndContext>
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
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") commit();
            }}
          />
          <div className="gc-actions">
            <button
              className="btn btn-primary"
              onClick={commit}
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
            <button className="btn" onClick={push} disabled={busy} title="git push">
              Push
            </button>
            {busy && <span className="spinner spinner-xs" />}
          </div>
          {output && (
            <pre className={"gc-output" + (output.ok ? "" : " gc-output-err")}>{output.text}</pre>
          )}
        </section>
      </div>
    </div>
  );
}
