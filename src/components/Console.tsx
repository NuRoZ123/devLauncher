import { memo, useEffect, useRef, useState } from "react";
import { parseAnsi } from "../ansi";
import type { LogLine } from "../types";

/** Nombre max de lignes rendues dans le DOM (le tampon complet reste en mémoire). */
const RENDER_MAX = 1500;

interface Tab {
  id: string;
  name: string;
  running: boolean;
}

interface Props {
  tabs: Tab[];
  active: string | null;
  setActive: (id: string) => void;
  lines: LogLine[];
  onClear: () => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onRunCommand: (target: string, command: string) => void;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour12: false });
}

// Mémoïsée : une ligne déjà affichée n'est ni re-parsée (ANSI) ni re-rendue
// lors des flushs suivants — seul l'ajout de nouvelles lignes coûte.
const LogRow = memo(function LogRow({ l }: { l: LogLine }) {
  return (
    <div className={"log-line log-" + l.stream}>
      <span className="log-time">{fmtTime(l.ts)}</span>
      <span className="log-text">
        {parseAnsi(l.line).map((seg, k) => (
          <span
            key={k}
            style={{
              color: seg.fg,
              background: seg.bg,
              fontWeight: seg.bold ? 700 : undefined,
              opacity: seg.dim ? 0.7 : undefined,
              fontStyle: seg.italic ? "italic" : undefined,
              textDecoration: seg.underline ? "underline" : undefined,
            }}
          >
            {seg.text}
          </span>
        ))}
      </span>
    </div>
  );
});

export function Console({
  tabs,
  active,
  setActive,
  lines,
  onClear,
  onClose,
  onReorder,
  onRunCommand,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const dragId = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const [cmd, setCmd] = useState("");
  const histRef = useRef<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  function submitCmd() {
    const c = cmd.trim();
    if (!active || !c) return;
    // "clear"/"cls" sont interceptés côté client : ils vident la console
    // (même action que le bouton « Vider ») au lieu d'être exécutés.
    if (c.toLowerCase() === "clear" || c.toLowerCase() === "cls") {
      onClear();
    } else {
      onRunCommand(active, c);
    }
    histRef.current = [c, ...histRef.current.filter((x) => x !== c)].slice(0, 50);
    setHistIdx(-1);
    setCmd("");
  }

  function onCmdKey(e: React.KeyboardEvent<HTMLInputElement>) {
    const h = histRef.current;
    if (e.key === "Enter") {
      e.preventDefault();
      submitCmd();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!h.length) return;
      const ni = Math.min(histIdx + 1, h.length - 1);
      setHistIdx(ni);
      setCmd(h[ni]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const ni = histIdx - 1;
      if (ni < 0) {
        setHistIdx(-1);
        setCmd("");
      } else {
        setHistIdx(ni);
        setCmd(h[ni]);
      }
    }
  }

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el) return;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = stuck;
    setAtBottom(stuck);
  }

  function jumpToBottom() {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setAtBottom(true);
  }

  // Plafond de rendu : au-delà de RENDER_MAX lignes, seules les plus récentes
  // sont dans le DOM (5000 nœuds re-réconciliés à chaque flush, ça rame).
  const hidden = Math.max(0, lines.length - RENDER_MAX);
  const visible = hidden > 0 ? lines.slice(hidden) : lines;

  function handleDrop(targetId: string) {
    const from = dragId.current;
    dragId.current = null;
    setDragOver(null);
    if (!from || from === targetId) return;
    const ids = tabs.map((t) => t.id);
    const fi = ids.indexOf(from);
    const ti = ids.indexOf(targetId);
    if (fi === -1 || ti === -1) return;
    ids.splice(ti, 0, ids.splice(fi, 1)[0]);
    onReorder(ids);
  }

  return (
    <div className="console">
      <div className="console-tabs">
        {tabs.length === 0 && <div className="console-empty-tab">Console</div>}
        {tabs.map((t) => (
          <div
            key={t.id}
            draggable
            className={
              "console-tab" +
              (t.id === active ? " active" : "") +
              (t.id === dragOver ? " dragover" : "")
            }
            onClick={() => setActive(t.id)}
            onMouseDown={(e) => {
              // clic molette = fermer l'onglet
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
            onDragStart={() => (dragId.current = t.id)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragOver !== t.id) setDragOver(t.id);
            }}
            onDragLeave={() => setDragOver((d) => (d === t.id ? null : d))}
            onDrop={() => handleDrop(t.id)}
            onDragEnd={() => {
              dragId.current = null;
              setDragOver(null);
            }}
            title={t.id}
          >
            <span className={"dot " + (t.running ? "dot-run" : "dot-stop")} />
            <span className="console-tab-name">{t.name}</span>
            <button
              className="tab-close"
              title="Fermer l'onglet (réapparaît via « Console »)"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <div className="console-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClear} disabled={!active}>
            Vider
          </button>
        </div>
      </div>

      <div className="console-wrap">
        <div className="console-body" ref={bodyRef} onScroll={onScroll}>
          {!active && <div className="console-placeholder">Aucune sortie pour le moment.</div>}
          {active && hidden > 0 && (
            <div className="log-more">… {hidden} lignes précédentes non affichées</div>
          )}
          {active && visible.map((l, i) => <LogRow key={l.key ?? i} l={l} />)}
        </div>
        {active && !atBottom && (
          <button className="follow-btn" onClick={jumpToBottom} title="Revenir en bas et suivre les logs">
            ↓ Suivre
          </button>
        )}
      </div>

      <div className="console-cmd">
        <span className="console-cmd-prompt">$</span>
        <input
          className="console-cmd-input"
          spellCheck={false}
          autoComplete="off"
          disabled={!active}
          value={cmd}
          placeholder={
            active ? "Commande à exécuter dans le projet, puis Entrée…" : "Ouvre une console"
          }
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onCmdKey}
        />
      </div>
    </div>
  );
}
