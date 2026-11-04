import { Fragment, memo, useEffect, useRef, useState } from "react";
import { parseAnsi, type AnsiSeg } from "../ansi";
import { findJson, renderJson } from "../jsonLog";
import type { LogLine } from "../types";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/** Nombre max de lignes rendues dans le DOM (le tampon complet reste en mémoire). */
const RENDER_MAX = 1500;

interface Tab {
  id: string;
  name: string;
  running: boolean;
}

/** Console d'un projet (sous-onglet) : « Lancement » ou une console libre. */
export interface SubTab {
  key: string;
  name: string;
  /** « Lancement » : sortie du service, ni renommable ni fermable. */
  launch?: boolean;
  /** Service démarré (Lancement) ou tâche en cours (console libre). */
  busy?: boolean;
}

interface Props {
  tabs: Tab[];
  active: string | null;
  setActive: (id: string) => void;
  lines: LogLine[];
  onClear: () => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onRunCommand: (target: string, command: string) => void;
  /** Retour à la ligne des lignes longues (sinon défilement horizontal). */
  wrap: boolean;
  /** Lignes JSON affichées colorées et indentées. */
  prettyJson: boolean;
  /** Fourni quand la liste des projets est masquée : bouton pour la rouvrir. */
  onShowProjects?: () => void;
  /** Consoles du projet actif et celle affichée. */
  subs: SubTab[];
  activeSub: string | null;
  setActiveSub: (key: string) => void;
  onAddSub: () => void;
  onCloseSub: (key: string) => void;
  onRenameSub: (key: string, name: string) => void;
}

/** Ligne des consoles du projet actif : sélection, renommage (double-clic), fermeture, ajout. */
function SubTabs({
  subs,
  active,
  onSelect,
  onAdd,
  onClose,
  onRename,
}: {
  subs: SubTab[];
  active: string | null;
  onSelect: (key: string) => void;
  onAdd: () => void;
  onClose: (key: string) => void;
  onRename: (key: string, name: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (editing && draft.trim()) onRename(editing, draft.trim());
    setEditing(null);
  };
  return (
    <div className="console-subtabs">
      {subs.map((s) =>
        editing === s.key ? (
          <input
            key={s.key}
            className="console-subtab-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <div
            key={s.key}
            className={"console-subtab" + (s.key === active ? " active" : "")}
            onClick={() => onSelect(s.key)}
            onDoubleClick={() => {
              if (s.launch) return;
              setDraft(s.name);
              setEditing(s.key);
            }}
            onMouseDown={(e) => {
              if (e.button === 1 && !s.launch) {
                e.preventDefault();
                onClose(s.key);
              }
            }}
            title={s.launch ? "Sortie du service" : "Double-clic pour renommer"}
          >
            {s.busy && (s.launch ? <span className="dot dot-run" /> : <span className="spinner spinner-xs" />)}
            {s.name}
            {!s.launch && (
              <button
                className="tab-close"
                title="Fermer la console (son contenu est effacé)"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.key);
                }}
              >
                ×
              </button>
            )}
          </div>
        ),
      )}
      <button className="console-subtab-add" onClick={onAdd} title="Nouvelle console pour ce projet">
        +
      </button>
    </div>
  );
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour12: false });
}

function AnsiText({ segs }: { segs: AnsiSeg[] }) {
  return (
    <>
      {segs.map((seg, k) => (
        <span
          key={k}
          style={{
            color: seg.fg,
            background: seg.bg,
            fontWeight: seg.bold ? 700 : undefined,
            opacity: seg.dim ? 0.7 : undefined,
            fontStyle: seg.italic ? "italic" : undefined,
            textDecoration: seg.underline ? "underline" : undefined,
          }}
        >
          {seg.text}
        </span>
      ))}
    </>
  );
}

// Mémoïsée : une ligne déjà affichée n'est ni re-parsée (ANSI, JSON) ni re-rendue
// lors des flushs suivants — seul l'ajout de nouvelles lignes coûte.
const LogRow = memo(function LogRow({ l, prettyJson }: { l: LogLine; prettyJson: boolean }) {
  const segs = parseAnsi(l.line);
  // JSON cherché sur le texte sans couleurs ANSI : le rendu stylé les remplace.
  const json = prettyJson ? findJson(segs.map((s) => s.text).join("")) : null;
  return (
    <div className={"log-line log-" + l.stream + (json ? " log-json" : "")}>
      <span className="log-time">{fmtTime(l.ts)}</span>
      <span className="log-text">
        {json ? (
          <>
            {json.prefix}
            {renderJson(json.value).map((n, k) => (
              <Fragment key={k}>{n}</Fragment>
            ))}
            {json.suffix}
          </>
        ) : (
          <AnsiText segs={segs} />
        )}
      </span>
    </div>
  );
});

/** Un onglet console triable (dnd-kit). L'onglet entier est la poignée ; un seuil
 *  d'activation laisse passer les clics (sélection) et le clic-molette (fermeture). */
function SortableTab({
  t,
  active,
  onSelect,
  onClose,
}: {
  t: Tab;
  active: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: t.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={"console-tab" + (t.id === active ? " active" : "") + (isDragging ? " dragging" : "")}
      onClick={() => onSelect(t.id)}
      onMouseDown={(e) => {
        // clic molette = fermer l'onglet
        if (e.button === 1) {
          e.preventDefault();
          onClose(t.id);
        }
      }}
      title={t.id}
      {...attributes}
      {...listeners}
    >
      <span className={"dot " + (t.running ? "dot-run" : "dot-stop")} />
      <span className="console-tab-name">{t.name}</span>
      <button
        className="tab-close"
        title="Fermer l'onglet (réapparaît via « Console »)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(t.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

export function Console({
  tabs,
  active,
  setActive,
  lines,
  onClear,
  onClose,
  onReorder,
  onRunCommand,
  wrap,
  prettyJson,
  onShowProjects,
  subs,
  activeSub,
  setActiveSub,
  onAddSub,
  onCloseSub,
  onRenameSub,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const [cmd, setCmd] = useState("");
  // Historique des commandes propre à chaque console.
  const histMap = useRef(new Map<string, string[]>());
  const [histIdx, setHistIdx] = useState(-1);
  const target = activeSub ?? active;
  const histKey = target ?? "";
  const launchActive = !!subs.find((s) => s.key === target)?.launch;
  useEffect(() => setHistIdx(-1), [histKey]);

  function submitCmd() {
    const c = cmd.trim();
    if (!target || !c) return;
    // "clear"/"cls" sont interceptés côté client : ils vident la console
    // (même action que le bouton « Vider ») au lieu d'être exécutés.
    if (c.toLowerCase() === "clear" || c.toLowerCase() === "cls") {
      onClear();
    } else {
      onRunCommand(target, c);
    }
    const h = histMap.current.get(histKey) ?? [];
    histMap.current.set(histKey, [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setHistIdx(-1);
    setCmd("");
  }

  function onCmdKey(e: React.KeyboardEvent<HTMLInputElement>) {
    const h = histMap.current.get(histKey) ?? [];
    if (e.key === "Enter") {
      e.preventDefault();
      submitCmd();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!h.length) return;
      const ni = Math.min(histIdx + 1, h.length - 1);
      setHistIdx(ni);
      setCmd(h[ni]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const ni = histIdx - 1;
      if (ni < 0) {
        setHistIdx(-1);
        setCmd("");
      } else {
        setHistIdx(ni);
        setCmd(h[ni]);
      }
    }
  }

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el) return;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = stuck;
    setAtBottom(stuck);
  }

  function jumpToBottom() {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setAtBottom(true);
  }

  // Plafond de rendu : au-delà de RENDER_MAX lignes, seules les plus récentes
  // sont dans le DOM (5000 nœuds re-réconciliés à chaque flush, ça rame).
  const hidden = Math.max(0, lines.length - RENDER_MAX);
  const visible = hidden > 0 ? lines.slice(hidden) : lines;

  function onDragEnd(e: DragEndEvent) {
    const { active: a, over } = e;
    if (!over || a.id === over.id) return;
    const ids = tabs.map((t) => t.id);
    const from = ids.indexOf(String(a.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  }

  return (
    <div className="console">
      <div className="console-tabs">
        {onShowProjects && (
          <button
            className="console-show-projects"
            onClick={onShowProjects}
            title="Afficher la liste des projets"
          >
            » Projets
          </button>
        )}
        {tabs.length === 0 && <div className="console-empty-tab">Console</div>}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {tabs.map((t) => (
              <SortableTab key={t.id} t={t} active={active} onSelect={setActive} onClose={onClose} />
            ))}
          </SortableContext>
        </DndContext>
        <div className="console-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClear} disabled={!active}>
            Vider
          </button>
        </div>
      </div>

      {active && (
        <SubTabs
          subs={subs}
          active={target}
          onSelect={setActiveSub}
          onAdd={onAddSub}
          onClose={onCloseSub}
          onRename={onRenameSub}
        />
      )}

      <div className="console-wrap">
        <div className={"console-body" + (wrap ? " console-wrap-lines" : "")} ref={bodyRef} onScroll={onScroll}>
          {!active && <div className="console-placeholder">Aucune sortie pour le moment.</div>}
          {active && hidden > 0 && (
            <div className="log-more">… {hidden} lignes précédentes non affichées</div>
          )}
          {active && visible.map((l, i) => <LogRow key={l.key ?? i} l={l} prettyJson={prettyJson} />)}
        </div>
        {active && !atBottom && (
          <button className="follow-btn" onClick={jumpToBottom} title="Revenir en bas et suivre les logs">
            ↓ Suivre
          </button>
        )}
      </div>

      <div className="console-cmd">
        <span className="console-cmd-prompt">$</span>
        <input
          className="console-cmd-input"
          spellCheck={false}
          autoComplete="off"
          disabled={!active}
          value={cmd}
          placeholder={
            !active
              ? "Ouvre une console"
              : launchActive
                ? "Commande à exécuter dans le projet (sortie dans « Commandes »), puis Entrée…"
                : "Commande à exécuter dans le projet, puis Entrée…"
          }
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onCmdKey}
        />
      </div>
    </div>
  );
}
