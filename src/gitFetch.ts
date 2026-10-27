import { api } from "./api";

// Fetchs en cours, par dossier de dépôt. Partagé entre le fetch automatique
// (tableau de bord) et la page git : deux `git fetch` / `git pull` simultanés
// sur le même dépôt se disputeraient les verrous des refs.
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Lance un fetch du dépôt et renvoie les branches distantes. Un fetch déjà en
 * cours sur ce dépôt est d'abord attendu (jamais deux en parallèle).
 */
export function fetchRepo(git: string, path: string) {
  const prev = inFlight.get(path) ?? Promise.resolve();
  const p = prev.then(() => api.gitRemoteBranches(git, path, true));
  const settled = p.catch(() => {});
  inFlight.set(path, settled);
  void settled.then(() => {
    if (inFlight.get(path) === settled) inFlight.delete(path);
  });
  return p;
}

/** Attend la fin d'un fetch éventuellement en cours sur ce dépôt. */
export async function awaitFetch(path: string): Promise<void> {
  const p = inFlight.get(path);
  if (p) await p;
}

/** Vrai si un fetch tourne déjà sur ce dépôt. */
export function isFetching(path: string): boolean {
  return inFlight.has(path);
}
