import { useEffect, useMemo, useRef, useState } from "react";
import type { DbGraphColumn, DbGraphLayout, DbGraphTable, DbRelation } from "../types";

export interface DbGraphState {
  tables: DbGraphTable[];
  relations: DbRelation[];
  loading: boolean;
  error?: string;
  /** false tant que le graphe n'a jamais été chargé. */
  loaded: boolean;
}

interface Props {
  state: DbGraphState;
  /**
   * Table à mettre au centre : la vue ne montre alors qu'elle et ses voisines
   * directes, en trois colonnes. Absent = schéma complet de la base.
   */
  focus?: string;
  onRefresh: () => void;
  onOpenTable: (table: string) => void;
  /** Disposition sauvegardée (schéma complet uniquement). */
  savedLayout?: DbGraphLayout | null;
  /** Enregistre la disposition courante (positions + courbures des jointures). */
  onSaveLayout?: (layout: DbGraphLayout) => void;
  /** true = vue active : active le raccourci Ctrl+S. */
  active?: boolean;
}

type Pt = { x: number; y: number };

/** Boîte d'une table posée sur le plan. */
interface Node {
  table: DbGraphTable;
  x: number;
  y: number;
  w: number;
  h: number;
}

const HEAD_H = 26;
const ROW_H = 17;
const CHAR_W = 6.6;
const ICON_W = 26;
const PAD_X = 12;
/** Au-delà, la boîte est tronquée : une table très large resterait illisible. */
const MAX_ROWS = 40;

/**
 * Repère de type affiché devant chaque colonne. Volontairement en ASCII : les
 * emoji ne sont pas rendus de façon fiable selon les polices installées.
 */
function typeIcon(c: DbGraphColumn): { label: string; cls: string } {
  const t = c.base_type.toLowerCase();
  const full = c.full_type.toLowerCase();
  if (t === "bool" || t === "boolean" || full === "tinyint(1)")
    return { label: "01", cls: "t-bool" };
  if (
    /^(int|integer|bigint|smallint|mediumint|tinyint|decimal|numeric|float|double|real|money|serial|bigserial|year|bit|int2|int4|int8|float4|float8)/.test(
      t,
    )
  )
    return { label: "123", cls: "t-num" };
  if (/^(date|time|timestamp|timestamptz|timetz|interval)/.test(t))
    return { label: "DT", cls: "t-date" };
  if (/^(json|jsonb)/.test(t)) return { label: "{}", cls: "t-json" };
  if (t === "uuid") return { label: "ID", cls: "t-uuid" };
  if (/^(bytea|blob|binary|varbinary)/.test(t)) return { label: "0x", cls: "t-bin" };
  return { label: "AZ", cls: "t-text" };
}

const rowCount = (t: DbGraphTable) => Math.min(t.columns.length, MAX_ROWS);

function boxSize(t: DbGraphTable, withColumns: boolean) {
  if (!withColumns) {
    return {
      w: Math.max(90, Math.round(t.name.length * 7.2) + 36),
      h: HEAD_H + 4,
    };
  }
  const longest = t.columns
    .slice(0, MAX_ROWS)
    .reduce((m, c) => Math.max(m, c.name.length), 0);
  const w = Math.max(
    Math.round(t.name.length * 7.4) + 40,
    ICON_W + Math.round(longest * CHAR_W) + PAD_X * 2,
    120,
  );
  const truncated = t.columns.length > MAX_ROWS ? ROW_H : 0;
  return { w, h: HEAD_H + rowCount(t) * ROW_H + 6 + truncated };
}

/**
 * Disposition « voisinage » : la table au centre, celles qui la référencent à
 * gauche, celles qu'elle référence à droite. Déterministe, donc stable d'un
 * affichage à l'autre.
 */
function layoutFocus(
  focus: string,
  byName: Map<string, DbGraphTable>,
  relations: DbRelation[],
  withColumns: boolean,
) {
  const pick = (names: string[]) =>
    [...new Set(names)]
      .filter((t) => t !== focus && byName.has(t))
      .sort()
      .map((t) => byName.get(t)!);
  const incoming = pick(relations.filter((r) => r.to_table === focus).map((r) => r.from_table));
  const outgoing = pick(relations.filter((r) => r.from_table === focus).map((r) => r.to_table));
  const center = byName.get(focus);
  if (!center) return { nodes: [] as Node[], width: 100, height: 100 };

  const gapY = 26;
  const colGap = 150;
  const sized = (list: DbGraphTable[]) =>
    list.map((t) => ({ table: t, ...boxSize(t, withColumns) }));
  const left = sized(incoming);
  const right = sized(outgoing);
  const mid = { table: center, ...boxSize(center, withColumns) };

  const stackH = (l: typeof left) =>
    l.reduce((s, b) => s + b.h, 0) + Math.max(0, l.length - 1) * gapY;
  const height = Math.max(stackH(left), stackH(right), mid.h) + 60;
  const leftW = Math.max(0, ...left.map((b) => b.w));
  const rightW = Math.max(0, ...right.map((b) => b.w));
  const width =
    (left.length ? leftW + colGap : 30) + mid.w + (right.length ? rightW + colGap : 30);
  const centerX = (left.length ? leftW + colGap : 30) + mid.w / 2;

  // Empile une colonne, centrée verticalement sur la hauteur totale.
  const stack = (boxes: typeof left, cx: number): Node[] => {
    let y = (height - stackH(boxes)) / 2;
    return boxes.map((b) => {
      const node: Node = { table: b.table, x: cx, y: y + b.h / 2, w: b.w, h: b.h };
      y += b.h + gapY;
      return node;
    });
  };

  const nodes: Node[] = [
    ...stack(left, leftW / 2 + 10),
    { table: center, x: centerX, y: height / 2, w: mid.w, h: mid.h },
    ...stack(right, width - rightW / 2 - 10),
  ];
  return { nodes, width, height };
}

/**
 * Disposition du schéma complet : simulation force-dirigée (répulsion entre
 * toutes les tables, ressorts le long des relations, gravité vers le centre).
 * Quelques centaines d'itérations suffisent et se calculent en une fois.
 */
function layoutForce(tables: DbGraphTable[], edges: [string, string][], withColumns: boolean) {
  const n = tables.length;
  if (n === 0) return { nodes: [] as Node[], width: 400, height: 300 };

  const sizes = tables.map((t) => boxSize(t, withColumns));
  // Espace de travail proportionnel à la surface occupée par les boîtes.
  const area = sizes.reduce((s, b) => s + b.w * b.h, 0);
  const size = Math.max(900, Math.sqrt(area) * 3.6);

  const radius = size * 0.34;
  const pts = tables.map((t, i) => {
    // Départ sur un cercle : évite les symétries parfaites qui figent la simulation.
    const a = (2 * Math.PI * i) / n;
    return {
      table: t,
      x: size / 2 + radius * Math.cos(a),
      y: size / 2 + radius * Math.sin(a),
      vx: 0,
      vy: 0,
      w: sizes[i].w,
      h: sizes[i].h,
      // Rayon d'encombrement : les boîtes hautes doivent s'écarter davantage.
      r: Math.hypot(sizes[i].w, sizes[i].h) / 2,
    };
  });
  const idx = new Map(tables.map((t, i) => [t.name, i]));

  const iterations = n > 120 ? 200 : 400;
  for (let step = 0; step < iterations; step++) {
    const cool = 1 - step / iterations;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pts[i];
        const b = pts[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // Superposition exacte : on écarte dans une direction arbitraire.
          dx = (i % 7) - 3 || 1;
          dy = (j % 5) - 2 || 1;
          d2 = dx * dx + dy * dy;
        }
        // Distance de répulsion visée : large multiple des demi-diagonales,
        // pour laisser un vrai espace entre les boîtes voisines.
        const want = (a.r + b.r) * 2.2;
        const f = (want * want) / d2;
        const d = Math.sqrt(d2);
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        a.vx += ux;
        a.vy += uy;
        b.vx -= ux;
        b.vy -= uy;
      }
    }
    for (const [from, to] of edges) {
      const i = idx.get(from);
      const j = idx.get(to);
      if (i === undefined || j === undefined || i === j) continue;
      const a = pts[i];
      const b = pts[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const rest = (a.r + b.r) * 1.7;
      const f = ((d - rest) * Math.max(0, d - rest)) / rest / 14;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      a.vx += ux;
      a.vy += uy;
      b.vx -= ux;
      b.vy -= uy;
    }
    for (const p of pts) {
      // Gravité très douce : garde les tables isolées à portée de vue sans
      // contrarier la répulsion qui les écarte.
      p.vx += (size / 2 - p.x) * 0.005;
      p.vy += (size / 2 - p.y) * 0.005;
      const speed = Math.hypot(p.vx, p.vy);
      const max = 40 * cool + 1;
      const k = speed > max ? max / speed : 1;
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.vx = 0;
      p.vy = 0;
    }
  }

  // Recadrage sur le contenu réel.
  const pad = 60;
  const minX = Math.min(...pts.map((p) => p.x - p.w / 2));
  const maxX = Math.max(...pts.map((p) => p.x + p.w / 2));
  const minY = Math.min(...pts.map((p) => p.y - p.h / 2));
  const maxY = Math.max(...pts.map((p) => p.y + p.h / 2));
  const nodes: Node[] = pts.map((p) => ({
    table: p.table,
    x: p.x - minX + pad,
    y: p.y - minY + pad,
    w: p.w,
    h: p.h,
  }));
  return { nodes, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

/** Point où le segment reliant le centre de `a` vers `toward` coupe le bord de `a`. */
function anchor(a: { x: number; y: number; w: number; h: number }, toward: Pt): Pt {
  const dx = toward.x - a.x;
  const dy = toward.y - a.y;
  if (dx === 0 && dy === 0) return { x: a.x, y: a.y };
  const hw = a.w / 2 + 2;
  const hh = a.h / 2 + 2;
  // Facteur d'échelle pour atteindre le bord vertical ou horizontal, au plus proche.
  const t = Math.min(
    dx === 0 ? Infinity : Math.abs(hw / dx),
    dy === 0 ? Infinity : Math.abs(hh / dy),
  );
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** Boîte effective : position (centre) éventuellement déplacée par l'utilisateur. */
interface ENode {
  table: DbGraphTable;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Clé stable d'une jointure (une table peut réutiliser un nom de contrainte). */
const edgeKey = (r: DbRelation) => `${r.from_table}:${r.constraint}`;

/** Distance d'un point au segment [a,b] : place un nouveau point sur le bon brin. */
function distToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Chemin SVG passant par une suite de points. */
const polyPath = (pts: Pt[]) =>
  pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");

/** Signature stable d'une disposition (positions + courbures), arrondie pour
 *  ignorer le bruit sous-pixel. Sert à ne ré-enregistrer qu'en cas de vrai
 *  changement. */
function layoutSig(pos: Record<string, Pt>, wp: Record<string, Pt[]>) {
  const ps = Object.entries(pos)
    .map(([k, p]) => `${k}:${Math.round(p.x)},${Math.round(p.y)}`)
    .sort()
    .join("|");
  const ws = Object.entries(wp)
    .filter(([, a]) => a.length)
    .map(([k, a]) => `${k}:${a.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(";")}`)
    .sort()
    .join("|");
  return `${ps}#${ws}`;
}

export function DbRelationsView({
  state,
  focus,
  onRefresh,
  onOpenTable,
  savedLayout,
  onSaveLayout,
  active,
}: Props) {
  // La disposition n'est modifiable/enregistrable que sur le schéma complet.
  const editable = !focus && !!onSaveLayout;

  const [hover, setHover] = useState<string | null>(null);
  // Jointure sélectionnée (clic) : surligne ses deux colonnes dans les tables.
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [withColumns, setWithColumns] = useState(true);
  // Transformation de la vue : zoom + décalage (en unités de graphe).
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  // Déplacements de tables (coin haut-gauche) et courbures des jointures, par
  // rapport à la disposition automatique.
  const [positions, setPositions] = useState<Record<string, Pt>>({});
  const [waypoints, setWaypoints] = useState<Record<string, Pt[]>>({});
  // Signature de la disposition déjà enregistrée : l'auto-save ne se déclenche
  // que si la disposition courante en diffère réellement (évite toute boucle
  // « persist → recharge → persist » et les écritures inutiles au chargement).
  const savedSig = useRef("");

  type Drag =
    | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
    | { kind: "node"; name: string; sx: number; sy: number; ox: number; oy: number }
    | { kind: "wp"; key: string; index: number; sx: number; sy: number; ox: number; oy: number };
  const drag = useRef<Drag | null>(null);
  // Un glissement au-delà du seuil n'est pas un clic (n'ouvre pas la table).
  const moved = useRef(false);
  const pendingOpen = useRef<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const byName = useMemo(
    () => new Map(state.tables.map((t) => [t.name, t])),
    [state.tables],
  );

  const layout = useMemo(() => {
    if (focus) return layoutFocus(focus, byName, state.relations, withColumns);
    const edges = state.relations
      .filter((r) => r.from_table !== r.to_table)
      .map((r) => [r.from_table, r.to_table] as [string, string]);
    return layoutForce(state.tables, edges, withColumns);
  }, [focus, byName, state.relations, state.tables, withColumns]);

  // Charge la disposition sauvegardée (schéma complet). Un rechargement de
  // données ou le passage colonnes/noms conservent ces positions.
  useEffect(() => {
    if (!editable || !savedLayout) {
      setPositions({});
      setWaypoints({});
      savedSig.current = layoutSig({}, {});
      return;
    }
    const pos: Record<string, Pt> = {};
    for (const [k, v] of Object.entries(savedLayout.positions ?? {})) {
      pos[k] = { x: v[0], y: v[1] };
    }
    const wp: Record<string, Pt[]> = {};
    for (const [k, v] of Object.entries(savedLayout.waypoints ?? {})) {
      wp[k] = v.map(([x, y]) => ({ x, y }));
    }
    setPositions(pos);
    setWaypoints(wp);
    // Mémorise ce qui est déjà enregistré : pas de ré-enregistrement au chargement.
    savedSig.current = layoutSig(pos, wp);
  }, [editable, savedLayout]);

  // Boîtes effectives : position automatique, remplacée par le déplacement
  // utilisateur s'il existe. `layout.nodes` fournit le centre par défaut.
  const enodes = useMemo<ENode[]>(
    () =>
      layout.nodes.map((n) => {
        const tl = positions[n.table.name];
        if (!tl) return { table: n.table, x: n.x, y: n.y, w: n.w, h: n.h };
        return { table: n.table, x: tl.x + n.w / 2, y: tl.y + n.h / 2, w: n.w, h: n.h };
      }),
    [layout, positions],
  );
  const enodeByName = useMemo(
    () => new Map(enodes.map((n) => [n.table.name, n])),
    [enodes],
  );

  // Relations traçables : les deux extrémités doivent être posées.
  const edges = useMemo(
    () =>
      state.relations
        .filter((r) => enodeByName.has(r.from_table) && enodeByName.has(r.to_table))
        .filter((r) => !focus || r.from_table === focus || r.to_table === focus),
    [state.relations, enodeByName, focus],
  );

  // Cadre du dessin (viewBox) : englobe la disposition automatique + les
  // positions/points sauvegardés. On fige la disposition sauvegardée « au
  // chargement » (re-capturée seulement quand `layout` change : nouvelle base
  // ou bascule colonnes/noms). Ainsi le cadre ne bouge ni au glisser ni à
  // l'enregistrement — aucun saut. Les tables hors cadre restent atteignables.
  const framedFor = useRef<unknown>(null);
  const savedAtLoad = useRef<DbGraphLayout | null>(null);
  if (framedFor.current !== layout) {
    framedFor.current = layout;
    savedAtLoad.current = savedLayout ?? null;
  }
  const frame = useMemo(() => {
    const saved = savedAtLoad.current;
    const rects = layout.nodes.map((n) => {
      const tl = saved?.positions?.[n.table.name];
      const x = tl ? tl[0] : n.x - n.w / 2;
      const y = tl ? tl[1] : n.y - n.h / 2;
      return { x, y, w: n.w, h: n.h };
    });
    const wps = saved ? Object.values(saved.waypoints ?? {}).flat() : [];
    const xs = rects.map((r) => r.x).concat(rects.map((r) => r.x + r.w), wps.map((p) => p[0]));
    const ys = rects.map((r) => r.y).concat(rects.map((r) => r.y + r.h), wps.map((p) => p[1]));
    if (xs.length === 0) return { x: 0, y: 0, w: layout.width, h: layout.height };
    const pad = 80;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    return {
      x: minX,
      y: minY,
      w: Math.max(...xs) + pad - minX,
      h: Math.max(...ys) + pad - minY,
    };
  }, [layout]);

  // Une nouvelle disposition (données/colonnes) remet la vue à plat.
  useEffect(() => {
    setView({ zoom: 1, x: 0, y: 0 });
    setSelEdge(null);
  }, [layout]);

  // Jointure sélectionnée + colonnes à surligner (par « table.colonne »).
  const selection = useMemo(() => {
    const r = selEdge ? edges.find((e) => edgeKey(e) === selEdge) : undefined;
    if (!r) return null;
    const cols = new Set<string>();
    r.from_columns.forEach((c) => cols.add(`${r.from_table}.${c.toLowerCase()}`));
    r.to_columns.forEach((c) => cols.add(`${r.to_table}.${c.toLowerCase()}`));
    const tables = new Set([r.from_table, r.to_table]);
    return { key: selEdge!, cols, tables };
  }, [selEdge, edges]);

  /** Échelle « meet » du viewBox : pixels écran par unité de graphe. */
  const meetScale = () => {
    const el = canvasRef.current;
    if (!el) return 1;
    return Math.min(el.clientWidth / frame.w, el.clientHeight / frame.h);
  };
  /** Position du curseur en coordonnées viewBox (avant zoom/décalage courant). */
  const cursorInView = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    if (!el) return { s: 1, vx: 0, vy: 0 };
    const rect = el.getBoundingClientRect();
    const s = Math.min(rect.width / frame.w, rect.height / frame.h);
    const tx = (rect.width - frame.w * s) / 2;
    const ty = (rect.height - frame.h * s) / 2;
    return {
      s,
      vx: frame.x + (e.clientX - rect.left - tx) / s,
      vy: frame.y + (e.clientY - rect.top - ty) / s,
    };
  };
  /** Position du curseur en coordonnées de graphe (après zoom/décalage). */
  const cursorGraph = (e: { clientX: number; clientY: number }): Pt => {
    const { vx, vy } = cursorInView(e);
    return { x: (vx - view.x) / view.zoom, y: (vy - view.y) / view.zoom };
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const { vx, vy } = cursorInView(e);
    setView((t) => {
      const zoom = Math.min(4, Math.max(0.1, t.zoom * (e.deltaY < 0 ? 1.12 : 0.89)));
      // Garde le point sous le curseur immobile : le décalage compense le zoom.
      const k = zoom / t.zoom;
      return { zoom, x: vx - k * (vx - t.x), y: vy - k * (vy - t.y) };
    });
  };

  // Fond : glisser = déplacer la vue.
  const onCanvasDown = (e: React.MouseEvent) => {
    moved.current = false;
    pendingOpen.current = null;
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  };
  // Boîte : glisser = déplacer la table (schéma complet), clic = ouvrir.
  const onNodeDown = (e: React.MouseEvent, n: ENode) => {
    e.stopPropagation();
    moved.current = false;
    pendingOpen.current = n.table.name;
    if (editable) {
      drag.current = {
        kind: "node",
        name: n.table.name,
        sx: e.clientX,
        sy: e.clientY,
        ox: n.x - n.w / 2,
        oy: n.y - n.h / 2,
      };
    } else {
      // Vue par table : pas de déplacement, mais le fond reste déplaçable.
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    }
  };
  const onWpDown = (e: React.MouseEvent, key: string, index: number, p: Pt) => {
    e.stopPropagation();
    moved.current = false;
    pendingOpen.current = null;
    drag.current = { kind: "wp", key, index, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
    if (d.kind === "pan") {
      const s = meetScale();
      setView((t) => ({ ...t, x: d.ox + dx / s, y: d.oy + dy / s }));
      return;
    }
    // Table / point de courbure : conversion pixels → graphe (échelle × zoom).
    const k = meetScale() * view.zoom;
    const nx = d.ox + dx / k;
    const ny = d.oy + dy / k;
    if (d.kind === "node") {
      setPositions((p) => ({ ...p, [d.name]: { x: nx, y: ny } }));
    } else {
      setWaypoints((w) => {
        const arr = (w[d.key] ?? []).slice();
        arr[d.index] = { x: nx, y: ny };
        return { ...w, [d.key]: arr };
      });
    }
  };
  const onMouseUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !moved.current) {
      if (pendingOpen.current) onOpenTable(pendingOpen.current);
      // Clic dans le vide (déplacement du fond sans bouger) : désélectionne.
      else if (d.kind === "pan") setSelEdge(null);
    }
    pendingOpen.current = null;
  };
  const endDrag = () => {
    drag.current = null;
    pendingOpen.current = null;
  };

  // Double-clic sur une jointure : ajoute un point de courbure sous le curseur.
  const addWaypoint = (e: React.MouseEvent, r: DbRelation) => {
    if (!editable) return;
    e.stopPropagation();
    const g = cursorGraph(e);
    const key = edgeKey(r);
    // Insère au plus près du segment cliqué pour garder un tracé cohérent.
    setWaypoints((w) => {
      const arr = (w[key] ?? []).slice();
      const a = enodeByName.get(r.from_table)!;
      const b = enodeByName.get(r.to_table)!;
      const chain: Pt[] = [{ x: a.x, y: a.y }, ...arr, { x: b.x, y: b.y }];
      let best = arr.length;
      let bestD = Infinity;
      for (let i = 0; i < chain.length - 1; i++) {
        const d = distToSegment(g, chain[i], chain[i + 1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      arr.splice(best, 0, g);
      return { ...w, [key]: arr };
    });
  };
  // Double-clic sur un point : le retire.
  const removeWaypoint = (e: React.MouseEvent, key: string, index: number) => {
    e.stopPropagation();
    setWaypoints((w) => {
      const arr = (w[key] ?? []).filter((_, i) => i !== index);
      const next = { ...w };
      if (arr.length) next[key] = arr;
      else delete next[key];
      return next;
    });
  };
  // Retire tous les points d'une liaison : la rend à nouveau droite.
  const straightenEdge = (key: string) =>
    setWaypoints((w) => {
      if (!w[key]) return w;
      const next = { ...w };
      delete next[key];
      return next;
    });

  const resetLayout = () => {
    setPositions({});
    setWaypoints({});
  };

  // Touche Suppr : redresse la liaison sélectionnée (retire tous ses points).
  useEffect(() => {
    if (!editable || !active || !selEdge) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      )
        return;
      e.preventDefault();
      straightenEdge(selEdge);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editable, active, selEdge]);

  // ----- Enregistrement automatique -----
  // On enregistre les tables *déplacées* et les courbures ; les autres suivent
  // la disposition automatique (déterministe) au rechargement.
  const doSave = () => {
    if (!editable || !onSaveLayout) return;
    const outPos: Record<string, [number, number]> = {};
    for (const [k, p] of Object.entries(positions)) outPos[k] = [p.x, p.y];
    const outWp: Record<string, [number, number][]> = {};
    for (const [k, arr] of Object.entries(waypoints)) {
      if (arr.length) outWp[k] = arr.map((p) => [p.x, p.y]);
    }
    onSaveLayout({ positions: outPos, waypoints: outWp });
  };
  const saveRef = useRef(doSave);
  saveRef.current = doSave;
  // Miroirs de l'état, lus dans le timer différé (valeurs stabilisées).
  const posRef = useRef(positions);
  posRef.current = positions;
  const wpRef = useRef(waypoints);
  wpRef.current = waypoints;

  const [savedFlash, setSavedFlash] = useState(false);
  // Confirmation avant de tout replacer (perte des déplacements/courbures).
  const [confirmReset, setConfirmReset] = useState(false);
  const hasChanges =
    Object.keys(positions).length > 0 || Object.keys(waypoints).length > 0;
  // Enregistre automatiquement, après une courte pause (regroupe les
  // déplacements). La signature est calculée à l'échéance du timer, sur l'état
  // stabilisé : les changements dus au chargement n'entraînent aucune écriture.
  useEffect(() => {
    if (!editable) return;
    const id = setTimeout(() => {
      const sig = layoutSig(posRef.current, wpRef.current);
      if (sig === savedSig.current) return;
      savedSig.current = sig;
      saveRef.current();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1400);
    }, 500);
    return () => clearTimeout(id);
  }, [positions, waypoints, editable]);

  const count = enodes.length;

  return (
    <div className="dbgraph">
      <div className="dbdata-head">
        <div className="dbdata-title">
          <h3>{focus ? focus : "Schéma de la base"}</h3>
          <span className="muted">
            {focus
              ? `${Math.max(0, count - 1)} table${count > 2 ? "s" : ""} liée${count > 2 ? "s" : ""}`
              : `${count} table${count > 1 ? "s" : ""} · ${edges.length} relation${
                  edges.length > 1 ? "s" : ""
                }`}
          </span>
        </div>
        <div className="dbdata-head-actions">
          <span className="muted dbgraph-hint">
            {editable
              ? "glisser une table · lien : double-clic = point, clic droit = redresser"
              : "molette : zoom · glisser : déplacer"}
          </span>
          <button
            className={"btn btn-ghost btn-sm" + (withColumns ? " on" : "")}
            onClick={() => setWithColumns((v) => !v)}
            title="Afficher ou masquer les colonnes dans les boîtes"
          >
            {withColumns ? "▤ Colonnes" : "▭ Noms seuls"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setView({ zoom: 1, x: 0, y: 0 })}
            title="Recentrer la vue"
          >
            ⌖ Recentrer
          </button>
          {editable && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => (hasChanges ? setConfirmReset(true) : resetLayout())}
              title="Revenir à la disposition automatique"
            >
              ⤢ Réorganiser
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={onRefresh}
            disabled={state.loading}
            title="Relire le schéma"
          >
            ↻ Rafraîchir
          </button>
          {editable && (
            <span
              className={"dbgraph-autosave" + (savedFlash ? " on" : "")}
              title="La disposition est enregistrée automatiquement"
            >
              {savedFlash ? "✓ enregistré" : "enregistrement auto"}
            </span>
          )}
        </div>
      </div>

      <div className="dbdata-body">
        {state.error && <div className="banner-error dbdata-error">{state.error}</div>}
        {state.loading ? (
          <div className="branch-loading">
            <span className="spinner" /> Lecture du schéma…
          </div>
        ) : !state.loaded ? (
          !state.error && <div className="empty">Schéma non chargé.</div>
        ) : count === 0 ? (
          <div className="empty">Aucune table.</div>
        ) : edges.length === 0 && focus ? (
          <div className="empty">
            Aucune clé étrangère entre « {focus} » et une autre table.
          </div>
        ) : (
          <div
            className={"dbgraph-canvas" + (editable ? " editable" : "")}
            ref={canvasRef}
            onWheel={onWheel}
            onMouseDown={onCanvasDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={endDrag}
          >
            {/* Le viewBox cadre le graphe entier à l'ouverture ; molette et
                glisser agissent ensuite par-dessus. */}
            <svg
              width="100%"
              height="100%"
              viewBox={`${Math.round(frame.x)} ${Math.round(frame.y)} ${Math.round(
                frame.w,
              )} ${Math.round(frame.h)}`}
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <marker
                  id="dbgraph-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill="var(--border)" />
                </marker>
                <marker
                  id="dbgraph-arrow-on"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)" />
                </marker>
              </defs>
              <g transform={`translate(${view.x}, ${view.y}) scale(${view.zoom})`}>
                {edges.map((r, i) => {
                  const a = enodeByName.get(r.from_table)!;
                  const b = enodeByName.get(r.to_table)!;
                  const key = edgeKey(r);
                  const sel = selection?.key === key;
                  const on =
                    sel || (hover !== null && (r.from_table === hover || r.to_table === hover));
                  const cls = "dbgraph-edge" + (on ? " on" : "") + (sel ? " sel" : "");
                  const label = `${r.from_table}(${r.from_columns.join(", ")}) → ${
                    r.to_table
                  }(${r.to_columns.join(", ")}) · ${r.constraint}`;
                  const wps = waypoints[key] ?? [];
                  // Clic simple : sélectionne la jointure (bascule).
                  const onClick = (e: React.MouseEvent) => {
                    e.stopPropagation();
                    setSelEdge((cur) => (cur === key ? null : key));
                  };
                  // Clic droit : redresse la liaison (retire tous ses points).
                  const onContextMenu = (e: React.MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (editable) straightenEdge(key);
                  };
                  if (a.table.name === b.table.name) {
                    // Auto-référence : petite boucle au-dessus de la boîte.
                    const x = a.x + a.w / 4;
                    const y = a.y - a.h / 2;
                    const d = `M${x} ${y} c 14 -26, 46 -26, 56 -2`;
                    return (
                      <g key={i}>
                        <path
                          className="dbgraph-edge-hit"
                          d={d}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={onClick}
                          onContextMenu={onContextMenu}
                        >
                          <title>{label}</title>
                        </path>
                        <path
                          className={cls}
                          d={d}
                          markerEnd={`url(#dbgraph-arrow${on ? "-on" : ""})`}
                        />
                      </g>
                    );
                  }
                  // Tracé : ancre sur `a` orientée vers le 1er point (ou `b`),
                  // ancre sur `b` orientée depuis le dernier point (ou `a`).
                  const first = wps[0] ?? { x: b.x, y: b.y };
                  const last = wps[wps.length - 1] ?? { x: a.x, y: a.y };
                  const p1 = anchor(a, first);
                  const p2 = anchor(b, last);
                  const chain = [p1, ...wps, p2];
                  return (
                    <g key={i} className={"dbgraph-edgegroup" + (on ? " on" : "")}>
                      {/* Trait large invisible : cible facile pour clic/double-clic. */}
                      <path
                        className="dbgraph-edge-hit"
                        d={polyPath(chain)}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={onClick}
                        onDoubleClick={(e) => addWaypoint(e, r)}
                        onContextMenu={onContextMenu}
                      >
                        <title>
                          {label} · clic : voir les colonnes liées
                          {editable
                            ? " · double-clic : ajouter un point · clic droit : redresser"
                            : ""}
                        </title>
                      </path>
                      <path
                        className={cls}
                        d={polyPath(chain)}
                        markerEnd={`url(#dbgraph-arrow${on ? "-on" : ""})`}
                      />
                      {editable &&
                        wps.map((p, wi) => (
                          <circle
                            key={wi}
                            className="dbgraph-wp"
                            cx={p.x}
                            cy={p.y}
                            r={4}
                            onMouseDown={(e) => onWpDown(e, key, wi, p)}
                            onDoubleClick={(e) => removeWaypoint(e, key, wi)}
                          >
                            <title>Glisser pour courber · double-clic pour retirer</title>
                          </circle>
                        ))}
                    </g>
                  );
                })}
                {enodes.map((n) => {
                  const t = n.table;
                  const shown = t.columns.slice(0, MAX_ROWS);
                  const hidden = t.columns.length - shown.length;
                  const linked = selection?.tables.has(t.name);
                  return (
                    <g
                      key={t.name}
                      className={
                        "dbgraph-node" +
                        (t.name === focus ? " focus" : "") +
                        (t.name === hover ? " on" : "") +
                        (linked ? " linked" : "")
                      }
                      transform={`translate(${Math.round(n.x - n.w / 2)}, ${Math.round(
                        n.y - n.h / 2,
                      )})`}
                      onMouseEnter={() => setHover(t.name)}
                      onMouseLeave={() => setHover(null)}
                      onMouseDown={(e) => onNodeDown(e, n)}
                    >
                      <title>
                        {t.name} — {t.columns.length} colonne
                        {t.columns.length > 1 ? "s" : ""}
                        {editable ? " · glisser pour déplacer · clic pour ouvrir" : " · cliquer pour ouvrir"}
                      </title>
                      <rect className="dbgraph-box" width={n.w} height={n.h} rx={5} />
                      {/* Bandeau : coins arrondis en haut seulement, d'où le path. */}
                      <path
                        className="dbgraph-head"
                        d={`M0 5 a5 5 0 0 1 5 -5 h${n.w - 10} a5 5 0 0 1 5 5 v${
                          HEAD_H - 5
                        } h${-n.w} z`}
                      />
                      <text className="dbgraph-title" x={n.w / 2} y={HEAD_H / 2 + 4}>
                        {t.name}
                      </text>
                      {withColumns &&
                        shown.map((c, i) => {
                          const ico = typeIcon(c);
                          const y = HEAD_H + 4 + i * ROW_H + ROW_H / 2 + 3;
                          const hl = selection?.cols.has(`${t.name}.${c.name.toLowerCase()}`);
                          return (
                            <g key={c.name}>
                              {hl && (
                                <rect
                                  className="dbgraph-col-hl"
                                  x={1.5}
                                  y={HEAD_H + 4 + i * ROW_H}
                                  width={n.w - 3}
                                  height={ROW_H}
                                  rx={3}
                                />
                              )}
                              <text className={"dbgraph-ico " + ico.cls} x={PAD_X} y={y}>
                                {ico.label}
                              </text>
                              <text
                                className={
                                  "dbgraph-col" +
                                  (c.primary_key ? " pk" : "") +
                                  (c.foreign_key ? " fk" : "") +
                                  (hl ? " hl" : "")
                                }
                                x={ICON_W + PAD_X}
                                y={y}
                              >
                                {c.name}
                              </text>
                            </g>
                          );
                        })}
                      {withColumns && hidden > 0 && (
                        <text
                          className="dbgraph-more"
                          x={PAD_X}
                          y={HEAD_H + 4 + shown.length * ROW_H + ROW_H / 2 + 3}
                        >
                          + {hidden} autre{hidden > 1 ? "s" : ""}…
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        )}
      </div>

      {confirmReset && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmReset(false)}>
          <div className="modal dbgraph-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Réorganiser le schéma ?</h3>
            </div>
            <p className="dbgraph-confirm-text">
              Toutes les tables seront replacées automatiquement. Vos déplacements
              et les courbures de liaisons seront <b>supprimés</b> et ne pourront pas
              être récupérés.
            </p>
            <div className="modal-footer">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmReset(false)}
                autoFocus
              >
                Annuler
              </button>
              <button
                className="btn btn-stop btn-sm"
                onClick={() => {
                  resetLayout();
                  setConfirmReset(false);
                }}
              >
                ⤢ Réorganiser
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
