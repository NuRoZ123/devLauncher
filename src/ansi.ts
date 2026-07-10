// Conversion des séquences ANSI SGR (couleurs) en segments stylés.

export interface AnsiSeg {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

// Palette 16 couleurs (lisible sur fond sombre).
const FG: Record<number, string> = {
  30: "#5c6370",
  31: "#e06c75",
  32: "#98c379",
  33: "#e5c07b",
  34: "#61afef",
  35: "#c678dd",
  36: "#56b6c2",
  37: "#cdd3de",
  90: "#7f848e",
  91: "#ff7b72",
  92: "#b5e890",
  93: "#f2cc60",
  94: "#79c0ff",
  95: "#d2a8ff",
  96: "#76e0e8",
  97: "#ffffff",
};

function ansi256(n: number): string {
  if (n < 16) {
    const base = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
    return FG[base[n]] ?? "#cdd3de";
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const conv = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${conv(r)},${conv(g)},${conv(b)})`;
}

type State = Omit<AnsiSeg, "text">;

function applySgr(state: State, params: string) {
  const codes = params
    .split(";")
    .map((p) => (p === "" ? 0 : parseInt(p, 10)))
    .filter((n) => !Number.isNaN(n));

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) {
      state.fg = undefined;
      state.bg = undefined;
      state.bold = false;
      state.dim = false;
      state.italic = false;
      state.underline = false;
    } else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 39) state.fg = undefined;
    else if (code === 49) state.bg = undefined;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.fg = FG[code];
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      state.bg = FG[code - 10];
    } else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) {
        state[target] = ansi256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        const r = codes[i + 2] ?? 0;
        const g = codes[i + 3] ?? 0;
        const b = codes[i + 4] ?? 0;
        state[target] = `rgb(${r},${g},${b})`;
        i += 4;
      }
    }
  }
}

const ESC = String.fromCharCode(27);

export function parseAnsi(line: string): AnsiSeg[] {
  if (!line.includes(ESC)) return [{ text: line }];
  const segs: AnsiSeg[] = [];
  const state: State = {};
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      segs.push({ text: buf, ...state });
      buf = "";
    }
  };
  while (i < line.length) {
    if (line[i] === ESC && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && !/[a-zA-Z]/.test(line[j])) j++;
      const final = line[j];
      const params = line.slice(i + 2, j);
      if (final === "m") {
        flush();
        applySgr(state, params);
      }
      i = j + 1;
      continue;
    }
    buf += line[i];
    i++;
  }
  flush();
  return segs;
}
