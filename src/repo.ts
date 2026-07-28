/** Liens web dérivés de l'URL d'un dépôt et de sa branche courante. */
export interface RepoLinks {
  platform: "github" | "gitlab";
  /** Page d'accueil du dépôt. */
  home: string;
  /** Liste des merge/pull requests. */
  requests: string;
  /** Liste des issues. */
  issues: string;
  /** Pipelines (GitLab) ou Actions (GitHub). */
  pipelines: string;
  /** Code de la branche courante (null si branche inconnue). */
  tree: string | null;
  /** Historique de commits de la branche courante (null si inconnue). */
  commits: string | null;
  /** Création d'une MR/PR pour la branche courante (null si inconnue). */
  newRequest: string | null;
}

/** Branches non exploitables pour un lien contextuel (vide, tiret, HEAD détaché). */
const INVALID_BRANCH = new Set(["", "—", "HEAD"]);

function hostOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1].toLowerCase() : "";
}

/** Encode une branche pour un segment de chemin (préserve les « / »). */
function encPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/**
 * Construit les liens web utiles d'un dépôt à partir de son URL de base et de la
 * branche courante. Détecte GitHub via le host ; tout le reste (dont GitLab
 * self-hosted) suit la convention GitLab. Renvoie null si l'URL est vide.
 */
export function buildRepoLinks(baseUrl: string, branch?: string): RepoLinks | null {
  let base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;

  const isGithub = /(^|\.)github\.com$/.test(hostOf(base));
  const raw = (branch ?? "").trim();
  const b = INVALID_BRANCH.has(raw) ? null : raw;

  if (isGithub) {
    return {
      platform: "github",
      home: base,
      requests: `${base}/pulls`,
      issues: `${base}/issues`,
      pipelines: `${base}/actions`,
      tree: b ? `${base}/tree/${encPath(b)}` : null,
      commits: b ? `${base}/commits/${encPath(b)}` : null,
      newRequest: b ? `${base}/compare/${encPath(b)}?expand=1` : null,
    };
  }
  // GitLab (gitlab.com et instances self-hosted).
  return {
    platform: "gitlab",
    home: base,
    requests: `${base}/-/merge_requests`,
    issues: `${base}/-/issues`,
    pipelines: `${base}/-/pipelines`,
    tree: b ? `${base}/-/tree/${encPath(b)}` : null,
    commits: b ? `${base}/-/commits/${encPath(b)}` : null,
    newRequest: b
      ? `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(b)}`
      : null,
  };
}
