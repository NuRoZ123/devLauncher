import { useEffect, useMemo, useState } from "react";
import type { Project } from "../types";
import {
  BADGES,
  TIERS,
  UNIQUES,
  badgeValue,
  currentStreak,
  dayKey,
  fmtDuration,
  hasNew,
  markSeen,
  onUnlock,
  sessionNow,
  useStats,
  type CounterKey,
  type Stats,
  type Unlock,
} from "../stats";

const fmtDate = (t: number) =>
  new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });

/** Re-rend chaque seconde (durée de session en direct). */
function useNow(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

/** Page 🏆 : temps passé, activité, badges à paliers et succès uniques. */
export function StatsView({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const s = useStats();
  useNow();
  const [help, setHelp] = useState(false);
  // Page vue : plus de point « nouveau » sur le trophée (et à la sortie, pour
  // ce qui a été débloqué pendant qu'elle était ouverte).
  useEffect(() => {
    markSeen();
    return markSeen;
  }, []);
  const today = s.days[dayKey(new Date())] ?? 0;
  const streak = currentStreak(s);

  const names = useMemo(() => {
    const m: Record<string, string> = {};
    const walk = (ps: Project[]) =>
      ps.forEach((p) => {
        m[p.id] = p.name;
        if (p.children) walk(p.children);
      });
    walk(projects);
    return m;
  }, [projects]);

  const topServices = useMemo(
    () =>
      Object.entries(s.serviceMs)
        .filter(([, ms]) => ms >= 60_000)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
    [s.serviceMs],
  );
  const maxService = topServices[0]?.[1] ?? 1;
  const tierCount = BADGES.reduce((n, b) => n + (s.badges[b.id]?.length ?? 0), 0);
  const uniqueCount = UNIQUES.filter((u) => s.uniques[u.id]).length;

  return (
    <div className="stats-page">
      <div className="stats-head">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          ← Retour
        </button>
        <h2>🏆 Statistiques</h2>
        <span className="stats-since">depuis le {fmtDate(s.firstSeen)}</span>
      </div>

      <div className="stats-tiles">
        <Tile label="Session en cours" value={fmtDuration(sessionNow(), true)} />
        <Tile label="Aujourd'hui" value={fmtDuration(today)} />
        <Tile
          label="Total ouvert"
          value={fmtDuration(s.totalMs)}
          sub={`dont ${fmtDuration(s.focusMs)} au premier plan`}
        />
        <Tile label="Série" value={`${streak} jour${streak > 1 ? "s" : ""}`} />
        <Tile label="Plus longue session" value={fmtDuration(s.longestSessionMs)} />
      </div>

      <section className="stats-section">
        <h3>Activité</h3>
        <Heatmap days={s.days} counts={s.dayCounts} />
      </section>

      {topServices.length > 0 && (
        <section className="stats-section">
          <h3>Temps de service par projet</h3>
          <div className="stats-bars">
            {topServices.map(([id, ms]) => (
              <div key={id} className="stats-bar-row">
                <span className="stats-bar-name" title={names[id] ?? id}>
                  {names[id] ?? id}
                </span>
                <span className="stats-bar-track">
                  <span className="stats-bar-fill" style={{ width: `${(ms / maxService) * 100}%` }} />
                </span>
                <span className="stats-bar-val">{fmtDuration(ms)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="stats-section">
        <h3>
          Badges <span className="stats-count">{tierCount} / {BADGES.length * TIERS.length}</span>
          <button
            className={"stats-help-btn" + (help ? " active" : "")}
            onClick={() => setHelp((h) => !h)}
            title="Comment ça marche ?"
          >
            ?
          </button>
        </h3>
        {help && (
          <div className="stats-help">
            <p>
              Chaque badge suit une seule mesure et se débloque par <b>paliers</b> successifs :
              {TIERS.map((t, i) => (
                <span key={t} className={`badge-tier tier-${i + 1}`}>
                  {t}
                </span>
              ))}
              . La couleur du cercle indique le dernier palier atteint ; la barre montre la progression vers
              le suivant.
            </p>
            <p>
              Le compteur <b>
                {tierCount} / {BADGES.length * TIERS.length}
              </b>{" "}
              compte les paliers obtenus ({BADGES.length} badges × {TIERS.length} paliers) : un badge en
              Argent vaut 2 (Bronze + Argent).
            </p>
            <table className="stats-help-table">
              <thead>
                <tr>
                  <th>Badge</th>
                  {TIERS.map((t) => (
                    <th key={t}>{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {BADGES.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.icon} {b.name} <span className="stats-help-unit">({b.unit})</span>
                    </td>
                    {b.thresholds.map((t, i) => (
                      <td key={i}>{t.toLocaleString("fr-FR")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Les <b>succès</b> plus bas n'ont qu'un niveau : obtenus une fois pour toutes. Tout est compté
              depuis l'installation de cette fonctionnalité, en local sur ce poste.
            </p>
          </div>
        )}
        <div className="badge-grid">
          {BADGES.map((b) => {
            const v = badgeValue(b, s);
            const got = s.badges[b.id] ?? [];
            const tier = got.length; // 0 = aucun palier
            const next = b.thresholds[tier];
            const prev = tier > 0 ? b.thresholds[tier - 1] : 0;
            const pct = next ? Math.min(100, ((v - prev) / (next - prev)) * 100) : 100;
            return (
              <div key={b.id} className={"badge-card" + (tier ? ` tier-${tier}` : " tier-0")}>
                <div className="badge-medal">{b.icon}</div>
                <div className="badge-body">
                  <div className="badge-name">
                    {b.name}
                    {tier > 0 && <span className="badge-tier">{TIERS[tier - 1]}</span>}
                  </div>
                  <div className="badge-desc">{b.desc}</div>
                  <div className="badge-progress">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <div className="badge-meta">
                    {next ? (
                      <>
                        {v.toLocaleString("fr-FR")} / {next.toLocaleString("fr-FR")} {b.unit} → {TIERS[tier]}
                      </>
                    ) : (
                      <>{v.toLocaleString("fr-FR")} {b.unit} — palier maximal</>
                    )}
                    {tier > 0 && <span className="badge-date">obtenu le {fmtDate(got[tier - 1])}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="stats-section">
        <h3>
          Succès <span className="stats-count">{uniqueCount} / {UNIQUES.length}</span>
        </h3>
        <div className="unique-grid">
          {UNIQUES.map((u) => {
            const at = s.uniques[u.id];
            return (
              <div key={u.id} className={"unique-card" + (at ? " done" : "")}>
                <span className="unique-icon">{u.icon}</span>
                <div>
                  <div className="unique-name">{u.name}</div>
                  <div className="unique-desc">{u.desc}</div>
                  {at && <div className="badge-date">obtenu le {fmtDate(at)}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stats-tile">
      <div className="stats-tile-label">{label}</div>
      <div className="stats-tile-value">{value}</div>
      {sub && <div className="stats-tile-sub">{sub}</div>}
    </div>
  );
}

/** Frise des 53 dernières semaines (une case par jour, intensité = heures ouvertes). */
/** Libellés des compteurs dans l'infobulle de la frise. */
const DAY_LABELS: [CounterKey, string, string][] = [
  ["commits", "commit", "commits"],
  ["pushes", "push", "push"],
  ["services", "service lancé", "services lancés"],
  ["conflicts", "conflit résolu", "conflits résolus"],
  ["sqlQueries", "requête SQL", "requêtes SQL"],
  ["commitsViewed", "commit consulté", "commits consultés"],
];

function dayTitle(key: string, ms: number, counts?: Partial<Record<CounterKey, number>>) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const lines = [date, ms > 0 ? `${fmtDuration(ms)} d'appli ouverte` : "Appli non utilisée"];
  for (const [k, one, many] of DAY_LABELS) {
    const n = counts?.[k] ?? 0;
    if (n > 0) lines.push(`${n} ${n > 1 ? many : one}`);
  }
  return lines.join("\n");
}

function Heatmap({
  days,
  counts,
}: {
  days: Record<string, number>;
  counts: Stats["dayCounts"];
}) {
  const weeks = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    // Début sur un lundi, 52 semaines pleines avant la semaine en cours.
    start.setDate(start.getDate() - 52 * 7 - ((start.getDay() + 6) % 7));
    const out: { key: string; ms: number; future: boolean }[][] = [];
    const d = new Date(start);
    while (d <= end || out[out.length - 1]?.length < 7) {
      if ((d.getDay() + 6) % 7 === 0) out.push([]);
      const key = dayKey(d);
      out[out.length - 1].push({ key, ms: days[key] ?? 0, future: d > end });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [days]);
  const level = (ms: number) => (ms <= 0 ? 0 : ms < 2 * 3.6e6 ? 1 : ms < 5 * 3.6e6 ? 2 : ms < 8 * 3.6e6 ? 3 : 4);
  return (
    <div className="heatmap">
      {weeks.map((w, i) => (
        <div key={i} className="heatmap-col">
          {w.map((c) => (
            <span
              key={c.key}
              className={"heatmap-cell" + (c.future ? " future" : ` l${level(c.ms)}`)}
              title={c.future ? "" : dayTitle(c.key, c.ms, counts[c.key])}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Trophée du tableau de bord : infobulle session / aujourd'hui, point si nouveau badge. */
export function TrophyButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const s = useStats();
  // L'infobulle se lit au survol : une mise à jour par minute suffit.
  useNow(60_000);
  const today = s.days[dayKey(new Date())] ?? 0;
  const fresh = hasNew(s);
  return (
    <button
      className={"brand-trophy" + (active ? " active" : "") + (fresh ? " fresh" : "")}
      onClick={onClick}
      title={
        `Session : ${fmtDuration(sessionNow())} · Aujourd'hui : ${fmtDuration(today)}` +
        (fresh ? "\nNouveau badge débloqué !" : "")
      }
    >
      🏆
      {fresh && <span className="brand-trophy-dot" />}
    </button>
  );
}

/** Notifications discrètes de déblocage (coin bas droit, quelques secondes). */
export function StatsToasts({ onOpen }: { onOpen: () => void }) {
  const [items, setItems] = useState<(Unlock & { key: number })[]>([]);
  useEffect(
    () =>
      onUnlock((u) => {
        const key = Date.now() + Math.random();
        setItems((l) => [...l, { ...u, key }]);
        window.setTimeout(() => setItems((l) => l.filter((x) => x.key !== key)), 4000);
      }),
    [],
  );
  if (items.length === 0) return null;
  return (
    <div className="stats-toasts">
      {items.map((u) => (
        <button
          key={u.key}
          className={"stats-toast" + (u.tier !== undefined ? ` tier-${u.tier + 1}` : "")}
          onClick={onOpen}
        >
          <span className="stats-toast-icon">{u.icon}</span>
          {u.title}
          {u.tier !== undefined && <span className="badge-tier">{TIERS[u.tier]}</span>}
        </button>
      ))}
    </div>
  );
}
