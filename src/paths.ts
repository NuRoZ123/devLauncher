/** Dernier segment d'un chemin (nom de fichier/dossier), séparateurs Windows ou POSIX. */
export function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** Dossier parent d'un chemin (sans le dernier segment). */
export function dirname(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  const idx = p.search(/[\\/][^\\/]*$/);
  return idx >= 0 ? p.slice(0, idx) : p;
}

/** Égalité de chemins tolérante : séparateurs unifiés, casse ignorée (Windows), slash final ignoré. */
export function samePath(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}
