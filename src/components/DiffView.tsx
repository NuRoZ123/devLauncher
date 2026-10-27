import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { diffLines, inlineDiff, toLines, type ChangeKind, type InlineRange } from "../merge3";
import { langForFile } from "../highlight";
import type { FileVersions } from "../types";
import { flushSync } from "react-dom";
import { Code, LH, LineNumbers, PANE_BORDER, visualCol } from "./MergeView";
import { useSplit } from "../useSplit";
import { useWheelSync } from "../useWheelSync";
import { OverviewRuler, type RulerMark } from "./OverviewRuler";

/** Largeur de la gouttière de liaison entre les deux volets (px). */
const GW = 56;

interface Change {
  id: number;
  /** Lignes [début, fin) dans la version HEAD (gauche). */
  left: [number, number];
  /** Lignes [début, fin) dans la version de travail (droite). */
  right: [number, number];
  kind: ChangeKind;
}

const kindClass = (k: ChangeKind) => "mv-hl-" + k;

/** Transpose une ligne d'un volet vers l'autre via les plages des changements. */
function mapLine(changes: Change[], from: "left" | "right", to: "left" | "right", line: number) {
  let pf = 0;
  let pt = 0;
  for (const c of changes) {
    const [fs, fe] = c[from];
    const [ts, te] = c[to];
    if (line < fs) return pt + (line - pf);
    if (line < fe) return ts + ((line - fs) / Math.max(1, fe - fs)) * (te - ts);
    pf = fe;
    pt = te;
  }
  return pt + (line - pf);
}

/** Surlignages d'un volet : blocs de changement + portions différentes (mot à mot). */
function Highlights({
  changes,
  side,
  lines,
  inline,
}: {
  changes: Change[];
  side: "left" | "right";
  lines: string[];
  inline: Map<number, { left: InlineRange[]; right: InlineRange[] }>;
}) {
  return (
    <>
      {changes.map((c) => {
        const [s, e] = c[side];
        return (
          <div
            key={c.id}
            className={"mv-hl " + kindClass(c.kind) + (s === e ? " mv-hl-empty" : "")}
            style={{ top: s * LH, height: s === e ? 0 : (e - s) * LH }}
          />
        );
      })}
      {changes.map((c) =>
        (inline.get(c.id)?.[side] ?? []).map((r, i) => {
          const ln = c[side][0] + r.line;
          const src = lines[ln] ?? "";
          const a = visualCol(src, r.start);
          const b = visualCol(src, r.end);
          return (
            <div
              key={`w${c.id}-${i}`}
              className="mv-word"
              style={{ top: ln * LH, left: `calc(56px + ${a}ch)`, width: `${Math.max(1, b - a)}ch` }}
            />
          );
        }),
      )}
    </>
  );
}

interface Props {
  file: string;
  /** Ancien chemin (renommage), affiché dans l'en-tête. */
  orig: string | null;
  versions: FileVersions;
  busy: boolean;
  /** Position du fichier dans la liste des modifications (navigation). */
  index?: number;
  total?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onSave?: (content: string) => Promise<boolean>;
  onClose?: () => void;
  /** Intégrée dans un autre écran (historique) : lecture seule, sans pied de
   *  page ni gestion d'Échap. */
  embedded?: boolean;
  /** Lecture seule (ex. part indexée d'un fichier partiellement indexé). */
  readOnly?: boolean;
  /** Libellés des deux volets (défaut : HEAD / version de travail). */
  leftLabel?: string;
  rightLabel?: string;
}

/**
 * Comparaison 2 volets d'un fichier modifié, façon JetBrains : à gauche la
 * version committée (HEAD), à droite la version de travail, éditable. Chaque
 * changement est relié entre les volets et peut être annulé (»).
 */
export function DiffView({
  file,
  orig,
  versions,
  busy,
  index = 0,
  total = 0,
  onPrev,
  onNext,
  onSave,
  onClose,
  embedded = false,
  readOnly = false,
  leftLabel,
  rightLabel,
}: Props) {
  const lang = useMemo(() => langForFile(file), [file]);
  const left = useMemo(() => (versions.head === null ? [] : toLines(versions.head)), [versions.head]);
  const initial = useMemo(() => (versions.work ?? "").replace(/\r\n/g, "\n"), [versions.work]);
  const editable = !embedded && !readOnly && versions.work !== null && !versions.binary;
  // Largeur des volets : la bande de liaison centrale se glisse (mémorisé).
  const split = useSplit("diff.panes", 50, 15, 85);
  const cols = `calc(${split.pct}% - ${GW / 2}px) ${GW}px minmax(0, 1fr)`;

  const [text, setText] = useState(initial);
  const right = useMemo(() => (versions.work === null ? [] : text.split("\n")), [text, versions.work]);
  const dirty = text !== initial;

  // Changements recalculés à chaque saisie : la comparaison reste juste quoi
  // qu'on édite (le diff de Myers est rapide sur des fichiers de code).
  const changes = useMemo<Change[]>(
    () =>
      diffLines(left, right).map((h, id) => ({
        id,
        left: [h.aStart, h.aEnd],
        right: [h.bStart, h.bEnd],
        kind: h.aStart === h.aEnd ? "added" : h.bStart === h.bEnd ? "deleted" : "modified",
      })),
    [left, right],
  );
  const inline = useMemo(() => {
    const m = new Map<number, { left: InlineRange[]; right: InlineRange[] }>();
    for (const c of changes) {
      if (c.kind !== "modified") continue;
      const d = inlineDiff(left.slice(c.left[0], c.left[1]), right.slice(c.right[0], c.right[1]));
      if (d) m.set(c.id, { left: d.a, right: d.b });
    }
    return m;
  }, [changes, left, right]);

  // ----- Historique (Ctrl+Z / Ctrl+Y), saisies rapprochées regroupées -----
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const lastTyping = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const commitText = useCallback((next: string, typing: boolean) => {
    const now = Date.now();
    if (!typing || now - lastTyping.current > 700) undoStack.current.push(textRef.current);
    if (undoStack.current.length > 300) undoStack.current.shift();
    lastTyping.current = typing ? now : 0;
    redoStack.current = [];
    setText(next);
  }, []);
  const undo = () => {
    const prev = undoStack.current.pop();
    if (prev === undefined) return;
    redoStack.current.push(textRef.current);
    lastTyping.current = 0;
    setText(prev);
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (next === undefined) return;
    undoStack.current.push(textRef.current);
    lastTyping.current = 0;
    setText(next);
  };

  /** Annule un changement : la version HEAD reprend sa place à droite. */
  const revert = (c: Change) => {
    const lines = textRef.current.split("\n");
    lines.splice(c.right[0], c.right[1] - c.right[0], ...left.slice(c.left[0], c.left[1]));
    commitText(lines.join("\n"), false);
  };

  // ----- Défilement synchronisé (même principe que la fusion) -----
  const refL = useRef<HTMLDivElement>(null);
  const refR = useRef<HTMLDivElement>(null);
  const expected = useRef<Record<"l" | "r", number | null>>({ l: null, r: null });
  // Bordure de 1 px des volets intégrée au défilement (liaisons alignées), et
  // redessin synchrone des liaisons pendant le défilement (pas d'image de retard).
  const [scroll, setScroll] = useState({ l: -PANE_BORDER, r: -PANE_BORDER });
  const applyScroll = () =>
    flushSync(() =>
      setScroll({
        l: (refL.current?.scrollTop ?? 0) - PANE_BORDER,
        r: (refR.current?.scrollTop ?? 0) - PANE_BORDER,
      }),
    );
  const [viewH, setViewH] = useState(400);
  const changesRef = useRef(changes);
  changesRef.current = changes;

  const syncFrom = useCallback((who: "l" | "r") => {
    const el = (who === "l" ? refL : refR).current;
    const other = (who === "l" ? refR : refL).current;
    if (!el || !other) return;
    const half = el.clientHeight / 2;
    const line = (el.scrollTop + half) / LH;
    const max = other.scrollHeight - other.clientHeight;
    const target = mapLine(changesRef.current, who === "l" ? "left" : "right", who === "l" ? "right" : "left", line);
    const want = Math.round(Math.max(0, Math.min(max, target * LH - half)));
    if (Math.abs(other.scrollTop - want) >= 1) {
      expected.current[who === "l" ? "r" : "l"] = want;
      other.scrollTop = want;
    }
    applyScroll();
  }, []);
  // Défilement horizontal : même décalage dans les deux volets.
  const expectedLeft = useRef<Record<"l" | "r", number | null>>({ l: null, r: null });
  const lastTop = useRef({ l: 0, r: 0 });
  // ----- Barres d'aperçu (marge droite des volets) -----
  const rulerLeft = useMemo<RulerMark[]>(
    () => changes.map((c) => ({ start: c.left[0], end: c.left[1], cls: kindClass(c.kind) })),
    [changes],
  );
  const rulerRight = useMemo<RulerMark[]>(
    () => changes.map((c) => ({ start: c.right[0], end: c.right[1], cls: kindClass(c.kind) })),
    [changes],
  );
  /** Amène un volet à une ligne (clic dans sa barre d'aperçu) et cale l'autre. */
  const jumpTo = (who: "l" | "r", line: number) => {
    const el = (who === "l" ? refL : refR).current;
    if (!el) return;
    el.scrollTop = Math.max(0, line * LH - el.clientHeight / 3);
    syncFrom(who);
  };

  // Molette : défilement piloté en JS, volets et liaisons dans la même image.
  useWheelSync(split.ref, (el) => syncFrom(el === refL.current ? "l" : "r"), LH);

  const onScroll = (who: "l" | "r") => () => {
    const el = (who === "l" ? refL : refR).current;
    if (!el) return;
    const o = who === "l" ? "r" : "l";
    const expL = expectedLeft.current[who];
    expectedLeft.current[who] = null;
    const other = (who === "l" ? refR : refL).current;
    if (other && (expL === null || Math.abs(el.scrollLeft - expL) > 1) && Math.abs(other.scrollLeft - el.scrollLeft) >= 1) {
      const before = other.scrollLeft;
      other.scrollLeft = el.scrollLeft;
      // Volet plus étroit : sa butée peut empêcher tout déplacement (pas d'événement).
      if (Math.abs(other.scrollLeft - before) >= 1) expectedLeft.current[o] = other.scrollLeft;
    }
    // Défilement purement horizontal : rien à resynchroniser verticalement.
    if (Math.abs(el.scrollTop - lastTop.current[who]) < 1) return;
    lastTop.current[who] = el.scrollTop;
    const exp = expected.current[who];
    expected.current[who] = null;
    if (exp === null || Math.abs(el.scrollTop - exp) > 1) syncFrom(who);
    else applyScroll();
  };
  useLayoutEffect(() => {
    const el = refR.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // ----- Navigation entre changements -----
  const scrollToChange = useCallback(
    (c: Change) => {
      const el = refR.current;
      if (!el) return;
      el.scrollTop = Math.max(0, c.right[0] * LH - el.clientHeight / 3);
      syncFrom("r");
    },
    [syncFrom],
  );
  const go = (dir: 1 | -1) => {
    if (!changes.length) return;
    const el = refR.current;
    const top = el ? (el.scrollTop + el.clientHeight / 3) / LH : 0;
    const target =
      dir > 0
        ? (changes.find((c) => c.right[0] > top + 0.5) ?? changes[0])
        : ([...changes].reverse().find((c) => c.right[0] < top - 0.5) ?? changes[changes.length - 1]);
    scrollToChange(target);
  };
  // À l'ouverture : premier changement.
  useEffect(() => {
    const first = changesRef.current[0];
    if (first) requestAnimationFrame(() => scrollToChange(first));
  }, [scrollToChange]);

  // ----- Fermeture / changement de fichier avec modifications non enregistrées -----
  const [confirm, setConfirm] = useState<null | (() => void)>(null);
  const guard = (action: () => void) => (dirty ? setConfirm(() => action) : action());
  const save = async () => {
    if (!dirty || busy || !onSave) return true;
    return onSave(versions.crlf ? text.replace(/\n/g, "\r\n") : text);
  };

  useEffect(() => {
    if (embedded || !onClose) return;
    // Capture : Échap ne doit pas fermer toute la page git.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (confirm) setConfirm(null);
      else guard(onClose);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "s") {
      e.preventDefault();
      void save();
    } else if (mod && k === "z" && !e.shiftKey && editable) {
      e.preventDefault();
      undo();
    } else if (mod && (k === "y" || (k === "z" && e.shiftKey)) && editable) {
      e.preventDefault();
      redo();
    } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      go(e.key === "ArrowDown" ? 1 : -1);
    }
  };
  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end");
      commitText(ta.value, true);
    }
  };

  const maxLen = useMemo(() => right.reduce((m, l) => Math.max(m, l.length), 0), [right]);
  const visible = changes.filter((c) => {
    const top = Math.min(c.left[0] * LH - scroll.l, c.right[0] * LH - scroll.r);
    const bot = Math.max(c.left[1] * LH - scroll.l, c.right[1] * LH - scroll.r);
    return bot >= -LH && top <= viewH + LH;
  });

  return (
    <div className={"mv" + (embedded ? " mv-embedded" : "")} onKeyDown={onKeyDown}>
      <div className="mv-top">
        <div className="mv-title">
          <span className="mv-file" title={file}>
            {orig && <span className="muted">{orig} → </span>}
            {file}
          </span>
          <span className="muted mv-stats">
            {changes.length} changement{changes.length > 1 ? "s" : ""}
            {dirty && " · modifié (non enregistré)"}
          </span>
        </div>
        <div className="mv-toolbar">
          <button className="btn btn-ghost btn-sm" onClick={() => go(-1)} title="Changement précédent (Alt+↑)">
            ↑
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => go(1)} title="Changement suivant (Alt+↓)">
            ↓
          </button>
          {onPrev && onNext && total > 0 && (
            <>
              <span className="mv-sep" />
              <button
                className="btn btn-ghost btn-sm"
                disabled={index <= 0}
                onClick={() => guard(onPrev)}
                title="Fichier précédent"
              >
                ← Fichier
              </button>
              <span className="muted mv-stats">
                {index + 1} / {total}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={index >= total - 1}
                onClick={() => guard(onNext)}
                title="Fichier suivant"
              >
                Fichier →
              </button>
            </>
          )}
          {editable && (
            <>
              <span className="mv-sep" />
              <button className="btn btn-ghost btn-sm" onClick={undo} title="Annuler (Ctrl+Z)">
                ↶
              </button>
              <button className="btn btn-ghost btn-sm" onClick={redo} title="Rétablir (Ctrl+Y)">
                ↷
              </button>
            </>
          )}
        </div>
      </div>

      {versions.binary ? (
        <div className="empty">Fichier binaire ou non UTF-8 : pas de comparaison ligne à ligne.</div>
      ) : (
        <>
          <div className="dv-heads" style={{ gridTemplateColumns: cols }}>
            <div className="mv-head">
              {leftLabel ? <b>{leftLabel}</b> : (
                <>
                  <b>HEAD</b> <span className="muted">version committée</span>
                </>
              )}
              {versions.head === null && <span className="mv-del-tag">nouveau fichier</span>}
            </div>
            <div />
            <div className="mv-head mv-head-res">
              {rightLabel ? <b>{rightLabel}</b> : (
                <>
                  <b>Version de travail</b> <span className="muted">{editable ? "éditable" : ""}</span>
                </>
              )}
              {versions.work === null && <span className="mv-del-tag">fichier supprimé</span>}
            </div>
          </div>

          <div className="dv-panes" ref={split.ref} style={{ gridTemplateColumns: cols }}>
            <div className="mv-pane">
              <div className="mv-scroll" ref={refL} onScroll={onScroll("l")}>
                <div className="mv-canvas" style={{ height: left.length * LH + LH }}>
                  <Highlights changes={changes} side="left" lines={left} inline={inline} />
                  <LineNumbers count={left.length} />
                  <Code text={left.join("\n")} lang={lang} className="" />
                </div>
              </div>
              <OverviewRuler marks={rulerLeft} total={left.length} onJump={(l) => jumpTo("l", l)} />
            </div>

            <div
              className="mv-gutter mv-gutter-drag"
              title="Glisser pour redimensionner les volets"
              onMouseDown={(e) => {
                // Les boutons » de la bande restent cliquables.
                if (!(e.target as Element).closest("button")) split.onMouseDown(e);
              }}
            >
              <svg width={GW} height={viewH} className="mv-gutter-svg">
                {visible.map((c) => {
                  const y1 = c.left[0] * LH - scroll.l;
                  const y2 = c.left[1] * LH - scroll.l;
                  const y3 = c.right[0] * LH - scroll.r;
                  const y4 = c.right[1] * LH - scroll.r;
                  const m = GW / 2;
                  return (
                    <path
                      key={c.id}
                      className={"mv-link " + kindClass(c.kind)}
                      d={`M0,${y1} C${m},${y1} ${m},${y3} ${GW},${y3} L${GW},${y4} C${m},${y4} ${m},${y2} 0,${y2} Z`}
                    />
                  );
                })}
              </svg>
              {editable &&
                visible.map((c) => (
                  <div
                    key={c.id}
                    className="mv-acts mv-acts-left"
                    style={{ top: Math.max(0, Math.min(viewH - LH, c.left[0] * LH - scroll.l)) }}
                  >
                    <button
                      className="mv-act"
                      disabled={busy}
                      title="Annuler ce changement (reprendre la version HEAD)"
                      onClick={() => revert(c)}
                    >
                      »
                    </button>
                  </div>
                ))}
            </div>

            <div className="mv-pane">
            <div className="mv-scroll mv-scroll-res" ref={refR} onScroll={onScroll("r")}>
              <div
                className="mv-canvas"
                style={{ height: right.length * LH + LH, width: `max(100%, calc(${maxLen + 6}ch + 56px))` }}
              >
                <Highlights changes={changes} side="right" lines={right} inline={inline} />
                <LineNumbers count={right.length} />
                {editable ? (
                  <>
                    <Code text={text} lang={lang} className="mv-under" />
                    <textarea
                      className="mv-edit"
                      value={text}
                      spellCheck={false}
                      wrap="off"
                      readOnly={busy}
                      style={{ height: right.length * LH + 8, width: "100%" }}
                      onChange={(e) => commitText(e.target.value, true)}
                      onKeyDown={onTextareaKey}
                    />
                  </>
                ) : (
                  <Code text={right.join("\n")} lang={lang} className="" />
                )}
              </div>
            </div>
            <OverviewRuler marks={rulerRight} total={right.length} onJump={(l) => jumpTo("r", l)} />
            </div>
          </div>
        </>
      )}

      {!embedded && (
      <div className="mv-footer">
        <span className="mv-footer-fill" />
        {confirm ? (
          <>
            <span className="mv-confirm">Modifications non enregistrées.</span>
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
              Annuler
            </button>
            <button
              className="btn"
              onClick={() => {
                const a = confirm;
                setConfirm(null);
                a();
              }}
            >
              Ignorer
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                const a = confirm;
                setConfirm(null);
                if (await save()) a();
              }}
            >
              Enregistrer
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={() => onClose && guard(onClose)}>
              Fermer
            </button>
            {editable && (
              <button
                className="btn btn-primary"
                disabled={busy || !dirty}
                onClick={() => void save()}
                title="Enregistrer le fichier (Ctrl+S)"
              >
                {busy && <span className="spinner spinner-xs" />} Enregistrer
              </button>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}
