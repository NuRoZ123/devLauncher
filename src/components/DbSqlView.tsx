import { useEffect, useRef, useState } from "react";
import type { DbEditor, DbRowUpdate, DbSqlColumn, DbSqlResult } from "../types";
import { fromInputValue, toInputValue } from "./DbTableDataView";

interface Props {
  /** Identifiant de la base : la saisie est mémorisée par base. */
  projectId: string;
  /** Exécute le script brut, un résultat par instruction. */
  onRun: (sql: string) => Promise<DbSqlResult[]>;
  /** Appelé après un script qui touche à la structure (CREATE, DROP…). */
  onSchemaChanged?: () => void;
  /** Enregistre des modifications de cellules (lignes identifiées par clé primaire). */
  onApply: (table: string, columns: string[], updates: DbRowUpdate[]) => Promise<number>;
}

const storeKey = (pid: string) => `devlauncher.sql.${pid}`;
const DDL_RE = /\b(create|drop|alter|rename|truncate)\b/i;

function loadDraft(pid: string): string {
  try {
    return localStorage.getItem(storeKey(pid)) ?? "";
  } catch {
    return "";
  }
}

/** Interpréteur SQL brut : saisie libre, exécution, affichage des résultats. */
export function DbSqlView({ projectId, onRun, onSchemaChanged, onApply }: Props) {
  const [sql, setSql] = useState(() => loadDraft(projectId));
  const [running, setRunning] = useState(false);
  /** Erreur hors instruction (connexion, .env…). */
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DbSqlResult[]>([]);
  const [activeRes, setActiveRes] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  /** Numéro d'exécution : remonte les tableaux (et vide leurs saisies) à chaque run. */
  const [runId, setRunId] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storeKey(projectId), sql);
    } catch {
      /* stockage indisponible : la saisie reste en mémoire */
    }
  }, [projectId, sql]);

  const run = async () => {
    if (running) return;
    const ta = taRef.current;
    // Une sélection non vide n'exécute que la partie sélectionnée.
    const sel =
      ta && ta.selectionStart !== ta.selectionEnd
        ? sql.slice(ta.selectionStart, ta.selectionEnd)
        : sql;
    const script = sel.trim();
    if (!script) return;
    setRunning(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await onRun(script);
      setResults(res);
      setRunId((n) => n + 1);
      // Priorité à l'erreur, sinon au dernier jeu de lignes (souvent le SELECT final).
      let idx = res.findIndex((r) => r.error);
      if (idx < 0) {
        idx = res.length - 1;
        for (let i = res.length - 1; i >= 0; i--)
          if (res[i].has_rows) {
            idx = i;
            break;
          }
      }
      setActiveRes(Math.max(0, idx));
      if (DDL_RE.test(script)) onSchemaChanged?.();
    } catch (e) {
      setError(String(e));
      setResults([]);
    } finally {
      setElapsed(Math.round(performance.now() - t0));
      setRunning(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = ta;
      const next = sql.slice(0, s) + "  " + sql.slice(en);
      setSql(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  const failed = results.some((r) => r.error);

  return (
    <div className="dbsql">
      <div className="dbsql-editor">
        <textarea
          ref={taRef}
          className="dbsql-input"
          spellCheck={false}
          placeholder={"SELECT * FROM ma_table WHERE id = 1;\n\nCtrl+Entrée pour exécuter (la sélection seule si du texte est sélectionné)"}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="dbsql-toolbar">
          <button className="btn btn-primary btn-sm" onClick={run} disabled={running || !sql.trim()}>
            {running ? <span className="spinner" /> : "▶"} Exécuter
          </button>
          <span className="muted dbsql-hint">Ctrl+Entrée · plusieurs instructions séparées par « ; »</span>
          <span className="dbsql-spacer" />
          {elapsed !== null && !running && (
            <span className={failed || error ? "dbdata-del-error" : "muted"}>
              {error
                ? "Échec"
                : `${results.length} instruction${results.length > 1 ? "s" : ""}${failed ? " · arrêt sur erreur" : ""}`}{" "}
              · {elapsed} ms
            </span>
          )}
        </div>
      </div>

      <div className="dbsql-results">
        {error ? (
          <div className="banner-error dbsql-error">{error}</div>
        ) : results.length === 0 ? (
          <div className="empty">Le résultat de la requête s'affichera ici.</div>
        ) : (
          <>
            {results.length > 1 && (
              <div className="dbsub-tabs">
                {results.map((r, i) => (
                  <button
                    key={i}
                    className={
                      "dbsub-tab" + (i === activeRes ? " on" : "") + (r.error ? " dbsql-tab-ko" : "")
                    }
                    onClick={() => setActiveRes(i)}
                    title={r.statement || undefined}
                  >
                    {r.error ? "✕" : r.has_rows ? "▤" : "✓"} Résultat {i + 1}
                  </button>
                ))}
              </div>
            )}
            {/* Tous les résultats restent montés : les modifications en attente
                d'un résultat survivent au passage sur un autre. */}
            {results.map((r, i) => (
              <div
                key={`${runId}-${i}`}
                className="dbsql-respanel"
                style={{ display: i === activeRes ? "flex" : "none" }}
              >
                <SqlResultView
                  res={r}
                  onApply={onApply}
                  onSaved={(rows) =>
                    setResults((rs) => rs.map((x, j) => (j === i ? { ...x, rows } : x)))
                  }
                />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const cellKey = (r: number, c: number) => `${r}:${c}`;

const INPUT_TYPE: Record<string, string> = {
  number: "number",
  date: "date",
  time: "time",
  datetime: "datetime-local",
};

/**
 * Colonnes modifiables d'un résultat : colonne réelle d'une table dont la clé
 * primaire complète figure dans le résultat (pour retrouver la ligne). Marche
 * aussi sur une jointure : chaque table est modifiable séparément.
 */
function editableColumns(res: DbSqlResult): { editable: boolean[]; readOnly: string[] } {
  const readOnly: string[] = [];
  const okTables = new Set<string>();
  for (const t of res.tables) {
    const present = (k: string) =>
      res.columns.some((c) => c.table === t.table && c.origin?.toLowerCase() === k.toLowerCase());
    if (t.pk.length === 0) readOnly.push(`« ${t.table} » n'a pas de clé primaire`);
    else if (!t.pk.every(present))
      readOnly.push(`« ${t.table} » : ajoutez ${t.pk.join(", ")} au SELECT pour modifier`);
    else okTables.add(t.table);
  }
  const seen = new Set<string>();
  const editable = res.columns.map((c) => {
    if (!c.table || !c.origin || !okTables.has(c.table)) return false;
    // Même colonne sélectionnée deux fois : seule la première est modifiable.
    const k = `${c.table}.${c.origin.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { editable, readOnly };
}

function colTitle(c: DbSqlColumn): string {
  const lines = [c.name];
  if (c.table && c.origin)
    lines.push(`Origine : ${c.table}.${c.origin}${c.origin !== c.name ? ` (alias « ${c.name} »)` : ""}`);
  else lines.push("Colonne calculée (expression, agrégat…)");
  if (c.full_type) lines.push(`Type : ${c.full_type}`);
  if (c.nullable !== null) lines.push(c.nullable ? "NULL autorisé" : "NOT NULL");
  if (c.primary_key) lines.push("Clé primaire");
  if (c.enum_values.length) lines.push(`Valeurs : ${c.enum_values.join(", ")}`);
  return lines.join("\n");
}

function SqlResultView({
  res,
  onApply,
  onSaved,
}: {
  res: DbSqlResult;
  onApply: Props["onApply"];
  onSaved: (rows: (string | null)[][]) => void;
}) {
  /** Valeurs modifiées en attente, par « ligne:colonne ». */
  const [pending, setPending] = useState<Map<string, string | null>>(new Map());
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [initial, setInitial] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const skipBlur = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (res.error) {
    return (
      <div className="dbsql-grid">
        {res.statement && <pre className="dbsql-stmt">{res.statement}</pre>}
        <div className="banner-error dbsql-error">{res.error}</div>
      </div>
    );
  }

  if (!res.has_rows) {
    return (
      <div className="dbsql-grid">
        {res.statement && <pre className="dbsql-stmt">{res.statement}</pre>}
        <div className="dbsql-ok">
          ✓ Instruction exécutée — {res.affected} ligne{res.affected > 1 ? "s" : ""} affectée
          {res.affected > 1 ? "s" : ""}
        </div>
      </div>
    );
  }

  const { editable, readOnly } = editableColumns(res);
  const anyEditable = editable.some(Boolean);
  const editorOf = (c: number): DbEditor => (res.columns[c].editor || "text") as DbEditor;

  const startEdit = (r: number, c: number) => {
    if (!editable[c] || saving) return;
    const k = cellKey(r, c);
    const v = pending.has(k) ? pending.get(k)! : res.rows[r][c];
    const init = v === null ? "" : toInputValue(editorOf(c), v);
    setDraft(init);
    setInitial(init);
    skipBlur.current = false;
    setEditing({ r, c });
  };

  const store = (r: number, c: number, value: string | null) => {
    setPending((m) => {
      const n = new Map(m);
      // Revenir à la valeur d'origine retire la modification en attente.
      if (value === res.rows[r][c]) n.delete(cellKey(r, c));
      else n.set(cellKey(r, c), value);
      return n;
    });
    setSaveMsg(null);
  };

  const commit = (explicit?: string) => {
    if (!editing) return;
    const { r, c } = editing;
    const val = explicit ?? draft;
    setEditing(null);
    if (val === initial) return; // champ non touché
    const editor = editorOf(c);
    const orig = res.rows[r][c];
    // Valeur équivalente à l'origine une fois normalisée → on remet l'origine.
    if (orig !== null && toInputValue(editor, orig) === val) return store(r, c, orig);
    const isTemporal = editor === "date" || editor === "time" || editor === "datetime";
    store(r, c, isTemporal && val.trim() === "" ? null : fromInputValue(editor, val));
  };

  const setNull = () => {
    if (!editing) return;
    skipBlur.current = true;
    store(editing.r, editing.c, null);
    setEditing(null);
  };

  const save = async () => {
    if (pending.size === 0 || saving) return;
    // Regroupe par table puis par ligne → un UPDATE par ligne et par table.
    const byTable = new Map<string, Map<number, { column: string; value: string | null }[]>>();
    for (const [k, value] of pending) {
      const [r, c] = k.split(":").map(Number);
      const col = res.columns[c];
      if (!col.table || !col.origin) continue;
      const rows = byTable.get(col.table) ?? new Map();
      const sets = rows.get(r) ?? [];
      sets.push({ column: col.origin, value });
      rows.set(r, sets);
      byTable.set(col.table, rows);
    }
    setSaving(true);
    setSaveMsg(null);
    let total = 0;
    try {
      for (const [table, rows] of byTable) {
        // Colonnes vues depuis la table : nom réel pour les siennes, nom
        // inutilisable pour les autres (la clé primaire est cherchée par nom).
        const columns = res.columns.map((c, i) =>
          c.table === table && c.origin ? c.origin : `\u0000${i}`,
        );
        const updates: DbRowUpdate[] = [...rows].map(([r, sets]) => ({ row: res.rows[r], sets }));
        total += await onApply(table, columns, updates);
      }
      const rows = res.rows.map((row, r) =>
        row.map((v, c) => {
          const k = cellKey(r, c);
          return pending.has(k) ? pending.get(k)! : v;
        }),
      );
      setPending(new Map());
      onSaved(rows);
      setSaveMsg({ ok: true, text: `${total} ligne${total > 1 ? "s" : ""} modifiée${total > 1 ? "s" : ""}` });
    } catch (e) {
      setSaveMsg({ ok: false, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setPending(new Map());
    setEditing(null);
    setSaveMsg(null);
  };

  const onEditorKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // annule l'édition sans fermer l'espace BDD
      skipBlur.current = true;
      setEditing(null);
    }
  };
  const onEditorBlur = () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    commit();
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "s" && (e.ctrlKey || e.metaKey) && pending.size > 0) {
      e.preventDefault();
      save();
    }
  };

  const renderEditor = (c: number) => {
    const col = res.columns[c];
    const editor = editorOf(c);
    let field;
    if (editor === "bool" || editor === "enum") {
      const opts =
        editor === "bool"
          ? []
          : col.enum_values.includes(draft)
            ? col.enum_values
            : [draft, ...col.enum_values];
      field = (
        <select
          ref={(el) => (inputRef.current = el)}
          className="dbdata-cell-input"
          value={draft}
          onKeyDown={onEditorKeyDown}
          onBlur={onEditorBlur}
          onChange={(e) => {
            setDraft(e.target.value);
            skipBlur.current = true;
            commit(e.target.value);
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
          ref={(el) => (inputRef.current = el)}
          className="dbdata-cell-input"
          type={INPUT_TYPE[editor] ?? "text"}
          step={editor === "time" || editor === "datetime" ? 1 : editor === "number" ? "any" : undefined}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onEditorKeyDown}
          onBlur={onEditorBlur}
        />
      );
    }
    return (
      <div className="dbdata-edit-wrap">
        {field}
        {col.nullable !== false && (
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
        )}
      </div>
    );
  };

  const editedRows = new Set([...pending.keys()].map((k) => k.split(":")[0])).size;
  const tablesLabel = [...new Set(res.columns.filter((_, i) => editable[i]).map((c) => c.table))].join(", ");

  return (
    <div className="dbsql-grid" onKeyDown={onGridKeyDown}>
      <div className="dbsql-gridbar">
        <span className="muted dbsql-count">
          {res.rows.length} ligne{res.rows.length > 1 ? "s" : ""}
          {res.truncated && ` affichée${res.rows.length > 1 ? "s" : ""} (résultat tronqué)`}
          {anyEditable
            ? ` · ${tablesLabel} : double-clic sur une cellule pour la modifier`
            : " · lecture seule"}
          {readOnly.length > 0 && ` · ${readOnly.join(" · ")}`}
        </span>
        <span className="dbsql-spacer" />
        {saveMsg && (
          <span className={saveMsg.ok ? "dbsql-saved" : "dbdata-del-error"}>{saveMsg.text}</span>
        )}
        {pending.size > 0 && (
          <div className="dbdata-savebar">
            <span className="dbdata-dirty">
              {pending.size} modif. · {editedRows} ligne{editedRows > 1 ? "s" : ""}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>
              Annuler
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={save}
              disabled={saving}
              title="Enregistrer en base (Ctrl+S)"
            >
              {saving ? <span className="spinner spinner-xs" /> : "💾 Enregistrer"}
            </button>
          </div>
        )}
      </div>
      <div className="dbdata-scroll">
        <table className="dbdata-table dbsql-table">
          <thead>
            <tr>
              <th className="dbdata-rownum">#</th>
              {res.columns.map((c, i) => (
                <th key={i} title={colTitle(c)} className={editable[i] ? undefined : "dbsql-th-ro"}>
                  <span className="dbdata-col-name">
                    {c.primary_key && <span className="dbsql-pk">🔑 </span>}
                    {c.name}
                  </span>
                  <span className="dbdata-col-type">
                    {c.full_type || "?"}
                    {c.nullable === false && <span className="dbsql-notnull"> · not null</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.rows.map((row, ri) => (
              <tr key={ri}>
                <td className="dbdata-rownum">{ri + 1}</td>
                {row.map((orig, ci) => {
                  if (editing && editing.r === ri && editing.c === ci) {
                    return (
                      <td key={ci} className="dbdata-editing">
                        {renderEditor(ci)}
                      </td>
                    );
                  }
                  const k = cellKey(ri, ci);
                  const edited = pending.has(k);
                  const v = edited ? pending.get(k)! : orig;
                  const num = editorOf(ci) === "number";
                  return (
                    <td
                      key={ci}
                      className={
                        (edited ? "dbdata-edited" : "") +
                        (editable[ci] ? " dbsql-editable" : "") +
                        (num ? " dbsql-num" : "")
                      }
                      title={
                        (v ?? "NULL") +
                        (edited ? `\n(avant : ${orig ?? "NULL"})` : "") +
                        (editable[ci] ? "\nDouble-clic pour modifier" : "")
                      }
                      onDoubleClick={() => startEdit(ri, ci)}
                    >
                      {v === null ? <span className="dbdata-null">NULL</span> : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
