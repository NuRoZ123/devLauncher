import type { Changelist, ProjectChangelists } from "./types";

/**
 * Changelists git façon JetBrains, gérées côté DevLauncher (git n'en a pas) :
 * chaque fichier modifié appartient à une liste nommée. Une liste « exclue »
 * (ex. « Ne jamais committer ») regroupe les modifications locales permanentes :
 * elles ne comptent pas dans le compteur de la carte et ne sont pas prises par
 * « Tout ajouter à l'index ».
 */

export const DEFAULT_LIST_ID = "default";
const DEFAULT_LIST: Changelist = { id: DEFAULT_LIST_ID, name: "Modifications", excluded: false };

/** Listes du projet, la liste par défaut toujours présente et en tête. */
export function listsOf(pc: ProjectChangelists | undefined): Changelist[] {
  const lists = pc?.lists ?? [];
  const def = lists.find((l) => l.id === DEFAULT_LIST_ID) ?? DEFAULT_LIST;
  return [def, ...lists.filter((l) => l.id !== DEFAULT_LIST_ID)];
}

/** Liste d'un fichier (liste par défaut si non affecté ou liste disparue). */
export function listIdOf(pc: ProjectChangelists | undefined, path: string): string {
  const id = pc?.files[path];
  return id && pc?.lists.some((l) => l.id === id) ? id : DEFAULT_LIST_ID;
}

/** Ensemble des ids de listes exclues. */
export function excludedIds(pc: ProjectChangelists | undefined): Set<string> {
  return new Set(listsOf(pc).filter((l) => l.excluded).map((l) => l.id));
}

/** Répartit des fichiers modifiés entre « vraies » modifications et exclues. */
export function splitCounts(files: string[], pc: ProjectChangelists | undefined) {
  const ex = excludedIds(pc);
  let excluded = 0;
  if (ex.size) for (const f of files) if (ex.has(listIdOf(pc, f))) excluded++;
  return { real: files.length - excluded, excluded };
}

export const emptyChangelists = (): ProjectChangelists => ({ lists: [{ ...DEFAULT_LIST }], files: {} });

export const newListId = () => "cl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
