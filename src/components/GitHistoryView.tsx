import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { FileVersions, GitChange, LogCommit } from "../types";
import { useSplit } from "../useSplit";
import { DiffView } from "./DiffView";

const PAGE = 100;

const STATUS_LABEL: Record<string, string> = {
  M: "Modifié",
  A: "Ajouté",
  D: "Supprimé",
  R: "Renommé",
  C: "Copié",
  T: "Type modifié",
};

interface Props {
  gitExe: string;
  path: string;
  /** Branche courante (sélection par défaut). */
  branch?: string;
}

/**
 * Historique git façon onglet « Log » de JetBrains : commits d'une branche (ou
 * de toutes), filtre sur les messages, historique d'un fichier (suit les
 * renommages) et détail d'un commit : fichiers modifiés et diff de chacun.
 */
export function GitHistoryView({ gitExe, path, branch }: Props) {
  const [refs, setRefs] = useState<string[]>([]);
  const [rev, setRev] = useState(branch && branch !== "—" ? branch : "HEAD");
  const [file, setFile] = useState<string | null>(null);
  const [commits, setCommits] = useState<LogCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Recherche envoyée à git (tout l'historique), après une courte pause de frappe.
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(filter.trim()), 350);
    return () => clearTimeout(t);
  }, [filter]);
  const [selected, setSelected] = useState<LogCommit | null>(null);
  // Volets redimensionnables : liste des commits | détail.
  const split = useSplit("history.list", 38, 18, 75);

  // ----- Recherche de fichier (fichiers suivis du dépôt) -----
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [fileOpen, setFileOpen] = useState(false);
  const fileBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.gitRefs(gitExe, path).then(setRefs).catch(() => setRefs([]));
  }, [gitExe, path]);

  // Liste chargée au premier usage de la recherche (peut être longue).
  const ensureFiles = () => {
    if (allFiles === null)
      api
        .gitLsFiles(gitExe, path)
        .then(setAllFiles)
        .catch(() => setAllFiles([]));
  };
  const fileMatches = useMemo(() => {
    if (!allFiles) return [];
    const q = fileQuery.trim().toLowerCase();
    if (!q) return allFiles.slice(0, 50);
    // Les fichiers dont le NOM contient la recherche passent en tête.
    const hits = allFiles.filter((f) => f.toLowerCase().includes(q));
    const byName = (f: string) => (f.toLowerCase().split("/").pop()!.includes(q) ? 0 : 1);
    return hits.sort((a, b) => byName(a) - byName(b) || a.length - b.length).slice(0, 50);
  }, [allFiles, fileQuery]);
  useEffect(() => {
    if (!fileOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!fileBox.current?.contains(e.target as Node)) setFileOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [fileOpen]);

  // ----- Chargement des commits (par pages) -----
  const loadSeq = useRef(0);
  const load = useCallback(
    async (skip: number) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        const page = await api.gitLog(gitExe, path, rev, file, skip, PAGE, search || null);
        if (seq !== loadSeq.current) return; // une sélection plus récente l'emporte
        setCommits((cur) => (skip === 0 ? page : [...cur, ...page]));
        // Une recherche renvoie tous ses résultats d'un coup (pas de page suivante).
        setHasMore(!search && page.length === PAGE);
        setError(null);
      } catch (e) {
        if (seq === loadSeq.current) setError(String(e));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [gitExe, path, rev, file, search],
  );
  useEffect(() => {
    setSelected(null);
    void load(0);
  }, [load]);

  const shown = commits;

  return (
    <div className="gh">
      <div className="gh-bar">
        <select className="gh-rev" value={rev} onChange={(e) => setRev(e.target.value)} title="Branche affichée">
          <option value="HEAD">HEAD (branche courante)</option>
          <option value="--all">Toutes les branches</option>
          {refs.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <div className="gh-file" ref={fileBox}>
          {file ? (
            <span className="gh-file-chip" title={file}>
              📄 {file}
              <button className="tab-close" onClick={() => setFile(null)} title="Revenir à l'historique de la branche">
                ×
              </button>
            </span>
          ) : (
            <input
              className="gh-input"
              placeholder="Historique d'un fichier…"
              value={fileQuery}
              onFocus={() => {
                ensureFiles();
                setFileOpen(true);
              }}
              onChange={(e) => {
                setFileQuery(e.target.value);
                setFileOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && fileMatches[0]) {
                  setFile(fileMatches[0]);
                  setFileOpen(false);
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setFileOpen(false);
                }
              }}
            />
          )}
          {fileOpen && !file && (
            <div className="gh-file-list">
              {allFiles === null ? (
                <div className="muted gh-file-empty">
                  <span className="spinner spinner-xs" /> Chargement des fichiers…
                </div>
              ) : fileMatches.length === 0 ? (
                <div className="muted gh-file-empty">Aucun fichier suivi ne correspond.</div>
              ) : (
                fileMatches.map((f) => {
                  const cut = f.lastIndexOf("/") + 1;
                  return (
                    <button
                      key={f}
                      className="gh-file-item"
                      onClick={() => {
                        setFile(f);
                        setFileOpen(false);
                      }}
                    >
                      <span>{f.slice(cut)}</span>
                      <span className="muted">{f.slice(0, cut)}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        <input
          className="gh-input gh-filter"
          placeholder="Rechercher dans tout l'historique : message, auteur, hash…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn btn-ghost btn-sm" onClick={() => void load(0)} disabled={loading} title="Actualiser">
          ↻
        </button>
      </div>

      {error && <div className="banner-error">{error}</div>}

      <div className="gh-body" ref={split.ref} style={{ gridTemplateColumns: `${split.pct}% 6px minmax(0, 1fr)` }}>
        <div
          className="gh-list"
          onScroll={(e) => {
            // Arrivé près du bas : page suivante, sans bouton.
            const el = e.currentTarget;
            if (hasMore && !loading && el.scrollTop + el.clientHeight >= el.scrollHeight - 150)
              void load(commits.length);
          }}
        >
          {shown.map((c) => (
            <button
              key={c.hash}
              className={"gh-row" + (selected?.hash === c.hash ? " sel" : "")}
              onClick={() => setSelected(c)}
              title={`${c.hash}\n${c.author} — ${c.date}`}
            >
              <span className="gh-row-subj">
                {c.parents.length > 1 && <span className="gh-merge" title="Commit de fusion">⑂ </span>}
                {c.subject}
                {c.refs.map((r) => (
                  <span key={r} className={"gh-ref" + (r.startsWith("tag: ") ? " gh-ref-tag" : r.includes("/") ? " gh-ref-remote" : "")}>
                    {r.replace(/^tag: /, "🏷 ")}
                  </span>
                ))}
              </span>
              <span className="gh-row-meta">
                <span className="gh-row-author">{c.author}</span>
                <span className="muted" title={c.date}>
                  {c.rel}
                </span>
                <code className="gh-hash">{c.short}</code>
              </span>
            </button>
          ))}
          {loading && (
            <div className="muted gh-more">
              <span className="spinner spinner-xs" /> Chargement…
            </div>
          )}
          {!loading && shown.length === 0 && (
            <div className="muted gh-more">{search ? `Aucun commit ne correspond à « ${search} ».` : "Aucun commit."}</div>
          )}
          {!loading && search && shown.length > 0 && (
            <div className="muted gh-more">
              {shown.length} résultat{shown.length > 1 ? "s" : ""} dans tout l'historique
            </div>
          )}
        </div>

        <div className="splitter" onMouseDown={split.onMouseDown} title="Glisser pour redimensionner" />

        <div className="gh-detail">
          {selected ? (
            <CommitDetail key={selected.hash} gitExe={gitExe} path={path} commit={selected} focusFile={file} />
          ) : (
            <div className="muted gh-placeholder">Sélectionnez un commit pour voir ses fichiers et leurs modifications.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Détail d'un commit : en-tête, fichiers modifiés, comparaison 2 volets du fichier choisi. */
function CommitDetail({
  gitExe,
  path,
  commit,
  focusFile,
}: {
  gitExe: string;
  path: string;
  commit: LogCommit;
  /** Fichier recherché : ouvert d'office s'il fait partie du commit. */
  focusFile: string | null;
}) {
  const parent = commit.parents[0] ?? "";
  const [files, setFiles] = useState<GitChange[] | null>(null);
  const [open, setOpen] = useState<GitChange | null>(null);
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const [verError, setVerError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Volets redimensionnables : liste des fichiers / comparaison.
  const split = useSplit("history.files", 28, 8, 85, "y");

  useEffect(() => {
    let alive = true;
    api
      .gitCommitChanges(gitExe, path, commit.hash, parent)
      .then((fs) => {
        if (!alive) return;
        setFiles(fs);
        // Historique d'un fichier : ce fichier (ou son ancien nom) d'abord.
        const focus = focusFile ? fs.find((f) => f.path === focusFile || f.orig === focusFile) : undefined;
        setOpen(focus ?? fs[0] ?? null);
      })
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [gitExe, path, commit.hash, parent, focusFile]);

  useEffect(() => {
    setVersions(null);
    setVerError(null);
    if (!open) return;
    let alive = true;
    api
      .gitCommitFileVersions(gitExe, path, commit.hash, parent, open.path, open.orig)
      .then((v) => alive && setVersions(v))
      .catch((e) => alive && setVerError(String(e)));
    return () => {
      alive = false;
    };
  }, [gitExe, path, commit.hash, parent, open]);

  const parentShort = parent ? parent.slice(0, 7) : "";

  return (
    <div className="gh-cd" ref={split.ref}>
      <div className="gh-cd-top" style={{ height: `${split.pct}%` }}>
        <div className="gh-cd-head">
          <div className="gh-cd-subj">{commit.subject}</div>
          <div className="muted gh-cd-meta">
            {commit.author} · {commit.date} ({commit.rel}) ·{" "}
            <button
              className="gh-copy"
              title="Copier le hash complet"
              onClick={() => {
                void navigator.clipboard.writeText(commit.hash).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              <code>{commit.short}</code> {copied ? "✓ copié" : "⧉"}
            </button>
            {commit.parents.length > 1 && <span> · fusion (comparée au 1er parent)</span>}
          </div>
        </div>
        <div className="gh-cd-files">
          {files === null ? (
            <div className="muted">
              <span className="spinner spinner-xs" /> Lecture du commit…
            </div>
          ) : files.length === 0 ? (
            <div className="muted">Aucun fichier modifié.</div>
          ) : (
            files.map((f) => (
              <button
                key={f.path}
                className={"gh-cd-file" + (open?.path === f.path ? " sel" : "")}
                onClick={() => setOpen(f)}
                title={STATUS_LABEL[f.status] ?? f.status}
              >
                <span className={"gc-status gc-status-" + f.status}>{f.status}</span>
                {f.orig && <span className="muted">{f.orig} → </span>}
                <span>{f.path}</span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="splitter splitter-y" onMouseDown={split.onMouseDown} title="Glisser pour redimensionner" />

      <div className="gh-cd-diff">
        {!open ? (
          <div className="muted gh-placeholder">Sélectionnez un fichier.</div>
        ) : verError ? (
          <div className="banner-error">{verError}</div>
        ) : !versions ? (
          <div className="muted gh-placeholder">
            <span className="spinner spinner-xs" /> Chargement des versions…
          </div>
        ) : (
          <DiffView
            key={commit.hash + ":" + open.path}
            file={open.path}
            orig={open.orig}
            versions={versions}
            busy={false}
            embedded
            leftLabel={parentShort ? `Avant · ${parentShort}` : "Avant (aucun parent)"}
            rightLabel={`Après · ${commit.short}`}
          />
        )}
      </div>
    </div>
  );
}
