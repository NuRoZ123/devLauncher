import { useEffect, useState } from "react";
import type { ConflictFile, MergeState, RemoteBranches } from "../types";

/** Libellé de l'opération en cours, pour les titres. */
export const OP_LABEL: Record<string, string> = {
  merge: "Fusion",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

/** Ferme sur Échap sans laisser remonter l'événement (la page git resterait sinon). */
function useEscape(onEscape: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onEscape();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onEscape]);
}

/** Statut d'un côté d'un fichier en conflit relativement à l'ancêtre commun. */
function sideStatus(present: boolean, base: boolean) {
  if (!present) return <span className="cf-st cf-st-del">Supprimé</span>;
  if (!base) return <span className="cf-st cf-st-add">Ajouté</span>;
  return <span className="cf-st cf-st-mod">Modifié</span>;
}

interface ConflictsProps {
  state: MergeState;
  busy: boolean;
  /** Message d'erreur/info à afficher dans la boîte (échec d'un --continue…). */
  message: string | null;
  /** Information non bloquante (passage au commit suivant d'un rebase…). */
  info: string | null;
  onAccept: (files: string[], side: "ours" | "theirs") => void;
  onMerge: (file: string) => void;
  onAbort: () => void;
  onContinue: () => void;
  onSkip: () => void;
  onClose: () => void;
}

/**
 * Boîte « Conflits » façon JetBrains : liste des fichiers en conflit avec l'état
 * de chaque côté, et pour la sélection : accepter la version locale, accepter la
 * version entrante, ou ouvrir la fusion 3 volets.
 */
export function ConflictsModal({
  state,
  busy,
  message,
  info,
  onAccept,
  onMerge,
  onAbort,
  onContinue,
  onSkip,
  onClose,
}: ConflictsProps) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(state.conflicts[0] ? [state.conflicts[0].path] : []));
  useEscape(onClose);

  // Garde une sélection valide quand la liste se réduit.
  useEffect(() => {
    setSel((prev) => {
      const next = new Set([...prev].filter((p) => state.conflicts.some((c) => c.path === p)));
      if (next.size === 0 && state.conflicts[0]) next.add(state.conflicts[0].path);
      return next;
    });
  }, [state.conflicts]);

  // En rebase, « ours » (stage 2) est la branche amont et « theirs » votre commit.
  const swap = state.operation === "rebase";
  const mine = (c: ConflictFile) => (swap ? c.theirs : c.ours);
  const incoming = (c: ConflictFile) => (swap ? c.ours : c.theirs);
  const mineLabel = swap ? state.theirs_label : state.ours_label;
  const incomingLabel = swap ? state.ours_label : state.theirs_label;
  const files = [...sel];
  const opName = OP_LABEL[state.operation] ?? "Opération";

  const toggle = (p: string, multi: boolean) =>
    setSel((prev) => {
      if (!multi) return new Set([p]);
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal cf-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            Conflits — {opName.toLowerCase()} en cours
            {state.total > 0 && (
              <span className="cf-step" title="Le rebase rejoue vos commits un par un ; chacun peut avoir ses conflits">
                commit {state.step}/{state.total}
              </span>
            )}
          </h3>
          <button className="tab-close" onClick={onClose} title="Fermer (résoudre plus tard)">
            ×
          </button>
        </div>
        <div className="modal-sub muted cf-sub">
          {state.conflicts.length
            ? `${state.conflicts.length} fichier${state.conflicts.length > 1 ? "s" : ""} en conflit.`
            : "Tous les conflits sont résolus."}{" "}
          Vous : <b>{mineLabel || "local"}</b> · Entrant : <b>{incomingLabel || "distant"}</b>
        </div>

        {state.commit && (
          <div className="cf-commit" title="Commit en cours d'application">
            <span className="muted">Commit en cours :</span> <code>{state.commit}</code>
          </div>
        )}
        {info && <div className="cf-info">{info}</div>}

        <div className="cf-body">
          <div className="cf-table">
            <div className="cf-row cf-row-head">
              <span>Fichier</span>
              <span>Vous</span>
              <span>Entrant</span>
            </div>
            <div className="cf-rows">
              {state.conflicts.map((c) => (
                <div
                  key={c.path}
                  className={"cf-row" + (sel.has(c.path) ? " sel" : "")}
                  onClick={(e) => toggle(c.path, e.ctrlKey || e.metaKey)}
                  onDoubleClick={() => !busy && onMerge(c.path)}
                  title="Double-clic : fusionner"
                >
                  <span className="cf-name">
                    <span className="cf-dir">{c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/") + 1) : ""}</span>
                    {c.path.slice(c.path.lastIndexOf("/") + 1)}
                  </span>
                  <span>{sideStatus(mine(c), c.base)}</span>
                  <span>{sideStatus(incoming(c), c.base)}</span>
                </div>
              ))}
              {state.conflicts.length === 0 && <div className="muted cf-empty">Aucun fichier en conflit.</div>}
            </div>
          </div>
          <div className="cf-side">
            <button
              className="btn btn-sm"
              disabled={busy || files.length === 0}
              onClick={() => onAccept(files, swap ? "theirs" : "ours")}
              title="Garder votre version pour les fichiers sélectionnés"
            >
              Accepter la vôtre
            </button>
            <button
              className="btn btn-sm"
              disabled={busy || files.length === 0}
              onClick={() => onAccept(files, swap ? "ours" : "theirs")}
              title="Prendre la version entrante pour les fichiers sélectionnés"
            >
              Accepter l'entrante
            </button>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || files.length !== 1}
              onClick={() => onMerge(files[0])}
              title="Ouvrir la fusion 3 volets"
            >
              Fusionner…
            </button>
          </div>
        </div>

        {message && <pre className="gc-output gc-output-err cf-msg">{message}</pre>}

        <div className="modal-footer">
          <button className="btn btn-stop" disabled={busy} onClick={onAbort} title={`git ${state.operation} --abort`}>
            Annuler {state.operation === "merge" ? "la fusion" : `le ${state.operation}`}
          </button>
          {state.operation === "rebase" && (
            <button className="btn btn-ghost" disabled={busy} onClick={onSkip} title="git rebase --skip : ignore le commit en cours">
              Ignorer ce commit
            </button>
          )}
          <span className="mv-footer-fill" />
          {busy && <span className="spinner spinner-xs" />}
          <button className="btn btn-ghost" onClick={onClose}>
            Fermer
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || state.conflicts.length > 0}
            onClick={onContinue}
            title={state.conflicts.length ? "Résolvez d'abord tous les conflits" : `git ${state.operation} --continue`}
          >
            Finaliser
          </button>
        </div>
      </div>
    </div>
  );
}

/** Branche distante à tirer (undefined = upstream de la branche courante). */
export type PullTarget = { remote: string; name: string } | undefined;

interface UpdateProps {
  /** true : boîte affichée après un push rejeté ; false : pull demandé. */
  rejected: boolean;
  /** Branche courante (celle qui reçoit les commits). */
  current: string;
  /** Charge les branches distantes (après un git fetch si `fetch`). */
  loadBranches: (fetch: boolean) => Promise<RemoteBranches>;
  onChoose: (rebase: boolean, target: PullTarget) => void;
  onCancel: () => void;
}

/**
 * Boîte « Pull » façon JetBrains : choix de la branche distante à intégrer dans
 * la branche courante (par défaut son upstream) et de la stratégie (merge ou
 * rebase). Affichée aussi quand le push est rejeté (branche distante en avance),
 * auquel cas la cible est forcément l'upstream.
 */
export function UpdateModal({ rejected, current, loadBranches, onChoose, onCancel }: UpdateProps) {
  useEscape(onCancel);
  const [data, setData] = useState<RemoteBranches | null>(null);
  const [fetching, setFetching] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (rejected) return;
    let alive = true;
    const pick = (d: RemoteBranches) =>
      setSel(
        (s) =>
          s ??
          (d.upstream ||
            (d.branches.some((b) => `${b.remote}/${b.name}` === `origin/${current}`) ? `origin/${current}` : null)),
      );
    // Liste locale immédiate, puis rafraîchie après un fetch (réseau).
    loadBranches(false)
      .then((d) => {
        if (!alive) return;
        setData(d);
        pick(d);
        setFetching(true);
        return loadBranches(true).then((d2) => {
          if (!alive) return;
          setData(d2);
          pick(d2);
        });
      })
      .catch(() => {})
      .finally(() => alive && setFetching(false));
    return () => {
      alive = false;
    };
  }, [rejected, loadBranches, current]);

  const upstream = data?.upstream ?? "";
  const q = filter.trim().toLowerCase();
  const list = (data?.branches ?? []).filter((b) => !q || `${b.remote}/${b.name}`.toLowerCase().includes(q));
  const target = (): PullTarget => {
    if (rejected || !sel || sel === upstream) return undefined;
    const b = data?.branches.find((x) => `${x.remote}/${x.name}` === sel);
    return b ? { remote: b.remote, name: b.name } : undefined;
  };
  const canPull = rejected || !!sel || !!upstream;

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className={"modal" + (rejected ? "" : " modal-wide")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{rejected ? "Push rejeté" : "Pull"}</h3>
          <button className="tab-close" onClick={onCancel}>
            ×
          </button>
        </div>
        {rejected ? (
          <p className="cf-p">
            La branche distante contient des commits que vous n'avez pas. Mettez à jour votre branche avant de pousser :
            les éventuels conflits seront résolus ici, puis le push sera relancé.
          </p>
        ) : (
          <>
            <div className="modal-sub">
              <span className="muted">Intégrer dans</span>
              <span className="chip chip-branch" style={{ cursor: "default" }}>
                <span className="chip-ico">⌥</span>
                <span className="chip-branch-txt">{current}</span>
              </span>
              <span className="muted">la branche distante :</span>
              {fetching && (
                <span className="muted cf-fetch">
                  <span className="spinner spinner-xs" /> fetch…
                </span>
              )}
            </div>
            <input
              className="modal-search"
              placeholder="Filtrer les branches distantes…"
              value={filter}
              autoFocus
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="branch-list">
              {!data && (
                <div className="branch-loading">
                  <span className="spinner" /> Chargement des branches…
                </div>
              )}
              {data && list.length === 0 && <div className="muted branch-empty">Aucune branche distante.</div>}
              {list.map((b) => {
                const full = `${b.remote}/${b.name}`;
                return (
                  <button
                    key={full}
                    className={"branch-item" + (sel === full ? " sel" : "")}
                    onClick={() => setSel(full)}
                    onDoubleClick={() => {
                      setSel(full);
                      onChoose(false, full === upstream ? undefined : { remote: b.remote, name: b.name });
                    }}
                  >
                    <span className="branch-ico">⎇</span>
                    <span className="muted">{b.remote}/</span>
                    {b.name}
                    {full === upstream && <span className="branch-tag">suivie</span>}
                  </button>
                );
              })}
            </div>
            {data?.fetch_error && <pre className="gc-output gc-output-err cf-msg">{data.fetch_error}</pre>}
            <p className="cf-p cf-hint">
              Vos modifications non commitées sont mises de côté puis réappliquées. En cas de conflit, la résolution
              s'ouvre ici.
            </p>
          </>
        )}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>
            Annuler
          </button>
          <button
            className="btn"
            disabled={!canPull}
            onClick={() => onChoose(true, target())}
            title={`git pull --rebase ${sel ?? ""} : rejoue vos commits au-dessus de cette branche`}
          >
            Rebase
          </button>
          <button
            className="btn btn-primary"
            disabled={!canPull}
            onClick={() => onChoose(false, target())}
            title={`git pull --no-rebase ${sel ?? ""} : crée un commit de fusion`}
          >
            Merge
          </button>
        </div>
      </div>
    </div>
  );
}
