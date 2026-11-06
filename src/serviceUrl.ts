// URL locale d'un service / front : http(s)://localhost:<port><chemin>.
// Le schéma et le chemin se règlent par projet (clic droit sur la puce du port,
// ou Réglages → Projets) et sont stockés dans config.service_urls.
import type { Project, ServiceUrl } from "./types";

/** Le projet expose-t-il une URL locale ouvrable (service ou front avec port) ? */
export const hasServiceUrl = (p: Project) =>
  p.port != null && (p.kind === "service" || p.kind === "front");

/** Normalise un chemin saisi : "" ou "/api", "api" → "/api". */
export function normalizePath(path: string | undefined): string {
  const t = (path ?? "").trim();
  if (!t) return "";
  return t.startsWith("/") || t.startsWith("?") || t.startsWith("#") ? t : "/" + t;
}

/** URL complète du service, null si le projet n'a pas de port. */
export function serviceUrlFor(p: Project, cfg?: ServiceUrl): string | null {
  if (p.port == null) return null;
  return `${cfg?.https ? "https" : "http"}://localhost:${p.port}${normalizePath(cfg?.path)}`;
}

/** Réglage « vide » (http, sans chemin) : inutile de le stocker. */
export const isDefaultServiceUrl = (cfg: ServiceUrl) => !cfg.https && !normalizePath(cfg.path);
