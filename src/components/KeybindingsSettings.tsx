import { useEffect, useMemo, useState } from "react";
import {
  comboFromEvent,
  comboKeys,
  isReserved,
  RESERVED,
  setCapturing,
  type Bindable,
} from "../keybindings";

interface Props {
  bindables: Bindable[];
  /** id d'action → combinaison. */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

function Keys({ combo }: { combo: string }) {
  return (
    <span className="kb-keys">
      {comboKeys(combo).map((k, i) => (
        <kbd key={i} className="kb-key">
          {k}
        </kbd>
      ))}
    </span>
  );
}

// Onglet Réglages → Raccourcis : tableau de toutes les fonctionnalités, façon
// réglages de jeu vidéo. Clic sur la case de touche → appuyer sur la combinaison.
export function KeybindingsSettings({ bindables, value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [capture, setCapture] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  // Groupes dépliés (Général + séquences générales ouverts par défaut).
  const [open, setOpen] = useState<Set<string>>(() => new Set(["app", "gseq"]));

  const labelOf = (id: string) => {
    const b = bindables.find((x) => x.id === id);
    if (!b) return id;
    return b.group === "app" || b.group === "gseq" ? b.label : `${b.groupLabel} · ${b.label}`;
  };

  // Capture d'une combinaison : écoute en phase de capture pour passer avant
  // tous les autres raccourcis (Échap global compris).
  useEffect(() => {
    if (!capture) return;
    setCapturing(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setCapture(null);
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey) {
        const next = { ...value };
        delete next[capture];
        onChange(next);
        setCapture(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // touche de modification seule : on attend la suite
      if (isReserved(combo)) {
        setNotice({ id: capture, text: `${combo} est réservé par l'application.`, error: true });
        return;
      }
      const next = { ...value };
      const prev = Object.keys(next).find((k) => k !== capture && next[k] === combo);
      if (prev) delete next[prev];
      next[capture] = combo;
      onChange(next);
      setNotice(prev ? { id: capture, text: `${combo} retiré de « ${labelOf(prev)} ».` } : null);
      setCapture(null);
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".kb-bind.capturing")) setCapture(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      setCapturing(false);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [capture, value, onChange]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, { label: string; items: Bindable[] }>();
    for (const b of bindables) {
      const hay = `${b.groupLabel} ${b.label} ${value[b.id] ?? ""}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const g = map.get(b.group) ?? { label: b.groupLabel, items: [] };
      g.items.push(b);
      map.set(b.group, g);
    }
    return [...map.entries()];
  }, [bindables, query, value]);

  // Raccourcis orphelins (projet ou action supprimés) : signalés pour nettoyage.
  const orphans = Object.keys(value).filter((id) => !bindables.some((b) => b.id === id));
  const assigned = Object.keys(value).length - orphans.length;

  const toggle = (g: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  return (
    <div className="kb-settings">
      <div className="kb-toolbar">
        <input
          className="kb-search"
          placeholder="Rechercher une action, un projet, une touche…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <span className="muted">{assigned} raccourci(s) attribué(s)</span>
        {orphans.length > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            title="Retirer les raccourcis dont l'action ou le projet n'existe plus"
            onClick={() => {
              const next = { ...value };
              orphans.forEach((id) => delete next[id]);
              onChange(next);
            }}
          >
            Nettoyer ({orphans.length} obsolète{orphans.length > 1 ? "s" : ""})
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          disabled={Object.keys(value).length === 0}
          onClick={() => {
            if (confirm("Retirer tous les raccourcis personnalisés ?")) onChange({});
          }}
        >
          Tout réinitialiser
        </button>
      </div>

      {groups.length === 0 && <div className="empty">Aucune action ne correspond.</div>}

      {groups.map(([g, { label, items }]) => {
        const isOpen = open.has(g) || !!query.trim();
        const count = items.filter((b) => value[b.id]).length;
        return (
          <div className="kb-group" key={g}>
            <button className="kb-group-head" onClick={() => toggle(g)}>
              <span className="kb-caret">{isOpen ? "▾" : "▸"}</span>
              <span className="kb-group-name">{label}</span>
              {count > 0 && <span className="chip">{count}</span>}
            </button>
            {isOpen && (
              <div className="kb-rows">
                {items.map((b) => {
                  const combo = value[b.id];
                  const isCap = capture === b.id;
                  return (
                    <div className={"kb-row" + (isCap ? " on" : "")} key={b.id}>
                      <span className="kb-label">{b.label}</span>
                      <button
                        className={"kb-bind" + (isCap ? " capturing" : "") + (combo ? "" : " empty")}
                        onClick={() => {
                          setNotice(null);
                          setCapture(isCap ? null : b.id);
                        }}
                        title="Cliquer puis appuyer sur la combinaison — Échap : annuler, Suppr : effacer"
                      >
                        {isCap ? (
                          <span className="kb-wait">Appuyez sur une touche…</span>
                        ) : combo ? (
                          <Keys combo={combo} />
                        ) : (
                          "—"
                        )}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm kb-clear"
                        disabled={!combo}
                        title="Effacer ce raccourci"
                        onClick={() => {
                          const next = { ...value };
                          delete next[b.id];
                          onChange(next);
                        }}
                      >
                        ×
                      </button>
                      {notice?.id === b.id && (
                        <span className={"kb-notice" + (notice.error ? " error" : "")}>
                          {notice.text}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="kb-group">
        <button className="kb-group-head" onClick={() => toggle("reserved")}>
          <span className="kb-caret">{open.has("reserved") ? "▾" : "▸"}</span>
          <span className="kb-group-name">Raccourcis intégrés (non modifiables)</span>
        </button>
        {open.has("reserved") && (
          <div className="kb-rows">
            {RESERVED.map((r) => (
              <div className="kb-row kb-reserved" key={r.combo}>
                <span className="kb-label">{r.label}</span>
                <span className="kb-bind static">
                  <Keys combo={r.combo} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="muted kb-help">
        Les touches simples (sans Ctrl / Alt / Win) n'agissent pas pendant la saisie dans un champ ;
        les combinaisons avec Ctrl, Alt, Win ou une touche F fonctionnent partout.
      </p>
    </div>
  );
}
