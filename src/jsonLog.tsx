// Détection et rendu des lignes de log JSON (objet ou tableau) : coloration et
// indentation, à la manière d'un « pretty print ».
import type { ReactNode } from "react";

/** Au-delà, on ne tente pas de parser (une ligne énorme figerait le rendu). */
const MAX_LEN = 200_000;

export interface JsonHit {
  /** Texte précédant le JSON sur la ligne (horodatage, niveau, nom du logger…). */
  prefix: string;
  value: unknown;
  /** Texte suivant le JSON (rare : virgule, point…). */
  suffix: string;
}

function parseContainer(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text);
    // Les scalaires (« 42 », « "ok" », « true ») restent du texte brut.
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cherche un objet/tableau JSON dans une ligne (sans séquences ANSI) : la ligne
 * entière, sinon à partir du premier « { » ou « [ » (logs préfixés). Le JSON
 * doit aller jusqu'à la fin de la ligne, à un éventuel caractère près.
 */
export function findJson(line: string): JsonHit | null {
  if (line.length < 2 || line.length > MAX_LEN) return null;
  const end = line.trimEnd();
  const last = end[end.length - 1];
  const close = last === "}" || last === "]" ? end.length : -1;
  const closeTrail = close === -1 && /[}\]][,;.]$/.test(end) ? end.length - 1 : -1;
  const stop = close !== -1 ? close : closeTrail;
  if (stop === -1) return null;

  for (let i = 0; i < stop; i++) {
    const c = line[i];
    if (c !== "{" && c !== "[") continue;
    // Le crochet fermant doit correspondre au type d'ouverture.
    if ((c === "{") !== (end[stop - 1] === "}")) continue;
    const value = parseContainer(line.slice(i, stop));
    if (value !== undefined) return { prefix: line.slice(0, i), value, suffix: line.slice(stop) };
    // « [INFO] {…} » : le premier « [ » n'ouvre pas le JSON, on essaie le suivant.
  }
  return null;
}

const IND = "  ";

function render(v: unknown, depth: number, out: ReactNode[]) {
  const push = (cls: string, text: string) => out.push(<span className={cls}>{text}</span>);
  if (v === null) return push("jl-null", "null");
  switch (typeof v) {
    case "string":
      return push("jl-str", JSON.stringify(v));
    case "number":
      return push("jl-num", String(v));
    case "boolean":
      return push("jl-bool", String(v));
  }
  const pad = IND.repeat(depth + 1);
  if (Array.isArray(v)) {
    if (!v.length) return push("jl-punc", "[]");
    push("jl-punc", "[");
    v.forEach((item, i) => {
      out.push("\n" + pad);
      render(item, depth + 1, out);
      if (i < v.length - 1) push("jl-punc", ",");
    });
    out.push("\n" + IND.repeat(depth));
    return push("jl-punc", "]");
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return push("jl-punc", "{}");
  push("jl-punc", "{");
  entries.forEach(([k, item], i) => {
    out.push("\n" + pad);
    push("jl-key", JSON.stringify(k));
    push("jl-punc", ": ");
    render(item, depth + 1, out);
    if (i < entries.length - 1) push("jl-punc", ",");
  });
  out.push("\n" + IND.repeat(depth));
  push("jl-punc", "}");
}

/** Nœuds colorés et indentés d'une valeur JSON (à placer dans un conteneur `white-space: pre`). */
export function renderJson(value: unknown): ReactNode[] {
  const out: ReactNode[] = [];
  render(value, 0, out);
  return out;
}
