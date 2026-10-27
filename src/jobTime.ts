import type { JobStatus, QJob } from "./types";

function finished(s: JobStatus) {
  return s === "done" || s === "failed" || s === "cancelled";
}

/** Horodate début / fin d'un élément selon son statut (sans toucher s'il est déjà daté). */
function stamp<T extends { status: JobStatus; startedAt?: number; endedAt?: number }>(x: T, now: number): T {
  if (x.status === "running" && x.startedAt == null) return { ...x, startedAt: now };
  // Une étape annulée avant d'avoir démarré n'a pas de durée (pas de startedAt).
  if (finished(x.status) && x.endedAt == null) return { ...x, endedAt: now };
  return x;
}

/**
 * Applique les horodatages aux tâches et à leurs étapes : appelé sur chaque
 * nouvel état de la file, il date le passage à « en cours » puis à « terminé ».
 */
export function stampJobs(jobs: QJob[]): QJob[] {
  const now = Date.now();
  let changed = false;
  const out = jobs.map((j) => {
    let steps = j.steps;
    const stamped = j.steps.map((s) => stamp(s, now));
    if (stamped.some((s, i) => s !== j.steps[i])) steps = stamped;
    const next = stamp(steps === j.steps ? j : { ...j, steps }, now);
    if (next !== j) changed = true;
    return next;
  });
  return changed ? out : jobs;
}

/** Durée lisible : « 850 ms », « 12,3 s », « 2 min 05 s », « 1 h 03 min ». */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0).replace(".", ",")} s`;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return `${m} min ${String(sec).padStart(2, "0")} s`;
}

/** Durée d'un élément daté : écoulée s'il tourne encore, totale s'il est fini. */
export function elapsed(x: { startedAt?: number; endedAt?: number }, now: number): number | null {
  if (x.startedAt == null) return null;
  return (x.endedAt ?? now) - x.startedAt;
}
