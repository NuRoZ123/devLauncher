import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { buildChunks, inlineDiff, toLines, type ChangeKind, type InlineRange, type MergeChunk } from "../merge3";
import { highlightCode, langForFile } from "../highlight";
import { useWheelSync } from "../useWheelSync";
import { OverviewRuler, type RulerMark } from "./OverviewRuler";
import type { ConflictVersions } from "../types";

/** Hauteur d'une ligne (px) : commune aux trois volets pour les aligner. */
export const LH = 20;
/** Bordure haute des volets de code (px), à compenser dans les gouttières. */
export const PANE_BORDER = 1;
/** Largeur des gouttières de liaison entre volets (px). */
const GW = 64;
const AUTO_KEY = "devlauncher.merge.autoApply";

type SideState = "pending" | "applied" | "ignored" | "na";
interface Chunk extends MergeChunk {
  /** Plage [début, fin) du changement dans le résultat (volet central). */
  res: [number, number];
  leftState: SideState;
  rightState: SideState;
}
interface Snapshot {
  text: string;
  chunks: Chunk[];
}

const isResolved = (c: Chunk) => c.leftState !== "pending" && c.rightState !== "pending";
const hlClass = (type: MergeChunk["type"], kind: ChangeKind | null) =>
  type === "conflict" ? "mv-hl-conflict" : "mv-hl-" + (kind ?? "modified");

/**
 * Transpose une ligne d'un volet vers un autre en s'appuyant sur les plages des
 * changements (hors changements, les trois versions avancent au même pas).
 */
function mapLine(chunks: Chunk[], from: "left" | "res" | "right", to: "left" | "res" | "right", line: number) {
  let pf = 0;
  let pt = 0;
  for (const c of chunks) {
    const [fs, fe] = c[from];
    const [ts, te] = c[to];
    if (line < fs) return pt + (line - pf);
    if (line < fe) return ts + ((line - fs) / Math.max(1, fe - fs)) * (te - ts);
    pf = fe;
    pt = te;
  }
  return pt + (line - pf);
}

/**
 * Répercute une saisie libre dans le résultat sur les plages des changements :
 * on isole la zone de lignes modifiée (préfixe/suffixe communs), les changements
 * situés après sont décalés, ceux qu'elle touche sont étendus.
 */
function trackEdit(oldText: string, newText: string, chunks: Chunk[]): Chunk[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const oldEnd = a.length - s;
  const newEnd = b.length - s;
  const delta = newEnd - oldEnd;
  if (delta === 0 && p === oldEnd) return chunks;
  return chunks.map((c) => {
    const [rs, re] = c.res;
    if (rs === re) {
      if (rs <= p) return c;
      if (rs >= oldEnd) return { ...c, res: [rs + delta, re + delta] };
      return { ...c, res: [p, p] };
    }
    if (re <= p) return c;
    if (rs >= oldEnd) return { ...c, res: [rs + delta, re + delta] };
    const ns = Math.min(rs, p);
    const ne = Math.max(re + delta, newEnd);
    return { ...c, res: [ns, Math.max(ns, ne)] };
  });
}

/** Remplace les lignes [from, to) du résultat et décale les changements suivants. */
function splice(text: string, chunks: Chunk[], id: number, from: number, to: number, lines: string[]) {
  const all = text.split("\n");
  all.splice(from, to - from, ...lines);
  const delta = lines.length - (to - from);
  const next = chunks.map((c) => {
    if (c.id === id) return c;
    // Les changements sont ordonnés : seuls ceux qui suivent sont décalés.
    if (c.id > id) return { ...c, res: [c.res[0] + delta, c.res[1] + delta] as [number, number] };
    return c;
  });
  return { text: all.join("\n"), chunks: next };
}

// ---------------------------------------------------------------------------
// Volets en lecture seule (gauche / droite)
// ---------------------------------------------------------------------------

export const LineNumbers = memo(function LineNumbers({ count }: { count: number }) {
  const txt = useMemo(() => Array.from({ length: count }, (_, i) => i + 1).join("\n"), [count]);
  return <pre className="mv-nums">{txt}</pre>;
});

/** Diff mot à mot d'un changement : portions propres à chaque côté (lignes relatives au bloc). */
type InlineMap = Map<number, { left: InlineRange[]; right: InlineRange[] }>;

/** Colonne d'affichage d'un index de caractère (tabulations de 4). */
export function visualCol(line: string, idx: number) {
  let col = 0;
  for (let i = 0; i < idx && i < line.length; i++) col = line[i] === "\t" ? col + 4 - (col % 4) : col + 1;
  return col;
}

/** Code coloré (highlight.js), superposé aux surlignages de changements. */
export const Code = memo(function Code({ text, lang, className }: { text: string; lang: string | null; className: string }) {
  const html = useMemo(() => highlightCode(text, lang), [text, lang]);
  // Saut de ligne final : sinon une dernière ligne vide ne serait pas rendue.
  return <pre className={"mv-text hljs " + className} dangerouslySetInnerHTML={{ __html: html + "\n" }} />;
});

const ReadonlyPane = memo(function ReadonlyPane({
  lines,
  chunks,
  side,
  lang,
  inline,
}: {
  lines: string[];
  chunks: Chunk[];
  side: "left" | "right";
  lang: string | null;
  inline: InlineMap;
}) {
  const text = useMemo(() => lines.join("\n"), [lines]);
  return (
    <div className="mv-canvas" style={{ height: lines.length * LH + LH }}>
      {chunks.map((c) => {
        const kind = side === "left" ? c.leftKind : c.rightKind;
        if (!kind) return null;
        const [s, e] = c[side];
        const st = side === "left" ? c.leftState : c.rightState;
        return (
          <div
            key={c.id}
            className={
              "mv-hl " + hlClass(c.type, kind) + (s === e ? " mv-hl-empty" : "") + (st !== "pending" ? " mv-hl-done" : "")
            }
            style={{ top: s * LH, height: s === e ? 0 : (e - s) * LH }}
          />
        );
      })}
      {/* Portions qui diffèrent du côté opposé (surlignage « by word » de JetBrains). */}
      {chunks.map((c) => {
        const parts = inline.get(c.id)?.[side];
        if (!parts?.length) return null;
        const st = side === "left" ? c.leftState : c.rightState;
        const cls =
          "mv-word" + (c.type === "conflict" ? " mv-word-conflict" : "") + (st !== "pending" ? " mv-hl-done" : "");
        return parts.map((r, i) => {
          const ln = c[side][0] + r.line;
          const src = lines[ln] ?? "";
          const a = visualCol(src, r.start);
          const b = visualCol(src, r.end);
          return (
            <div
              key={`${c.id}-${i}`}
              className={cls}
              style={{ top: ln * LH, left: `calc(56px + ${a}ch)`, width: `${Math.max(1, b - a)}ch` }}
            />
          );
        });
      })}
      <LineNumbers count={lines.length} />
      <Code text={text} lang={lang} className="" />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Gouttière de liaison + boutons d'application (» / « / ×)
// ---------------------------------------------------------------------------

function Gutter({
  side,
  chunks,
  sideScroll,
  resScroll,
  height,
  onApply,
  onIgnore,
  onResizeStart,
}: {
  side: "left" | "right";
  chunks: Chunk[];
  sideScroll: number;
  resScroll: number;
  height: number;
  onApply: (c: Chunk) => void;
  onIgnore: (c: Chunk) => void;
  /** Glisser la bande (hors boutons) redimensionne les volets voisins. */
  onResizeStart: (e: React.MouseEvent) => void;
}) {
  // Coordonnées x du bord côté volet latéral / côté résultat.
  const xs = side === "left" ? 0 : GW;
  const xr = side === "left" ? GW : 0;
  const mid = GW / 2;
  const visible = chunks.filter((c) => {
    if (!(side === "left" ? c.leftKind : c.rightKind)) return false;
    const [s, e] = c[side];
    const top = Math.min(s * LH - sideScroll, c.res[0] * LH - resScroll);
    const bot = Math.max(e * LH - sideScroll, c.res[1] * LH - resScroll);
    return bot >= -LH && top <= height + LH;
  });
  return (
    <div
      className="mv-gutter mv-gutter-drag"
      title="Glisser pour redimensionner les volets"
      onMouseDown={(e) => {
        if (!(e.target as Element).closest("button")) onResizeStart(e);
      }}
    >
      <svg width={GW} height={height} className="mv-gutter-svg">
        {visible.map((c) => {
          const [s, e] = c[side];
          const st = side === "left" ? c.leftState : c.rightState;
          const y1 = s * LH - sideScroll;
          const y2 = e * LH - sideScroll;
          const y3 = c.res[0] * LH - resScroll;
          const y4 = c.res[1] * LH - resScroll;
          const d =
            `M${xs},${y1} C${mid},${y1} ${mid},${y3} ${xr},${y3} L${xr},${y4} ` +
            `C${mid},${y4} ${mid},${y2} ${xs},${y2} Z`;
          const kind = side === "left" ? c.leftKind : c.rightKind;
          return (
            <path
              key={c.id}
              d={d}
              className={"mv-link " + hlClass(c.type, kind) + (st !== "pending" ? " mv-hl-done" : "")}
            />
          );
        })}
      </svg>
      {visible.map((c) => {
        const st = side === "left" ? c.leftState : c.rightState;
        if (st !== "pending") return null;
        const other = side === "left" ? c.rightState : c.leftState;
        // Dans un conflit dont l'autre côté est déjà pris, « appliquer » ajoute
        // ce côté à la suite (on conserve les deux), comme dans JetBrains.
        const append = c.type === "conflict" && other === "applied";
        const y = Math.max(0, Math.min(height - LH, c[side][0] * LH - sideScroll));
        const apply = (
          <button
            key="a"
            className={"mv-act" + (append ? " mv-act-append" : "")}
            title={
              append
                ? "Ajouter ce côté à la suite (conserver les deux)"
                : side === "left"
                  ? "Appliquer ce changement (»)"
                  : "Appliquer ce changement («)"
            }
            onClick={() => onApply(c)}
          >
            {side === "left" ? (append ? "»+" : "»") : append ? "+«" : "«"}
          </button>
        );
        const ignore = (
          <button key="i" className="mv-act mv-act-ignore" title="Ignorer ce changement" onClick={() => onIgnore(c)}>
            ×
          </button>
        );
        return (
          <div key={c.id} className={"mv-acts mv-acts-" + side} style={{ top: y }}>
            {side === "left" ? [ignore, apply] : [apply, ignore]}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vue de fusion
// ---------------------------------------------------------------------------

interface Props {
  file: string;
  versions: ConflictVersions;
  /** En rebase, « ours » (stage 2) est la branche amont : on inverse l'affichage
   *  pour garder « vos changements » à gauche et « entrants » à droite. */
  swap: boolean;
  leftLabel: string;
  rightLabel: string;
  busy: boolean;
  /** Enregistre le résultat (texte final, fins de ligne restituées). */
  onSave: (content: string) => void;
  /** Accepte un côté entier ("ours"/"theirs" au sens git). */
  onAcceptSide: (side: "ours" | "theirs") => void;
  onCancel: () => void;
}

export function MergeView({ file, versions, swap, leftLabel, rightLabel, busy, onSave, onAcceptSide, onCancel }: Props) {
  const leftRaw = swap ? versions.theirs : versions.ours;
  const rightRaw = swap ? versions.ours : versions.theirs;
  const left = useMemo(() => toLines(leftRaw), [leftRaw]);
  const right = useMemo(() => toLines(rightRaw), [rightRaw]);
  const base = useMemo(() => toLines(versions.base), [versions.base]);

  const [autoApply, setAutoApply] = useState(() => {
    try {
      return localStorage.getItem(AUTO_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Le résultat part de l'ancêtre commun (comme JetBrains) ; chaque changement
  // y est ensuite appliqué ou ignoré.
  const lang = useMemo(() => langForFile(file), [file]);
  const built = useMemo(() => buildChunks(base, left, right), [base, left, right]);
  // Diff mot à mot entre les deux côtés de chaque changement (calculé une fois :
  // le contenu des volets latéraux ne change pas).
  const inline = useMemo<InlineMap>(() => {
    const m: InlineMap = new Map();
    for (const c of built) {
      if (c.type === "both" || !c.leftLines.length || !c.rightLines.length) continue;
      const d = inlineDiff(c.leftLines, c.rightLines);
      if (d) m.set(c.id, { left: d.a, right: d.b });
    }
    return m;
  }, [built]);

  const [state, setState] = useState<Snapshot>(() => {
    const chunks: Chunk[] = built.map((c) => ({
      ...c,
      res: [c.base[0], c.base[1]],
      leftState: c.leftKind ? "pending" : "na",
      rightState: c.rightKind ? "pending" : "na",
    }));
    return { text: base.join("\n"), chunks };
  });
  const { text, chunks } = state;
  const resLines = useMemo(() => text.split("\n"), [text]);

  // ----- Historique (Ctrl+Z / Ctrl+Y) -----
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const lastTyping = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((next: Snapshot, typing = false) => {
    const now = Date.now();
    // Les frappes rapprochées sont regroupées en une seule étape d'annulation.
    if (!typing || now - lastTyping.current > 700) undoStack.current.push(stateRef.current);
    if (undoStack.current.length > 300) undoStack.current.shift();
    lastTyping.current = typing ? now : 0;
    redoStack.current = [];
    setState(next);
  }, []);
  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(stateRef.current);
    lastTyping.current = 0;
    setState(prev);
  }, []);
  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(stateRef.current);
    lastTyping.current = 0;
    setState(next);
  }, []);

  // ----- Opérations sur les changements -----
  /** Applique un côté d'un changement sur un instantané (fonction pure). */
  const applySide = (snap: Snapshot, id: number, side: "left" | "right"): Snapshot => {
    const c = snap.chunks.find((x) => x.id === id)!;
    const lines = side === "left" ? c.leftLines : c.rightLines;
    const other = side === "left" ? c.rightState : c.leftState;
    const append = c.type === "conflict" && other === "applied";
    const [from, to] = append ? [c.res[1], c.res[1]] : c.res;
    const out = splice(snap.text, snap.chunks, id, from, to, lines);
    const res: [number, number] = append ? [c.res[0], c.res[1] + lines.length] : [c.res[0], c.res[0] + lines.length];
    const both = c.type === "both";
    return {
      text: out.text,
      chunks: out.chunks.map((x) =>
        x.id !== id
          ? x
          : {
              ...x,
              res,
              leftState: side === "left" || both ? "applied" : x.leftState,
              rightState: side === "right" || both ? "applied" : x.rightState,
            },
      ),
    };
  };

  const apply = useCallback(
    (c: Chunk, side: "left" | "right") => commit(applySide(stateRef.current, c.id, side)),
    [commit],
  );
  const ignore = useCallback(
    (c: Chunk, side: "left" | "right") => {
      const s = stateRef.current;
      const both = c.type === "both";
      commit({
        text: s.text,
        chunks: s.chunks.map((x) =>
          x.id !== c.id
            ? x
            : {
                ...x,
                leftState: side === "left" || both ? "ignored" : x.leftState,
                rightState: side === "right" || both ? "ignored" : x.rightState,
              },
        ),
      });
    },
    [commit],
  );

  /** Applique tous les changements non conflictuels (d'un côté ou des deux). */
  const applyNonConflicting = useCallback(
    (which: "all" | "left" | "right", record = true) => {
      let s = stateRef.current;
      for (const c of s.chunks) {
        if (isResolved(c) || c.type === "conflict") continue;
        if (c.type === "left" && which !== "right") s = applySide(s, c.id, "left");
        else if (c.type === "right" && which !== "left") s = applySide(s, c.id, "right");
        else if (c.type === "both") s = applySide(s, c.id, which === "right" ? "right" : "left");
      }
      if (s === stateRef.current) return;
      if (record) commit(s);
      else setState(s);
    },
    [commit],
  );

  /** Baguette magique : fusionne les conflits dont les côtés touchent des lignes distinctes. */
  const resolveSimple = useCallback(() => {
    let s = stateRef.current;
    for (const c of s.chunks) {
      if (c.type !== "conflict" || !c.simple || c.leftState !== "pending" || c.rightState !== "pending") continue;
      const cur = s.chunks.find((x) => x.id === c.id)!;
      const out = splice(s.text, s.chunks, c.id, cur.res[0], cur.res[1], c.simple);
      s = {
        text: out.text,
        chunks: out.chunks.map((x) =>
          x.id !== c.id
            ? x
            : { ...x, res: [cur.res[0], cur.res[0] + c.simple!.length], leftState: "applied", rightState: "applied" },
        ),
      };
    }
    if (s !== stateRef.current) commit(s);
  }, [commit]);

  // Application automatique des changements non conflictuels à l'ouverture.
  const didAuto = useRef(false);
  useEffect(() => {
    if (didAuto.current) return;
    didAuto.current = true;
    if (autoApply) applyNonConflicting("all", false);
  }, [autoApply, applyNonConflicting]);

  const toggleAuto = (v: boolean) => {
    setAutoApply(v);
    try {
      localStorage.setItem(AUTO_KEY, v ? "1" : "0");
    } catch {
      /* stockage indisponible : réglage non mémorisé */
    }
  };

  // ----- Édition libre du résultat -----
  const onEdit = (value: string, typing = true) => {
    const s = stateRef.current;
    commit({ text: value, chunks: trackEdit(s.text, value, s.chunks) }, typing);
  };

  // ----- Copier / couper la ligne courante (sans sélection, comme JetBrains) -----
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Position du curseur à rétablir après une modification programmatique (la
  // zone de saisie étant contrôlée, React replacerait sinon le curseur à la fin).
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    const p = caretAfter.current;
    if (p != null && taRef.current) {
      taRef.current.setSelectionRange(p, p);
      caretAfter.current = null;
    }
  }, [text]);
  // Dernière ligne copiée/coupée entière : collée telle quelle, elle s'insère
  // au-dessus de la ligne courante au lieu d'au milieu (comportement JetBrains).
  const lineClip = useRef<string | null>(null);

  const writeClipboard = async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
    } catch {
      // Repli : copie via une zone temporaire, puis on rend le focus à l'éditeur.
      const tmp = document.createElement("textarea");
      tmp.value = s;
      tmp.style.position = "fixed";
      tmp.style.opacity = "0";
      document.body.appendChild(tmp);
      tmp.select();
      try {
        document.execCommand("copy");
      } finally {
        tmp.remove();
        taRef.current?.focus();
      }
    }
  };

  /** Bornes [début, fin) de la ligne contenant `pos` (fin = avant le \n). */
  const lineBounds = (v: string, pos: number) => {
    const start = v.lastIndexOf("\n", pos - 1) + 1;
    const nl = v.indexOf("\n", pos);
    return { start, end: nl < 0 ? v.length : nl };
  };

  /** Ctrl+C / Ctrl+X sans sélection : copie (et coupe) la ligne entière. */
  const copyOrCutLine = (ta: HTMLTextAreaElement, cut: boolean) => {
    const v = ta.value;
    const pos = ta.selectionStart;
    const { start, end } = lineBounds(v, pos);
    const line = v.slice(start, end) + "\n";
    lineClip.current = line;
    void writeClipboard(line);
    if (!cut) return;
    const col = pos - start;
    let next: string;
    let lineStart: number;
    if (end < v.length) {
      // Retire la ligne et son saut de ligne : la suivante remonte à sa place.
      next = v.slice(0, start) + v.slice(end + 1);
      lineStart = start;
    } else if (start > 0) {
      // Dernière ligne : on retire le saut de ligne qui la précède.
      next = v.slice(0, start - 1);
      lineStart = next.lastIndexOf("\n") + 1;
    } else {
      next = "";
      lineStart = 0;
    }
    // Le curseur garde sa colonne sur la ligne qui prend la place.
    const { end: lineEnd } = lineBounds(next, lineStart);
    caretAfter.current = Math.min(lineStart + col, lineEnd);
    onEdit(next, false);
  };

  // ----- Largeur des 3 volets : chaque bande de liaison se glisse -----
  // p1 / p2 : position (en % de la largeur) du centre des bandes gauche / droite.
  const SPLIT_KEY = "devlauncher.split.merge";
  const [bounds, setBounds] = useState<[number, number]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? "null");
      if (Array.isArray(v) && v[0] >= 10 && v[1] - v[0] >= 15 && v[1] <= 90) return [v[0], v[1]];
    } catch {
      /* valeur absente ou illisible */
    }
    return [100 / 3, 200 / 3];
  });
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const panesRef = useRef<HTMLDivElement>(null);
  const dragBound = useRef<0 | 1 | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const which = dragBound.current;
      if (which === null || !panesRef.current) return;
      const r = panesRef.current.getBoundingClientRect();
      const p = ((e.clientX - r.left) / r.width) * 100;
      const [a, b] = boundsRef.current;
      // Chaque volet garde au moins ~10-15 % de la largeur.
      const next: [number, number] = which === 0 ? [Math.max(10, Math.min(b - 15, p)), b] : [a, Math.max(a + 15, Math.min(90, p))];
      boundsRef.current = next;
      setBounds(next);
    };
    const up = () => {
      if (dragBound.current === null) return;
      dragBound.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(SPLIT_KEY, JSON.stringify(boundsRef.current.map((x) => Math.round(x * 10) / 10)));
      } catch {
        /* stockage indisponible : position non mémorisée */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);
  const startResize = (which: 0 | 1) => (e: React.MouseEvent) => {
    e.preventDefault();
    dragBound.current = which;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const half = GW / 2;
  const cols =
    `calc(${bounds[0]}% - ${half}px) ${GW}px ` +
    `calc(${bounds[1] - bounds[0]}% - ${GW}px) ${GW}px minmax(0, 1fr)`;

  // ----- Défilement synchronisé -----
  const refL = useRef<HTMLDivElement>(null);
  const refC = useRef<HTMLDivElement>(null);
  const refR = useRef<HTMLDivElement>(null);
  // Position imposée par la synchro à chaque volet : l'événement scroll qu'elle
  // provoque est ignoré, seul un défilement de l'utilisateur est propagé.
  const expected = useRef<Record<"l" | "c" | "r", number | null>>({ l: null, c: null, r: null });
  // Les volets ont une bordure de 1 px : leur contenu commence 1 px sous le
  // haut des gouttières. On l'intègre au défilement pour aligner les liaisons.
  const [scroll, setScroll] = useState({ l: -PANE_BORDER, c: -PANE_BORDER, r: -PANE_BORDER });
  /** Relit le défilement des 3 volets et redessine les gouttières tout de suite
   *  (flushSync) : sinon elles suivent avec une image de retard en défilant. */
  const applyScroll = () =>
    flushSync(() =>
      setScroll({
        l: (refL.current?.scrollTop ?? 0) - PANE_BORDER,
        c: (refC.current?.scrollTop ?? 0) - PANE_BORDER,
        r: (refR.current?.scrollTop ?? 0) - PANE_BORDER,
      }),
    );
  const [viewH, setViewH] = useState(400);
  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;

  const syncFrom = useCallback((who: "l" | "c" | "r") => {
    const el = { l: refL, c: refC, r: refR }[who].current;
    if (!el) return;
    const ch = chunksRef.current;
    const key = { l: "left", c: "res", r: "right" } as const;
    // Ligne située au milieu de la vue : c'est elle que l'on aligne.
    const half = el.clientHeight / 2;
    const line = (el.scrollTop + half) / LH;
    for (const o of ["l", "c", "r"] as const) {
      if (o === who) continue;
      const target = { l: refL, c: refC, r: refR }[o].current;
      if (!target) continue;
      const max = target.scrollHeight - target.clientHeight;
      const want = Math.round(Math.max(0, Math.min(max, mapLine(ch, key[who], key[o], line) * LH - half)));
      if (Math.abs(target.scrollTop - want) < 1) continue;
      expected.current[o] = want;
      target.scrollTop = want;
    }
    applyScroll();
  }, []);

  // ----- Barres d'aperçu (marge droite des volets) -----
  // Mêmes couleurs que les blocs ; un changement traité est atténué.
  const rulerLeft = useMemo<RulerMark[]>(
    () =>
      chunks
        .filter((c) => c.leftKind)
        .map((c) => ({ start: c.left[0], end: c.left[1], cls: hlClass(c.type, c.leftKind), done: c.leftState !== "pending" })),
    [chunks],
  );
  const rulerRight = useMemo<RulerMark[]>(
    () =>
      chunks
        .filter((c) => c.rightKind)
        .map((c) => ({ start: c.right[0], end: c.right[1], cls: hlClass(c.type, c.rightKind), done: c.rightState !== "pending" })),
    [chunks],
  );
  const rulerRes = useMemo<RulerMark[]>(
    () =>
      chunks.map((c) => ({
        start: c.res[0],
        end: c.res[1],
        cls: hlClass(c.type, c.type === "right" ? c.rightKind : c.leftKind ?? c.rightKind),
        done: isResolved(c),
      })),
    [chunks],
  );
  /** Amène un volet à une ligne (clic dans sa barre d'aperçu) et cale les autres. */
  const jumpTo = (who: "l" | "c" | "r", line: number) => {
    const el = { l: refL, c: refC, r: refR }[who].current;
    if (!el) return;
    el.scrollTop = Math.max(0, line * LH - el.clientHeight / 3);
    lastTop.current[who] = el.scrollTop;
    syncFrom(who);
  };

  // Molette : défilement piloté en JS, volets et liaisons dans la même image.
  useWheelSync(
    panesRef,
    (el) => {
      const who = el === refL.current ? "l" : el === refR.current ? "r" : "c";
      lastTop.current[who] = el.scrollTop;
      syncFrom(who);
    },
    LH,
  );

  // Défilement horizontal : même décalage dans les trois volets.
  const expectedLeft = useRef<Record<"l" | "c" | "r", number | null>>({ l: null, c: null, r: null });
  const lastTop = useRef({ l: 0, c: 0, r: 0 });
  const onScroll = (who: "l" | "c" | "r") => () => {
    const el = { l: refL, c: refC, r: refR }[who].current;
    if (!el) return;
    const expL = expectedLeft.current[who];
    expectedLeft.current[who] = null;
    if (expL === null || Math.abs(el.scrollLeft - expL) > 1) {
      for (const o of ["l", "c", "r"] as const) {
        const target = { l: refL, c: refC, r: refR }[o].current;
        if (o === who || !target || Math.abs(target.scrollLeft - el.scrollLeft) < 1) continue;
        const before = target.scrollLeft;
        target.scrollLeft = el.scrollLeft;
        // Volet plus étroit : sa butée peut empêcher tout déplacement (pas d'événement).
        if (Math.abs(target.scrollLeft - before) >= 1) expectedLeft.current[o] = target.scrollLeft;
      }
    }
    // Défilement purement horizontal : rien à resynchroniser verticalement.
    if (Math.abs(el.scrollTop - lastTop.current[who]) < 1) return;
    lastTop.current[who] = el.scrollTop;
    const exp = expected.current[who];
    expected.current[who] = null;
    if (exp === null || Math.abs(el.scrollTop - exp) > 1) syncFrom(who);
    else
      applyScroll();
  };

  useLayoutEffect(() => {
    const el = refC.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // ----- Navigation entre changements -----
  const pending = chunks.filter((c) => !isResolved(c));
  const conflictsLeft = pending.filter((c) => c.type === "conflict").length;
  const simpleCount = pending.filter((c) => c.type === "conflict" && c.simple).length;
  const nonConflictLeft = pending.length - conflictsLeft;

  const scrollToChunk = useCallback(
    (c: Chunk) => {
      const el = refC.current;
      if (!el) return;
      el.scrollTop = Math.max(0, c.res[0] * LH - el.clientHeight / 3);
      syncFrom("c");
    },
    [syncFrom],
  );
  const current = useRef(-1);
  const go = (dir: 1 | -1) => {
    const list = pending.length ? pending : chunks;
    if (!list.length) return;
    const el = refC.current;
    const top = el ? (el.scrollTop + el.clientHeight / 3) / LH : 0;
    let target: Chunk | undefined;
    if (dir > 0) target = list.find((c) => c.res[0] > top + 0.5) ?? list[0];
    else target = [...list].reverse().find((c) => c.res[0] < top - 0.5) ?? list[list.length - 1];
    current.current = target.id;
    scrollToChunk(target);
  };

  // Au chargement : se placer sur le premier changement.
  useEffect(() => {
    const first = stateRef.current.chunks.find((c) => c.type === "conflict") ?? stateRef.current.chunks[0];
    if (first) requestAnimationFrame(() => scrollToChunk(first));
  }, [scrollToChunk]);

  // ----- Raccourcis -----
  const [confirmSave, setConfirmSave] = useState(false);
  // La confirmation porte sur un nombre de changements restants : dès qu'il
  // bouge (un changement traité), on la retire au lieu de la laisser figée.
  useEffect(() => setConfirmSave(false), [pending.length]);
  useEffect(() => {
    // Capture : Échap ne doit pas fermer la page git (travail en cours).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setConfirmSave(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (mod && (k === "y" || (k === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      go(e.key === "ArrowDown" ? 1 : -1);
    }
  };

  /** Coller une ligne copiée entière (sans sélection) : insérée au-dessus de la ligne courante. */
  const onTextareaPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const txt = e.clipboardData.getData("text/plain").replace(/\r\n/g, "\n");
    if (busy || !lineClip.current || txt !== lineClip.current || ta.selectionStart !== ta.selectionEnd) return;
    e.preventDefault();
    const v = ta.value;
    const pos = ta.selectionStart;
    const { start } = lineBounds(v, pos);
    caretAfter.current = pos + txt.length;
    onEdit(v.slice(0, start) + txt + v.slice(start), false);
  };

  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (k === "c" || k === "x")) {
      // Avec une sélection : copier/couper standard du navigateur.
      if (ta.selectionStart !== ta.selectionEnd) {
        lineClip.current = null;
        return;
      }
      e.preventDefault();
      if (k === "x" && busy) return;
      copyOrCutLine(ta, k === "x");
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end");
      onEdit(ta.value);
    }
  };

  // Un côté a supprimé le fichier et le résultat est vide : la suppression est
  // retenue (sinon le fichier subsisterait, vide).
  const leftMissing = leftRaw === null;
  const rightMissing = rightRaw === null;
  const deletes = (leftMissing || rightMissing) && text.trim() === "";
  const save = () => {
    if (pending.length > 0 && !confirmSave) {
      setConfirmSave(true);
      return;
    }
    // Suppression conservée : git rm plutôt qu'un fichier vide.
    if (deletes) {
      onAcceptSide(leftMissing ? (swap ? "theirs" : "ours") : swap ? "ours" : "theirs");
      return;
    }
    const out = versions.crlf ? text.replace(/\n/g, "\r\n") : text;
    onSave(out);
  };

  const maxLen = useMemo(() => resLines.reduce((m, l) => Math.max(m, l.length), 0), [resLines]);

  return (
    <div className="mv" onKeyDown={onKeyDown}>
      <div className="mv-top">
        <div className="mv-title">
          <span className="mv-file" title={file}>
            {file}
          </span>
          <span className="muted mv-stats">
            {conflictsLeft} conflit{conflictsLeft > 1 ? "s" : ""} · {nonConflictLeft} changement
            {nonConflictLeft > 1 ? "s" : ""} non conflictuel{nonConflictLeft > 1 ? "s" : ""} restant
            {pending.length > 1 ? "s" : ""}
          </span>
        </div>
        <div className="mv-toolbar">
          <button className="btn btn-ghost btn-sm" onClick={() => go(-1)} title="Changement précédent (Alt+↑)">
            ↑
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => go(1)} title="Changement suivant (Alt+↓)">
            ↓
          </button>
          <span className="mv-sep" />
          <button
            className="btn btn-sm"
            onClick={() => applyNonConflicting("left")}
            disabled={!pending.some((c) => c.type === "left" || c.type === "both")}
            title="Appliquer les changements non conflictuels de gauche"
          >
            ⇥ Gauche
          </button>
          <button
            className="btn btn-sm"
            onClick={() => applyNonConflicting("all")}
            disabled={nonConflictLeft === 0}
            title="Appliquer tous les changements non conflictuels"
          >
            ⇉ Tous les non conflictuels
          </button>
          <button
            className="btn btn-sm"
            onClick={() => applyNonConflicting("right")}
            disabled={!pending.some((c) => c.type === "right" || c.type === "both")}
            title="Appliquer les changements non conflictuels de droite"
          >
            Droite ⇤
          </button>
          <button
            className="btn btn-sm"
            onClick={resolveSimple}
            disabled={simpleCount === 0}
            title="Résoudre les conflits simples : les deux côtés modifient des lignes différentes"
          >
            ✨ Conflits simples{simpleCount ? ` (${simpleCount})` : ""}
          </button>
          <span className="mv-sep" />
          <button className="btn btn-ghost btn-sm" onClick={undo} title="Annuler (Ctrl+Z)">
            ↶
          </button>
          <button className="btn btn-ghost btn-sm" onClick={redo} title="Rétablir (Ctrl+Y)">
            ↷
          </button>
          <label className="chk-inline mv-auto" title="Appliquer automatiquement les changements non conflictuels à l'ouverture">
            <input type="checkbox" checked={autoApply} onChange={(e) => toggleAuto(e.target.checked)} />
            Auto-appliquer les non conflictuels
          </label>
        </div>
      </div>

      <div className="mv-heads" style={{ gridTemplateColumns: cols }}>
        <div className="mv-head">
          <b>Vos changements</b> <span className="muted">{leftLabel}</span>
          {leftMissing && <span className="mv-del-tag">fichier supprimé</span>}
        </div>
        <div />
        <div className="mv-head mv-head-res">
          <b>Résultat</b> <span className="muted">éditable</span>
        </div>
        <div />
        <div className="mv-head">
          <b>Changements entrants</b> <span className="muted">{rightLabel}</span>
          {rightMissing && <span className="mv-del-tag">fichier supprimé</span>}
        </div>
      </div>

      <div className="mv-panes" ref={panesRef} style={{ gridTemplateColumns: cols }}>
        <div className="mv-pane">
          <div className="mv-scroll" ref={refL} onScroll={onScroll("l")}>
            <ReadonlyPane lines={left} chunks={chunks} side="left" lang={lang} inline={inline} />
          </div>
          <OverviewRuler marks={rulerLeft} total={left.length} onJump={(l) => jumpTo("l", l)} />
        </div>
        <Gutter
          side="left"
          chunks={chunks}
          sideScroll={scroll.l}
          resScroll={scroll.c}
          height={viewH}
          onApply={(c) => apply(c, "left")}
          onIgnore={(c) => ignore(c, "left")}
          onResizeStart={startResize(0)}
        />
        <div className="mv-pane">
        <div
          className="mv-scroll mv-scroll-res"
          ref={refC}
          onScroll={onScroll("c")}
        >
          {/* Largeur fixée sur le conteneur (et non sur la zone de saisie) : les
              surlignages, calés sur lui, couvrent ainsi toute la largeur défilable. */}
          <div
            className="mv-canvas"
            style={{ height: resLines.length * LH + LH, width: `max(100%, calc(${maxLen + 6}ch + 56px))` }}
          >
            {chunks.map((c) => {
              const [s, e] = c.res;
              const done = isResolved(c);
              const cls = done
                ? "mv-hl-resolved"
                : hlClass(c.type, c.type === "right" ? c.rightKind : c.leftKind ?? c.rightKind);
              return (
                <div
                  key={c.id}
                  className={"mv-hl " + cls + (s === e ? " mv-hl-empty" : "")}
                  style={{ top: s * LH, height: s === e ? 0 : (e - s) * LH }}
                />
              );
            })}
            <LineNumbers count={resLines.length} />
            {/* Texte coloré sous la zone de saisie, dont le texte est transparent. */}
            <Code text={text} lang={lang} className="mv-under" />
            <textarea
              className="mv-edit"
              value={text}
              spellCheck={false}
              wrap="off"
              readOnly={busy}
              style={{ height: resLines.length * LH + 8, width: "100%" }}
              onChange={(e) => onEdit(e.target.value)}
              onKeyDown={onTextareaKey}
              onPaste={onTextareaPaste}
              ref={taRef}
            />
          </div>
        </div>
        <OverviewRuler marks={rulerRes} total={resLines.length} onJump={(l) => jumpTo("c", l)} />
        </div>
        <Gutter
          side="right"
          chunks={chunks}
          sideScroll={scroll.r}
          resScroll={scroll.c}
          height={viewH}
          onApply={(c) => apply(c, "right")}
          onIgnore={(c) => ignore(c, "right")}
          onResizeStart={startResize(1)}
        />
        <div className="mv-pane">
          <div className="mv-scroll" ref={refR} onScroll={onScroll("r")}>
            <ReadonlyPane lines={right} chunks={chunks} side="right" lang={lang} inline={inline} />
          </div>
          <OverviewRuler marks={rulerRight} total={right.length} onJump={(l) => jumpTo("r", l)} />
        </div>
      </div>

      <div className="mv-footer">
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => onAcceptSide(swap ? "theirs" : "ours")}
          title="Résoudre tout le fichier avec la version de gauche"
        >
          Accepter la gauche
        </button>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => onAcceptSide(swap ? "ours" : "theirs")}
          title="Résoudre tout le fichier avec la version de droite"
        >
          Accepter la droite
        </button>
        <span className="mv-footer-fill" />
        {/* État en direct du fichier : peut-on appliquer sans rien laisser de côté ? */}
        {pending.length === 0 ? (
          <span className="mv-state mv-state-ok" title="Tous les changements ont été appliqués ou ignorés">
            ✓ Tout est traité
          </span>
        ) : (
          <button
            className="mv-state mv-state-todo"
            onClick={() => go(1)}
            title="Aller au prochain changement à traiter (Alt+↓)"
          >
            {conflictsLeft > 0 && (
              <span className="mv-state-conf">
                {conflictsLeft} conflit{conflictsLeft > 1 ? "s" : ""}
              </span>
            )}
            {conflictsLeft > 0 && nonConflictLeft > 0 && " · "}
            {nonConflictLeft > 0 && (
              <span>
                {nonConflictLeft} changement{nonConflictLeft > 1 ? "s" : ""}
              </span>
            )}{" "}
            à traiter →
          </button>
        )}
        {confirmSave && pending.length > 0 && (
          <span className="mv-confirm">Enregistrer quand même ?</span>
        )}
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>
          Annuler
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={save} title={deletes ? "Supprimer le fichier et le marquer résolu" : "Enregistrer le résultat et marquer le fichier résolu"}>
          {busy && <span className="spinner spinner-xs" />} {confirmSave ? "Oui, appliquer" : "Appliquer"}
          {deletes && " (supprimer le fichier)"}
        </button>
      </div>
    </div>
  );
}
