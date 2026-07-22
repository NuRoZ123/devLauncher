import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DbDriver, DbEditor, DbFkRef, DbRowUpdate } from "../types";

export interface DbDataState {
  projectId: string;
  projectName: string;
  driver: DbDriver;
  database: string;
  table: string;
  columns: string[];
  /** Type SQL de chaque colonne (aligné sur `columns`). */
  types: string[];
  /** Éditeur adapté par colonne (aligné sur `columns`). */
  editors: DbEditor[];
  /** Valeurs enum par colonne (aligné sur `columns`). */
  enums: string[][];
  /** Colonne obligatoire à l'insertion (aligné sur `columns`). */
  required: boolean[];
  /** Clé étrangère par colonne (null sinon), aligné sur `columns`. */
  fks: (DbFkRef | null)[];
  rows: (string | null)[][];
  /** Change à chaque (re)chargement complet, pas lors d'un ajout de page.
   *  Sert à réinitialiser sélection/modifications sans les perdre au scroll. */
  loadId: number;
  /** Taille de page / lignes par chargement (persistée dans la config). */
  limit: number;
  /** Filtre WHERE simple appliqué (chaîne saisie par l'utilisateur). */
  filter: string;
  loading: boolean;
  /** true = il reste probablement des lignes à charger (scroll infini). */
  hasMore: boolean;
  /** true = chargement de la page suivante en cours. */
  loadingMore: boolean;
  /** Restauration de la position de scroll (retour d'historique). `token`
   *  garantit l'application même si `top` est identique. */
  restoreScroll?: { top: number; token: number };
  error?: string;
}

interface Props {
  state: DbDataState;
  onLimitChange: (limit: number) => void;
  onFilterChange: (filter: string) => void;
  onRefresh: () => void;
  /** Enregistre en base les ajouts + modifications + suppressions en attente. */
  onApply: (
    inserts: { column: string; value: string | null }[][],
    updates: DbRowUpdate[],
    deletes: (string | null)[][],
  ) => Promise<{ ok: boolean; message: string }>;
  /** Charge la page suivante (scroll infini). */
  onLoadMore: () => void;
  /** Suit une clé étrangère : ouvre `table` filtrée par `filter`. `scrollTop`
   *  = position de scroll actuelle, mémorisée pour le retour. */
  onNavigateFk: (table: string, filter: string, scrollTop: number) => void;
  /** Revient à la vue précédente (historique de navigation de l'onglet). */
  onBack: () => void;
  /** true = une vue précédente existe dans l'historique. */
  canBack: boolean;
  /** true = onglet actif (les raccourcis clavier n'agissent que sur lui). */
  active: boolean;
  /** Remonte le nombre de modifications en attente (pastille d'onglet). */
  onDirtyChange?: (n: number) => void;
}

const PRESETS = [50, 100, 200, 500, 1000, 5000];

const TRUE_VALUES = ["1", "true", "t", "yes", "y", "on"];

// Convertit une valeur SQL (texte) vers le format attendu par le champ HTML.
function toInputValue(editor: DbEditor, val: string): string {
  if (editor === "bool") return TRUE_VALUES.includes(val.trim().toLowerCase()) ? "1" : "0";
  if (editor === "date") return val.slice(0, 10);
  if (editor === "time") return val.slice(0, 8);
  if (editor === "datetime") return val.replace(" ", "T").slice(0, 19);
  return val;
}

// Reconvertit la valeur du champ HTML vers le format attendu par la base.
function fromInputValue(editor: DbEditor, val: string): string {
  if (editor === "datetime") return val.replace("T", " ");
  return val;
}

export function DbTableDataView({
  state,
  onLimitChange,
  onFilterChange,
  onRefresh,
  onApply,
  onLoadMore,
  onNavigateFk,
  onBack,
  canBack,
  active,
  onDirtyChange,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Restaure la position de scroll au retour d'historique (après le rendu des
  // lignes restaurées, avant peinture pour éviter tout saut visible).
  useLayoutEffect(() => {
    if (state.restoreScroll && scrollRef.current) {
      scrollRef.current.scrollTop = state.restoreScroll.top;
    }
  }, [state.restoreScroll?.token]);

  // Suit une clé étrangère depuis une cellule : ouvre la table cible filtrée,
  // en mémorisant la position de scroll actuelle pour le retour.
  const followFk = (c: number, value: string) => {
    const fk = state.fks[c];
    if (!fk) return;
    onNavigateFk(
      fk.table,
      `${fk.column} = '${value.replace(/'/g, "''")}'`,
      scrollRef.current?.scrollTop ?? 0,
    );
  };
  const [draft, setDraft] = useState(String(state.limit));
  useEffect(() => setDraft(String(state.limit)), [state.limit]);

  const [filterDraft, setFilterDraft] = useState(state.filter);
  useEffect(() => setFilterDraft(state.filter), [state.filter]);

  // Sélection de lignes (indices) + ancre pour la sélection Shift.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  // Modifications en attente (locales, non enregistrées) :
  //  - éditions de cellules : clé "r:c" → nouvelle valeur
  //  - suppressions : indices de lignes marquées
  const [pendingEdits, setPendingEdits] = useState<Map<string, string | null>>(new Map());
  const [pendingDeletes, setPendingDeletes] = useState<Set<number>>(new Set());
  // Nouvelles lignes en attente (affichées en haut). `values[c]` : undefined =
  // non renseigné (valeur par défaut à l'insertion), null = NULL, string = valeur.
  const [pendingInserts, setPendingInserts] = useState<
    { id: string; values: (string | null | undefined)[] }[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  // Édition en place d'une cellule (double-clic) : ligne existante ou nouvelle.
  type EditTarget =
    | { kind: "cell"; r: number; c: number }
    | { kind: "new"; id: string; c: number };
  const [editing, setEditing] = useState<EditTarget | null>(null);
  // Valeur du champ à l'ouverture : si elle n'a pas bougé, aucune modification
  // n'est enregistrée (évite les faux positifs dus aux conversions de format).
  const [editInitial, setEditInitial] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const editRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const skipBlur = useRef(false);

  // À chaque rechargement des lignes, l'état local ne correspond plus : on le vide.
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
    setPendingEdits(new Map());
    setPendingDeletes(new Set());
    setPendingInserts([]);
    setEditing(null);
    setSaveError(undefined);
  }, [state.loadId]);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      if (editRef.current instanceof HTMLInputElement) editRef.current.select();
    }
  }, [editing]);

  const editedCells = [...pendingEdits.keys()].filter(
    (k) => !pendingDeletes.has(Number(k.split(":")[0])),
  ).length;

  // Une nouvelle ligne est valide si toutes ses colonnes obligatoires ont une
  // valeur non nulle renseignée.
  const insertInvalid = (ins: { values: (string | null | undefined)[] }) =>
    state.required.some((req, c) => req && (ins.values[c] === undefined || ins.values[c] === null));
  const hasInvalidInsert = pendingInserts.some(insertInvalid);
  const dirtyCount = editedCells + pendingDeletes.size + pendingInserts.length;

  // ----- Sélection -----
  const onRowClick = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor !== null) {
      const lo = Math.min(anchor, i);
      const hi = Math.max(anchor, i);
      const range = new Set<number>();
      for (let k = lo; k <= hi; k++) range.add(k);
      if (e.ctrlKey || e.metaKey) {
        setSelected((prev) => {
          const n = new Set(prev);
          range.forEach((x) => n.add(x));
          return n;
        });
      } else {
        setSelected(range);
      }
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(i)) n.delete(i);
        else n.add(i);
        return n;
      });
      setAnchor(i);
    } else {
      setSelected(new Set([i]));
      setAnchor(i);
    }
  };

  const allSelectedDeleted =
    selected.size > 0 && [...selected].every((i) => pendingDeletes.has(i));

  const markDeleted = () => {
    setPendingDeletes((prev) => {
      const n = new Set(prev);
      selected.forEach((i) => n.add(i));
      return n;
    });
    setSelected(new Set());
    setAnchor(null);
  };
  const restoreSelected = () => {
    setPendingDeletes((prev) => {
      const n = new Set(prev);
      selected.forEach((i) => n.delete(i));
      return n;
    });
    setSelected(new Set());
  };

  // Touche Suppr : marque la sélection pour suppression (= bouton Supprimer),
  // sauf pendant une édition ou si le focus est dans un champ de saisie.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" || editing || selected.size === 0) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "SELECT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      markDeleted();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, editing, selected]);

  // ----- Édition locale -----
  const draftFor = (c: number, base: string | null | undefined) => {
    const editor = state.editors[c] ?? "text";
    if (base === null || base === undefined) return editor === "bool" ? "0" : "";
    return toInputValue(editor, base);
  };
  const startEdit = (r: number, c: number) => {
    const key = `${r}:${c}`;
    const base = pendingEdits.has(key) ? pendingEdits.get(key)! : state.rows[r][c];
    const draft = draftFor(c, base);
    setEditDraft(draft);
    setEditInitial(draft);
    setEditing({ kind: "cell", r, c });
  };
  const startEditNew = (id: string, c: number) => {
    const ins = pendingInserts.find((x) => x.id === id);
    const draft = draftFor(c, ins?.values[c]);
    setEditDraft(draft);
    setEditInitial(draft);
    setEditing({ kind: "new", id, c });
  };
  const cancelEdit = () => setEditing(null);

  const storeEdit = (r: number, c: number, dbVal: string | null) => {
    const key = `${r}:${c}`;
    const original = state.rows[r][c];
    setPendingEdits((prev) => {
      const n = new Map(prev);
      if (dbVal === original) n.delete(key);
      else n.set(key, dbVal);
      return n;
    });
  };
  const storeNewEdit = (id: string, c: number, dbVal: string | null) => {
    setPendingInserts((prev) =>
      prev.map((ins) =>
        ins.id === id
          ? { ...ins, values: ins.values.map((v, i) => (i === c ? dbVal : v)) }
          : ins,
      ),
    );
  };

  // Valeur du champ (format base), avec date/heure vidée → NULL.
  const toDbValue = (c: number, inputVal: string): string | null => {
    const editor = state.editors[c] ?? "text";
    if ((editor === "date" || editor === "time" || editor === "datetime") && inputVal.trim() === "")
      return null;
    return fromInputValue(editor, inputVal);
  };

  const commitEdit = (explicit?: string) => {
    if (!editing) return;
    const c = editing.c;
    const inputVal = explicit ?? editDraft;
    // Champ non touché depuis l'ouverture → aucune modification à enregistrer.
    if (inputVal === editInitial) {
      setEditing(null);
      return;
    }
    if (editing.kind === "cell") {
      const editor = state.editors[c] ?? "text";
      const original = state.rows[editing.r][c];
      // Saisie équivalente à la valeur d'origine (une fois normalisée) →
      // on repose la valeur d'origine, ce qui retire la modification en attente.
      const backToOriginal =
        original !== null && toInputValue(editor, original) === inputVal;
      storeEdit(editing.r, c, backToOriginal ? original : toDbValue(c, inputVal));
    } else {
      storeNewEdit(editing.id, c, toDbValue(c, inputVal));
    }
    setEditing(null);
  };

  const setNull = () => {
    if (!editing) return;
    if (editing.kind === "cell") storeEdit(editing.r, editing.c, null);
    else storeNewEdit(editing.id, editing.c, null);
    setEditing(null);
  };

  const addNewRow = () =>
    setPendingInserts((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), values: Array(state.columns.length).fill(undefined) },
    ]);
  const removeNewRow = (id: string) => {
    setPendingInserts((prev) => prev.filter((x) => x.id !== id));
    setEditing((e) => (e && e.kind === "new" && e.id === id ? null : e));
  };

  const editorKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // n'ferme pas l'aperçu, annule juste l'édition
      skipBlur.current = true;
      cancelEdit();
    }
  };
  const editorBlur = () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    commitEdit();
  };

  const INPUT_TYPE: Record<string, string> = {
    number: "number",
    date: "date",
    time: "time",
    datetime: "datetime-local",
  };

  function renderEditor(ci: number) {
    const editor = state.editors[ci] ?? "text";
    const nullBtn = (
      <button
        className="dbdata-null-btn"
        title="Mettre la cellule à NULL"
        // mousedown + preventDefault : garde le focus, évite un commit au blur.
        onMouseDown={(e) => {
          e.preventDefault();
          setNull();
        }}
      >
        NULL
      </button>
    );
    let field;
    if (editor === "bool" || editor === "enum") {
      const opts =
        editor === "bool"
          ? ["1", "0"]
          : (() => {
              const vals = state.enums[ci] ?? [];
              return vals.includes(editDraft) ? vals : [editDraft, ...vals];
            })();
      field = (
        <select
          ref={(el) => (editRef.current = el)}
          className="dbdata-cell-input"
          value={editDraft}
          onKeyDown={editorKeyDown}
          onBlur={editorBlur}
          onChange={(e) => {
            setEditDraft(e.target.value);
            commitEdit(e.target.value);
          }}
        >
          {editor === "bool" ? (
            <>
              <option value="1">true</option>
              <option value="0">false</option>
            </>
          ) : (
            opts.map((v) => (
              <option key={v} value={v}>
                {v === "" ? "(vide)" : v}
              </option>
            ))
          )}
        </select>
      );
    } else {
      field = (
        <input
          ref={(el) => (editRef.current = el)}
          className="dbdata-cell-input"
          type={INPUT_TYPE[editor] ?? "text"}
          step={editor === "time" || editor === "datetime" ? 1 : undefined}
          value={editDraft}
          onKeyDown={editorKeyDown}
          onBlur={editorBlur}
          onChange={(e) => setEditDraft(e.target.value)}
        />
      );
    }
    return (
      <div className="dbdata-edit-wrap">
        {field}
        {nullBtn}
      </div>
    );
  }

  // ----- Enregistrement -----
  const save = async () => {
    if (saving || dirtyCount === 0) return;
    if (hasInvalidInsert) {
      setSaveError("Complétez les colonnes obligatoires des nouvelles lignes avant d'enregistrer.");
      return;
    }
    const byRow = new Map<number, { column: string; value: string | null }[]>();
    for (const [key, val] of pendingEdits) {
      const [r, c] = key.split(":").map(Number);
      if (pendingDeletes.has(r)) continue; // ligne supprimée : inutile
      const arr = byRow.get(r) ?? [];
      arr.push({ column: state.columns[c], value: val });
      byRow.set(r, arr);
    }
    const updates: DbRowUpdate[] = [...byRow.entries()].map(([r, sets]) => ({
      row: state.rows[r],
      sets,
    }));
    const deletes = [...pendingDeletes].map((r) => state.rows[r]);
    // Insertions : seules les colonnes renseignées (les autres → défaut base).
    const inserts = pendingInserts.map((ins) =>
      ins.values
        .map((v, c) => ({ v, c }))
        .filter(({ v }) => v !== undefined)
        .map(({ v, c }) => ({ column: state.columns[c], value: v as string | null })),
    );
    setSaving(true);
    setSaveError(undefined);
    const res = await onApply(inserts, updates, deletes);
    setSaving(false);
    if (!res.ok) setSaveError(res.message);
    // succès : le rechargement vide l'état en attente.
  };
  const discard = () => {
    setPendingEdits(new Map());
    setPendingDeletes(new Set());
    setPendingInserts([]);
    setSaveError(undefined);
  };

  // Ctrl/Cmd + S enregistre (onglet actif uniquement).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  // Remonte le nombre de modifications en attente (pastille sur l'onglet).
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  useEffect(() => {
    dirtyCb.current?.(dirtyCount);
  }, [dirtyCount]);

  const commit = () => {
    const n = Math.max(1, Math.min(100000, Math.floor(Number(draft) || state.limit)));
    setDraft(String(n));
    if (n !== state.limit) onLimitChange(n);
  };
  const commitFilter = () => {
    if (filterDraft.trim() !== state.filter.trim()) onFilterChange(filterDraft.trim());
  };
  const clearFilter = () => {
    setFilterDraft("");
    if (state.filter) onFilterChange("");
  };

  return (
    <div className="dbdata-embed">
        <div className="dbdata-head">
          <div className="dbdata-title">
            {canBack && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={onBack}
                title="Revenir à la vue précédente (clé étrangère)"
              >
                ← Retour
              </button>
            )}
            <h3 title={state.table}>{state.table}</h3>
            {state.filter && <span className="chip chip-db-warn">filtré</span>}
          </div>
          <div className="dbdata-head-actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={addNewRow}
              disabled={state.loading || saving || state.columns.length === 0}
              title="Ajouter une nouvelle ligne (en haut du tableau)"
            >
              ➕ Ligne
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onRefresh}
              disabled={state.loading || saving}
              title="Recharger les données"
            >
              ↻ Rafraîchir
            </button>
          </div>
        </div>

        <div className="dbdata-toolbar">
          <input
            className="dbdata-filter"
            placeholder="Filtrer :  id = 1   ·   id in (1,2,3) AND softDelete = false   ·   name LIKE 'a%'"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
            onBlur={commitFilter}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitFilter();
            }}
          />
          {(filterDraft || state.filter) && (
            <button className="btn btn-ghost btn-sm" onClick={clearFilter} title="Effacer le filtre">
              Effacer
            </button>
          )}
        </div>

        <div className="dbdata-body">
          {state.error && <div className="banner-error dbdata-error">{state.error}</div>}
          {saveError && <div className="banner-error dbdata-error">{saveError}</div>}
          {state.loading ? (
            <div className="branch-loading">
              <span className="spinner" /> Chargement des lignes…
            </div>
          ) : state.columns.length === 0 ? (
            !state.error && <div className="empty">Table sans colonne.</div>
          ) : (
            <div
              className="dbdata-scroll"
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                if (
                  state.hasMore &&
                  !state.loadingMore &&
                  el.scrollHeight - el.scrollTop - el.clientHeight < 150
                ) {
                  onLoadMore();
                }
              }}
            >
              <table className="dbdata-table">
                <thead>
                  <tr>
                    <th className="dbdata-rownum">#</th>
                    {state.columns.map((c, ci) => (
                      <th key={c} title={state.types[ci] ? `${c} · ${state.types[ci]}` : c}>
                        <span className="dbdata-col-name">{c}</span>
                        {state.types[ci] && <span className="dbdata-col-type">{state.types[ci]}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* Nouvelles lignes en attente, en haut du tableau. */}
                  {pendingInserts.map((ins) => (
                    <tr key={ins.id} className="dbdata-new-row">
                      <td className="dbdata-rownum">
                        <button
                          className="dbdata-newrm"
                          title="Retirer cette nouvelle ligne"
                          onClick={() => removeNewRow(ins.id)}
                        >
                          ✕
                        </button>
                      </td>
                      {state.columns.map((col, ci) => {
                        const isEditing =
                          editing?.kind === "new" && editing.id === ins.id && editing.c === ci;
                        if (isEditing) {
                          return (
                            <td key={ci} className="dbdata-editing" onClick={(e) => e.stopPropagation()}>
                              {renderEditor(ci)}
                            </td>
                          );
                        }
                        const v = ins.values[ci];
                        const missing = state.required[ci] && (v === undefined || v === null);
                        return (
                          <td
                            key={ci}
                            className={missing ? "dbdata-missing" : undefined}
                            title={`${col}${state.required[ci] ? " (obligatoire)" : ""} — double-clic pour saisir`}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              startEditNew(ins.id, ci);
                            }}
                          >
                            {v === undefined ? (
                              <span className="dbdata-newdefault">
                                {state.required[ci] ? "requis" : "défaut"}
                              </span>
                            ) : v === null ? (
                              <span className="dbdata-null">NULL</span>
                            ) : v === "" ? (
                              <span className="dbdata-empty">∅</span>
                            ) : (
                              v
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {state.rows.map((row, ri) => {
                    const deleted = pendingDeletes.has(ri);
                    const cls =
                      (selected.has(ri) ? "dbdata-sel " : "") + (deleted ? "dbdata-del-row" : "");
                    return (
                      <tr
                        key={ri}
                        className={cls.trim() || undefined}
                        onClick={(e) => onRowClick(ri, e)}
                      >
                        <td className="dbdata-rownum">{ri + 1}</td>
                        {row.map((cell, ci) => {
                          const key = `${ri}:${ci}`;
                          const isEditing =
                            editing?.kind === "cell" && editing.r === ri && editing.c === ci;
                          if (isEditing && !deleted) {
                            return (
                              <td
                                key={ci}
                                className="dbdata-editing"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {renderEditor(ci)}
                              </td>
                            );
                          }
                          const edited = pendingEdits.has(key);
                          const shown = edited ? pendingEdits.get(key)! : cell;
                          const fk = state.fks[ci];
                          const canFollow = !!fk && shown !== null && shown !== "";
                          return (
                            <td
                              key={ci}
                              className={
                                (edited ? "dbdata-edited " : "") + (canFollow ? "dbdata-fk" : "")
                              }
                              title={
                                (shown ?? "NULL") +
                                (canFollow
                                  ? ` — Ctrl+clic : ouvrir ${fk!.table}`
                                  : deleted
                                    ? ""
                                    : " — double-clic pour modifier")
                              }
                              onClick={(e) => {
                                if (canFollow && (e.ctrlKey || e.metaKey)) {
                                  e.stopPropagation();
                                  followFk(ci, shown as string);
                                }
                              }}
                              onDoubleClick={(e) => {
                                if (deleted) return;
                                e.stopPropagation();
                                startEdit(ri, ci);
                              }}
                            >
                              <span className="dbdata-cellval">
                                {shown === null ? (
                                  <span className="dbdata-null">NULL</span>
                                ) : shown === "" ? (
                                  <span className="dbdata-empty">∅</span>
                                ) : (
                                  shown
                                )}
                              </span>
                              {canFollow && (
                                <button
                                  className="dbdata-fk-btn"
                                  title={`Ouvrir ${fk!.table} où ${fk!.column} = ${shown}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    followFk(ci, shown as string);
                                  }}
                                >
                                  ↗
                                </button>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {state.rows.length === 0 && <div className="empty">Aucune ligne.</div>}
              {state.loadingMore && (
                <div className="dbdata-more">
                  <span className="spinner spinner-xs" /> Chargement…
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dbdata-foot">
          <div className="dbdata-foot-left">
            {selected.size > 0 ? (
              <div className="dbdata-selbar">
                <span className="dbdata-selcount">
                  {selected.size} sélectionnée{selected.size > 1 ? "s" : ""}
                </span>
                {allSelectedDeleted ? (
                  <button className="btn btn-ghost btn-sm" onClick={restoreSelected}>
                    ↺ Restaurer
                  </button>
                ) : (
                  <button
                    className="btn btn-stop btn-sm"
                    onClick={markDeleted}
                    title="Marquer les lignes pour suppression (enregistrer pour valider)"
                  >
                    🗑 Supprimer
                  </button>
                )}
              </div>
            ) : (
              <span className="muted">
                {state.loading
                  ? "…"
                  : `${state.rows.length}${state.hasMore ? "+" : ""} ligne${
                      state.rows.length > 1 ? "s" : ""
                    }`}
              </span>
            )}
          </div>

          <div className="dbdata-foot-right">
            {dirtyCount > 0 && (
              <div className="dbdata-savebar">
                <span className={"dbdata-dirty" + (hasInvalidInsert ? " dbdata-dirty-ko" : "")}>
                  {dirtyCount} en attente
                  {pendingInserts.length > 0 && ` · ${pendingInserts.length} ajout`}
                  {editedCells > 0 && ` · ${editedCells} modif.`}
                  {pendingDeletes.size > 0 && ` · ${pendingDeletes.size} suppr.`}
                  {hasInvalidInsert && " · ⚠ colonnes requises manquantes"}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>
                  Annuler
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={save}
                  disabled={saving || hasInvalidInsert}
                  title={
                    hasInvalidInsert
                      ? "Complétez les colonnes obligatoires des nouvelles lignes"
                      : "Enregistrer en base (Ctrl+S)"
                  }
                >
                  {saving ? <span className="spinner spinner-xs" /> : "💾 Enregistrer"}
                </button>
              </div>
            )}
            <div className="dbdata-limit">
              <label className="muted" htmlFor="dbdata-rowlimit" title="Nombre de lignes par chargement (scroll infini)">
                Par page :
              </label>
              <input
                id="dbdata-rowlimit"
                className="dbdata-limit-input"
                type="number"
                min={1}
                max={100000}
                list="dbdata-rowlimit-presets"
                value={draft}
                disabled={state.loading}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
              <datalist id="dbdata-rowlimit-presets">
                {PRESETS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
          </div>
        </div>
    </div>
  );
}
