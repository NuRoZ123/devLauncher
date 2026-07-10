import { getVersion } from "@tauri-apps/api/app";

// Slug "owner/repo" injecté au build par la CI (VITE_GITHUB_REPO), avec repli sur
// le dépôt public connu — ainsi les builds locaux vérifient aussi les mises à jour.
const REPO = import.meta.env.VITE_GITHUB_REPO || "NuRoZ123/devLauncher";

export interface UpdateInfo {
  /** Dernière version publiée (sans le "v"). */
  version: string;
  /** Version actuellement installée. */
  current: string;
  /** Page de la release sur GitHub. */
  url: string;
}

// Compare deux versions "a.b.c" : vrai si `latest` est strictement plus récente.
function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map((n) => parseInt(n, 10) || 0);
  const b = current.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Interroge l'API GitHub pour la dernière release et renvoie les infos de mise à
 * jour si une version plus récente existe, sinon `null`. Ne lève jamais.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!REPO) return null;
  let current: string;
  try {
    current = await getVersion();
  } catch {
    return null;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    if (!latest || !isNewer(latest, current)) return null;
    return {
      version: latest,
      current,
      url: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
    };
  } catch {
    return null;
  }
}
