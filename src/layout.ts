import type { Project, ProjectFolder } from "./types";

/**
 * Organisation du tableau de bord : liste à plat ordonnable + dossiers virtuels.
 *
 * Deux données persistées dans la config :
 * - `folders` : les dossiers, chacun portant ses `projectIds` (membres ordonnés) ;
 * - `layout`  : l'ordre des entrées à la *racine* — soit un id de projet « libre »
 *   (hors dossier), soit une référence de dossier `"folder:<id>"`.
 *
 * Un projet apparaît à un seul endroit : la racine OU les membres d'un dossier.
 * Toutes les fonctions de mutation sont pures et renvoient un nouvel état.
 */

export const FOLDER_PREFIX = "folder:";

/** Clé de layout d'un dossier (`"folder:<id>"`). */
export function folderKey(id: string): string {
  return FOLDER_PREFIX + id;
}
export function isFolderKey(key: string): boolean {
  return key.startsWith(FOLDER_PREFIX);
}
export function folderIdOf(key: string): string {
  return key.slice(FOLDER_PREFIX.length);
}

/**
 * Un nœud de rendu : un projet, ou un dossier et ses enfants (récursif — un
 * dossier peut contenir des projets ET d'autres dossiers).
 */
export type LayoutNode =
  | { type: "project"; project: Project }
  | { type: "folder"; folder: ProjectFolder; children: LayoutNode[] };

/** État persistable (le sous-ensemble de Config qui nous intéresse). */
export interface LayoutState {
  folders: ProjectFolder[];
  layout: string[];
}

function genId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Construit l'arbre de rendu ordonné (récursif). `layout` et les `projectIds` de
 * chaque dossier contiennent des *clés enfants* : un id de projet, ou `"folder:<id>"`
 * pour un sous-dossier. Tolère les entrées obsolètes et les cycles (via `seen`), et
 * ajoute en fin de racine les dossiers/projets non référencés (nouveaux au scan) —
 * migration gratuite : layout vide ⇒ liste à plat, ordre de scan.
 */
export function resolveLayout(
  projects: Project[],
  folders: ProjectFolder[],
  layout: string[],
): LayoutNode[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const folderById = new Map(folders.map((f) => [f.id, f]));
  // Clés déjà référencées quelque part comme enfant (masquées de la racine/doublons).
  const assigned = new Set<string>();
  for (const f of folders) for (const k of f.projectIds) assigned.add(k);

  const seen = new Set<string>();
  const resolveKeys = (keys: string[]): LayoutNode[] => {
    const out: LayoutNode[] = [];
    for (const key of keys) {
      if (seen.has(key)) continue; // doublon / cycle
      if (isFolderKey(key)) {
        const f = folderById.get(folderIdOf(key));
        if (!f) continue;
        seen.add(key);
        out.push({ type: "folder", folder: f, children: resolveKeys(f.projectIds) });
      } else {
        const p = byId.get(key);
        if (!p) continue;
        seen.add(key);
        out.push({ type: "project", project: p });
      }
    }
    return out;
  };

  const nodes = resolveKeys(layout);
  // Dossiers jamais référencés (créés hors layout) : en fin de racine.
  for (const f of folders) {
    const key = folderKey(f.id);
    if (!seen.has(key) && !assigned.has(key)) {
      seen.add(key);
      nodes.push({ type: "folder", folder: f, children: resolveKeys(f.projectIds) });
    }
  }
  // Projets nouvellement scannés (non référencés) : en fin de racine.
  for (const p of projects) {
    if (!seen.has(p.id) && !assigned.has(p.id)) {
      seen.add(p.id);
      nodes.push({ type: "project", project: p });
    }
  }
  return nodes;
}

/** Crée un dossier vide, ajouté en *tête* de racine (visible immédiatement). */
export function createFolder(state: LayoutState, name: string): LayoutState {
  const folder: ProjectFolder = { id: `folder-${genId()}`, name: name.trim() || "Dossier", projectIds: [] };
  return {
    folders: [...state.folders, folder],
    layout: [folderKey(folder.id), ...state.layout],
  };
}

function patchFolder(
  state: LayoutState,
  folderId: string,
  patch: Partial<ProjectFolder>,
): LayoutState {
  return {
    ...state,
    folders: state.folders.map((f) => (f.id === folderId ? { ...f, ...patch } : f)),
  };
}

export function renameFolder(state: LayoutState, folderId: string, name: string): LayoutState {
  return patchFolder(state, folderId, { name: name.trim() || "Dossier" });
}

export function setFolderColor(state: LayoutState, folderId: string, color?: string): LayoutState {
  return patchFolder(state, folderId, { color });
}

export function toggleFolderCollapsed(state: LayoutState, folderId: string): LayoutState {
  const f = state.folders.find((x) => x.id === folderId);
  return patchFolder(state, folderId, { collapsed: !f?.collapsed });
}

/**
 * Supprime un dossier : ses enfants (projets et sous-dossiers) remontent d'un
 * niveau, à la place qu'occupait le dossier dans son parent (racine ou dossier).
 */
export function deleteFolder(state: LayoutState, folderId: string): LayoutState {
  const key = folderKey(folderId);
  const folder = state.folders.find((f) => f.id === folderId);
  const children = folder?.projectIds ?? [];
  // Remplace `key` par les enfants dans la liste où il figure (une seule).
  const splice = (list: string[]): string[] => {
    const i = list.indexOf(key);
    return i < 0 ? list : [...list.slice(0, i), ...children, ...list.slice(i + 1)];
  };
  return {
    folders: state.folders
      .filter((f) => f.id !== folderId)
      .map((f) => ({ ...f, projectIds: splice(f.projectIds) })),
    layout: splice(state.layout),
  };
}
