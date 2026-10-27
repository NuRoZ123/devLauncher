/**
 * Fusion 3 voies ligne à ligne (base / ours / theirs), sur le modèle de l'outil
 * de résolution de conflits JetBrains : le fichier est découpé en « changements »
 * relatifs à l'ancêtre commun. Un changement présent d'un seul côté (ou identique
 * des deux côtés) n'est pas conflictuel et peut être appliqué directement ; un
 * changement divergent des deux côtés est un conflit.
 */

/** Plage modifiée : lignes [aStart, aEnd) de `a` remplacées par [bStart, bEnd) de `b`. */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Diff ligne à ligne (algorithme de Myers, O((N+M)·D)) après retrait du préfixe
 * et du suffixe communs. Renvoie les plages modifiées dans l'ordre.
 */
export function diffLines(a: string[], b: string[]): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ aStart: pre, aEnd: pre + n, bStart: pre, bEnd: pre + m }];

  // Les lignes sont d'abord converties en entiers (comparaisons rapides).
  const ids = new Map<string, number>();
  const idOf = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const ai = A.map(idOf);
  const bi = B.map(idOf);

  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && ai[x] === bi[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  // Remontée du chemin : on collecte les paires de lignes égales (diagonales).
  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  matches.reverse();

  const hunks: Hunk[] = [];
  let pa = 0;
  let pb = 0;
  for (const [mx, my] of [...matches, [n, m] as [number, number]]) {
    if (mx > pa || my > pb) hunks.push({ aStart: pre + pa, aEnd: pre + mx, bStart: pre + pb, bEnd: pre + my });
    pa = mx + 1;
    pb = my + 1;
  }
  return hunks;
}

/** Type d'un changement, pour la coloration (vert/bleu/gris/rouge façon JetBrains). */
export type ChangeKind = "added" | "modified" | "deleted";

export interface MergeChunk {
  id: number;
  /** "left" / "right" : changement d'un seul côté ; "both" : même changement des
   *  deux côtés ; "conflict" : changements divergents. */
  type: "left" | "right" | "both" | "conflict";
  base: [number, number];
  left: [number, number];
  right: [number, number];
  /** Contenu correspondant de chaque côté (lignes). */
  baseLines: string[];
  leftLines: string[];
  rightLines: string[];
  leftKind: ChangeKind | null;
  rightKind: ChangeKind | null;
  /** Conflit « simple » : les deux côtés touchent des lignes différentes, la
   *  fusion automatique est possible (bouton baguette magique). */
  simple: string[] | null;
}

const kindOf = (baseLen: number, sideLen: number): ChangeKind =>
  baseLen === 0 ? "added" : sideLen === 0 ? "deleted" : "modified";

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/** Deux plages de base se chevauchent-elles strictement (hors simple contact) ? */
function strictOverlap(x: Hunk, y: Hunk): boolean {
  const xe = x.aStart === x.aEnd;
  const ye = y.aStart === y.aEnd;
  if (xe && ye) return x.aStart === y.aStart;
  if (xe) return y.aStart < x.aStart && x.aStart < y.aEnd;
  if (ye) return x.aStart < y.aStart && y.aStart < x.aEnd;
  return x.aStart < y.aEnd && y.aStart < x.aEnd;
}

/** Mots (identifiants, nombres) d'une ligne, sans ponctuation ni blancs. */
const wordsOf = (s: string) => new Set(s.match(/[\p{L}\p{N}_$]+/gu) ?? []);

/**
 * Deux lignes sont « la même instruction » si elles partagent la majorité de
 * leurs mots (indice de Jaccard ≥ 0,5). Les lignes trop courtes (accolade,
 * ligne vide…) ne sont pas comparées : elles se ressemblent toutes.
 */
function similarLines(a: string, b: string): boolean {
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (wa.size < 3 || wb.size < 3) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter) >= 0.5;
}

/** Applique des hunks (triés, disjoints) à la plage de base [from, to). */
function applyHunks(
  base: string[],
  from: number,
  to: number,
  parts: { h: Hunk; lines: string[] }[],
): string[] {
  const out: string[] = [];
  let pos = from;
  for (const { h, lines } of parts) {
    out.push(...base.slice(pos, h.aStart), ...lines);
    pos = h.aEnd;
  }
  out.push(...base.slice(pos, to));
  return out;
}

/** Découpe la fusion base/left/right en changements ordonnés. */
export function buildChunks(base: string[], left: string[], right: string[]): MergeChunk[] {
  const lh = diffLines(base, left).map((h) => ({ h, side: 0 as const }));
  const rh = diffLines(base, right).map((h) => ({ h, side: 1 as const }));
  const all = [...lh, ...rh].sort((p, q) => p.h.aStart - q.h.aStart || p.h.aEnd - q.h.aEnd);

  const chunks: MergeChunk[] = [];
  // Décalage cumulé (lignes côté - lignes base) des hunks déjà traités.
  let dl = 0;
  let dr = 0;
  let i = 0;
  while (i < all.length) {
    const group = [all[i]];
    let end = all[i].h.aEnd;
    let j = i + 1;
    // Un changement qui touche (ou chevauche) le groupe courant s'y rattache :
    // comme git, deux modifications adjacentes forment un seul bloc.
    while (j < all.length && all[j].h.aStart <= end) {
      group.push(all[j]);
      end = Math.max(end, all[j].h.aEnd);
      j++;
    }
    i = j;
    const start = group[0].h.aStart;
    const gl = group.filter((g) => g.side === 0);
    const gr = group.filter((g) => g.side === 1);
    const deltaL = gl.reduce((s, g) => s + (g.h.bEnd - g.h.bStart) - (g.h.aEnd - g.h.aStart), 0);
    const deltaR = gr.reduce((s, g) => s + (g.h.bEnd - g.h.bStart) - (g.h.aEnd - g.h.aStart), 0);
    const L: [number, number] = [start + dl, end + dl + deltaL];
    const R: [number, number] = [start + dr, end + dr + deltaR];
    dl += deltaL;
    dr += deltaR;

    const baseLines = base.slice(start, end);
    const leftLines = left.slice(L[0], L[1]);
    const rightLines = right.slice(R[0], R[1]);
    let type: MergeChunk["type"];
    if (gr.length === 0) type = "left";
    else if (gl.length === 0) type = "right";
    else if (sameLines(leftLines, rightLines)) type = "both";
    else type = "conflict";

    let simple: string[] | null = null;
    // Lignes apportées par chaque côté dans ce bloc.
    const addedL = gl.flatMap((g) => left.slice(g.h.bStart, g.h.bEnd));
    const addedR = gr.flatMap((g) => right.slice(g.h.bStart, g.h.bEnd));
    if (
      type === "conflict" &&
      !gl.some((a) => gr.some((b) => strictOverlap(a.h, b.h))) &&
      // Même instruction réécrite des deux côtés mais alignée sur des lignes de
      // base différentes (ex. un import modifié à gauche, remplacé à droite) :
      // la combinaison ligne à ligne produirait un doublon. On laisse le conflit.
      !addedL.some((l) => addedR.some((r) => similarLines(l, r)))
    ) {
      const parts = group
        .map((g) => ({
          h: g.h,
          lines: (g.side === 0 ? left : right).slice(g.h.bStart, g.h.bEnd),
        }))
        .sort((p, q) => p.h.aStart - q.h.aStart || p.h.aEnd - q.h.aEnd);
      simple = applyHunks(base, start, end, parts);
    }

    chunks.push({
      id: chunks.length,
      type,
      base: [start, end],
      left: L,
      right: R,
      baseLines,
      leftLines,
      rightLines,
      leftKind: type === "right" ? null : kindOf(end - start, L[1] - L[0]),
      rightKind: type === "left" ? null : kindOf(end - start, R[1] - R[0]),
      simple,
    });
  }
  return chunks;
}

/** Découpe un texte en lignes (fins de ligne normalisées en \n). */
export const toLines = (s: string | null): string[] => (s ?? "").replace(/\r\n/g, "\n").split("\n");

/** Portion de ligne différente : colonnes [start, end) (caractères) de la ligne `line`. */
export interface InlineRange {
  line: number;
  start: number;
  end: number;
}

/** Au-delà, le diff mot à mot d'un bloc est jugé trop coûteux et ignoré. */
const MAX_INLINE_TOKENS = 12000;

/** Découpe en mots (identifiants/nombres), blancs, et caractères isolés. */
const tokenize = (s: string) => s.match(/[\p{L}\p{N}_$]+|[ \t]+|\n|[^\p{L}\p{N}_$ \t\n]/gu) ?? [];

/**
 * Diff mot à mot entre deux blocs de lignes (comme le surlignage « by word » de
 * JetBrains) : renvoie, pour chaque côté, les portions qui diffèrent de l'autre.
 * Les différences de blancs seuls ne sont pas surlignées.
 */
export function inlineDiff(a: string[], b: string[]): { a: InlineRange[]; b: InlineRange[] } | null {
  const ta = tokenize(a.join("\n"));
  const tb = tokenize(b.join("\n"));
  if (ta.length + tb.length > MAX_INLINE_TOKENS) return null;
  const hunks = diffLines(ta, tb);

  // Position (ligne, colonne) de début de chaque token.
  const positions = (tokens: string[]) => {
    const pos: { line: number; col: number }[] = [];
    let line = 0;
    let col = 0;
    for (const t of tokens) {
      pos.push({ line, col });
      if (t === "\n") {
        line++;
        col = 0;
      } else col += t.length;
    }
    pos.push({ line, col });
    return pos;
  };
  const pa = positions(ta);
  const pb = positions(tb);

  const ranges = (tokens: string[], pos: { line: number; col: number }[], from: number, to: number, out: InlineRange[]) => {
    for (let i = from; i < to; i++) {
      const t = tokens[i];
      if (t === "\n" || /^[ \t]+$/.test(t)) continue;
      const p = pos[i];
      const last = out[out.length - 1];
      // Fusionne avec la portion précédente si contiguë (ou séparée par des blancs).
      if (last && last.line === p.line && i > from && last.end >= p.col - (tokens[i - 1]?.length ?? 0)) {
        last.end = p.col + t.length;
      } else out.push({ line: p.line, start: p.col, end: p.col + t.length });
    }
  };

  const ra: InlineRange[] = [];
  const rb: InlineRange[] = [];
  for (const h of hunks) {
    ranges(ta, pa, h.aStart, h.aEnd, ra);
    ranges(tb, pb, h.bStart, h.bEnd, rb);
  }
  return { a: ra, b: rb };
}
