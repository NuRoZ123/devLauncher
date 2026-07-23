import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DbConstraintKind,
  DbDriver,
  DbSchemaChange,
  DbSchemaColumn,
  DbTableSchema,
} from "../types";
import { formatSqlType, parseSqlType, sqlTypes } from "../sqlTypes";

export interface DbSchemaState {
  /** Table dont la structure a été chargée : si elle diffère de la table
   *  affichée par l'onglet (navigation par clé étrangère), il faut relire. */
  table: string;
  info?: DbTableSchema;
  loading: boolean;
  error?: string;
}

interface Props {
  /** Table affichée par l'onglet (titre de la vue). */
  table: string;
  state: DbSchemaState;
  onRefresh: () => void;
  /** Ouvre la table cible d'une clé étrangère dans un onglet. */
  onOpenTable: (table: string) => void;
  /** Applique les modifications de structure en attente. */
  onApply: (changes: DbSchemaChange[]) => Promise<{ ok: boolean; message: string }>;
  /** true = onglet actif et sous-onglet Structure visible (raccourcis clavier). */
  active: boolean;
  /** Pilote : détermine le catalogue de types SQL proposé. */
  driver: DbDriver;
  /** Tables de la base : cibles possibles d'une clé étrangère. */
  tables: string[];
  /** Colonnes d'une table, pour la cible d'une clé étrangère. */
  onLoadColumns: (table: string) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Icônes : en SVG et non en emoji, dont le rendu dépend des polices installées.
// ---------------------------------------------------------------------------
const svgProps = {
  viewBox: "0 0 16 16",
  width: 13,
  height: 13,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const IcoTrash = () => (
  <svg {...svgProps} aria-hidden>
    <path d="M2.8 4.2h10.4M6.4 4.2V2.6h3.2v1.6M4.2 4.2l.6 8.6a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.6M6.6 6.8v4.4M9.4 6.8v4.4" />
  </svg>
);
const IcoUndo = () => (
  <svg {...svgProps} aria-hidden>
    <path d="M3.2 8a4.8 4.8 0 1 1 1.6 3.6M3.2 4.4V8h3.6" />
  </svg>
);
const IcoClose = () => (
  <svg {...svgProps} aria-hidden>
    <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
  </svg>
);

// ---------------------------------------------------------------------------
// État local des modifications en attente
// ---------------------------------------------------------------------------

/** Champs modifiables d'une colonne. */
type ColField = "name" | "type" | "nullable" | "default" | "comment";

/** Modifications en attente sur une colonne existante (champ absent = inchangé). */
type ColEdit = Partial<Record<ColField, string | boolean | null>>;

type NewCol = {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
};

type NewIdx = { id: string; name: string; unique: boolean; columns: string };

type NewCon = {
  id: string;
  name: string;
  kind: DbConstraintKind;
  columns: string;
  /** Cible d'une FK, saisie au format « table(colonne) ». */
  reference: string;
  onUpdate: string;
  onDelete: string;
  expression: string;
};

/** Cellule ouverte en édition : clé de ligne + champ. */
type EditTarget = { key: string; field: string };

/** Descripteur d'une cellule modifiable. */
type CellSpec = {
  display: React.ReactNode;
  /** Valeur brute placée dans le champ à l'ouverture. */
  raw: string;
  onCommit: (value: string) => void;
  /** Champ ouvert au double-clic (« text » par défaut, « select » si `options`). */
  editor?: "text" | "select" | "sqltype" | "columns" | "reference";
  options?: { value: string; label: string }[];
  placeholder?: string;
  edited?: boolean;
  title?: string;
  className?: string;
  /** « req » = valeur obligatoire (rouge tant qu'elle manque), sinon vert. */
  role?: "req" | "opt";
};

const FK_RULES = ["", "CASCADE", "RESTRICT", "SET NULL", "SET DEFAULT", "NO ACTION"];
const CON_KINDS: DbConstraintKind[] = ["PRIMARY KEY", "UNIQUE", "FOREIGN KEY", "CHECK"];

/** Badges de clé affichés à côté du nom de colonne. */
function keyBadges(c: DbSchemaColumn) {
  const out: { label: string; cls: string; title: string }[] = [];
  if (c.primary_key) out.push({ label: "PK", cls: "dbschema-badge-pk", title: "Clé primaire" });
  if (c.fk)
    out.push({
      label: "FK",
      cls: "dbschema-badge-fk",
      title: `Clé étrangère → ${c.fk.table}(${c.fk.column})`,
    });
  if (c.unique && !c.primary_key)
    out.push({ label: "UQ", cls: "dbschema-badge-uq", title: "Valeur unique" });
  if (c.indexed && !c.primary_key && !c.unique)
    out.push({ label: "IX", cls: "dbschema-badge-ix", title: "Colonne indexée" });
  return out;
}

function kindClass(kind: string) {
  if (kind === "PRIMARY KEY") return "dbschema-badge-pk";
  if (kind === "FOREIGN KEY") return "dbschema-badge-fk";
  if (kind === "UNIQUE") return "dbschema-badge-uq";
  return "dbschema-badge-ix";
}

/** « a, b , c » → ["a", "b", "c"] (les entrées vides sont ignorées). */
const splitCols = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** « table(col1, col2) » → cible d'une clé étrangère. */
function parseReference(s: string): { table: string; columns: string[] } | null {
  const m = s.trim().match(/^(.+?)\s*\(\s*(.*?)\s*\)$/);
  if (!m) return null;
  const table = m[1].trim();
  const columns = splitCols(m[2]);
  if (!table || columns.length === 0) return null;
  return { table, columns };
}

const uid = () => Math.random().toString(36).slice(2);

/**
 * Clé de ligne : « col:<nom> » pour une ligne déjà en base, « newcol: » /
 * « newidx: » / « newcon: » pour une ligne en cours de création. Le code
 * couleur des cellules ne s'applique qu'à ces dernières.
 */
const isNewRowKey = (key: string) => key.startsWith("new");

// ---------------------------------------------------------------------------
// Éditeurs de cellule. Chacun gère sa propre valeur de travail et se valide
// lorsque le focus quitte l'ensemble du bloc (Entrée valide, Échap annule).
// ---------------------------------------------------------------------------

interface EditorProps {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/** Validation/annulation communes aux éditeurs à plusieurs champs. */
function usePopover(commit: () => void, cancel: () => void) {
  return {
    // Un déplacement de focus *à l'intérieur* du bloc ne valide pas.
    onBlur: (e: React.FocusEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      commit();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // annule l'édition sans fermer l'espace de travail
        cancel();
      }
    },
  };
}

function TextEditor({
  initial,
  onCommit,
  onCancel,
  placeholder,
}: EditorProps & { placeholder?: string }) {
  const [v, setV] = useState(initial);
  const p = usePopover(() => onCommit(v), onCancel);
  return (
    <input
      autoFocus
      className="dbdata-cell-input"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      placeholder={placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      {...p}
    />
  );
}

function SelectEditor({
  initial,
  onCommit,
  onCancel,
  options,
}: EditorProps & { options: { value: string; label: string }[] }) {
  const p = usePopover(() => onCommit(initial), onCancel);
  return (
    <select
      autoFocus
      className="dbdata-cell-input"
      value={initial}
      onChange={(e) => onCommit(e.target.value)}
      {...p}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Type SQL : liste déroulante + les arguments que le type réclame. */
function TypeEditor({
  initial,
  onCommit,
  onCancel,
  driver,
}: EditorProps & { driver: DbDriver }) {
  const catalog = useMemo(() => sqlTypes(driver), [driver]);
  const start = useMemo(() => parseSqlType(initial, catalog), [initial, catalog]);
  const [base, setBase] = useState(start.base);
  // Les arguments manquants prennent la valeur par défaut du type : ce qui est
  // affiché correspond alors exactement à ce qui sera enregistré.
  const [args, setArgs] = useState<string[]>(() => {
    const d = catalog.find((x) => x.name === start.base);
    if (!d?.params) return start.args;
    return d.params.map((prm, i) => start.args[i] ?? prm.default);
  });
  // Un type déjà en place mais absent du catalogue reste proposé en tête.
  const options = start.known ? catalog : [{ name: start.base }, ...catalog];
  const def = options.find((d) => d.name === base);
  const params = def?.params ?? [];
  const value = formatSqlType(base, def?.freeArgs ? [args.join(", ")] : args);
  const p = usePopover(() => onCommit(value), onCancel);

  /** Changer de type réinitialise les arguments sur ses valeurs par défaut. */
  const pickBase = (name: string) => {
    setBase(name);
    const d = options.find((x) => x.name === name);
    setArgs(d?.params ? d.params.map((x) => x.default) : []);
  };

  return (
    <div className="dbschema-editbox" {...p}>
      <select
        autoFocus
        className="dbdata-cell-input"
        value={base}
        onChange={(e) => pickBase(e.target.value)}
      >
        {options.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}
          </option>
        ))}
      </select>
      {params.map((prm, i) => (
        <input
          key={prm.label}
          className="dbdata-cell-input dbschema-param"
          type="number"
          min={0}
          placeholder={prm.label}
          title={prm.label}
          value={args[i] ?? prm.default}
          onChange={(e) =>
            setArgs((a) => {
              const n = [...a];
              while (n.length < params.length) n.push("");
              n[i] = e.target.value;
              return n;
            })
          }
        />
      ))}
      {def?.freeArgs && (
        <input
          className="dbdata-cell-input"
          placeholder="'valeur1', 'valeur2'"
          title="Valeurs, séparées par des virgules"
          value={args.join(", ")}
          onChange={(e) => setArgs(e.target.value ? [e.target.value] : [])}
        />
      )}
    </div>
  );
}

/** Choix de colonnes (ordre de sélection conservé : il compte dans un index). */
function ColumnsEditor({
  initial,
  onCommit,
  onCancel,
  available,
}: EditorProps & { available: string[] }) {
  const [sel, setSel] = useState<string[]>(() =>
    initial
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const p = usePopover(() => onCommit(sel.join(", ")), onCancel);
  const toggle = (c: string) =>
    setSel((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  return (
    <div className="dbschema-editbox dbschema-editbox-col" tabIndex={-1} {...p}>
      <div className="dbschema-preview">{sel.join(", ") || "aucune colonne"}</div>
      <div className="dbschema-picklist">
        {available.map((c) => (
          <label key={c} className="dbschema-pick">
            <input
              type="checkbox"
              checked={sel.includes(c)}
              onChange={() => toggle(c)}
              autoFocus={c === available[0]}
            />
            {c}
          </label>
        ))}
        {available.length === 0 && <span className="muted">Aucune colonne.</span>}
      </div>
    </div>
  );
}

/** Cible d'une clé étrangère : table puis colonne, en deux listes. */
function ReferenceEditor({
  initial,
  onCommit,
  onCancel,
  tables,
  onLoadColumns,
}: EditorProps & { tables: string[]; onLoadColumns: (t: string) => Promise<string[]> }) {
  const start = parseReference(initial);
  const [refTable, setRefTable] = useState(start?.table ?? "");
  const [refCol, setRefCol] = useState(start?.columns[0] ?? "");
  const [cols, setCols] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Recharge la liste des colonnes à chaque changement de table cible.
  useEffect(() => {
    if (!refTable) {
      setCols([]);
      return;
    }
    let alive = true;
    setLoading(true);
    onLoadColumns(refTable)
      .then((c) => {
        if (!alive) return;
        setCols(c);
        // Conserve la colonne choisie si elle existe encore, sinon la première.
        setRefCol((cur) => (c.includes(cur) ? cur : (c[0] ?? "")));
      })
      .catch(() => alive && setCols([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [refTable, onLoadColumns]);

  const value = refTable && refCol ? `${refTable}(${refCol})` : "";
  const p = usePopover(() => onCommit(value), onCancel);
  return (
    <div className="dbschema-editbox" {...p}>
      <select
        autoFocus
        className="dbdata-cell-input"
        value={refTable}
        onChange={(e) => setRefTable(e.target.value)}
        title="Table référencée"
      >
        <option value="">— table —</option>
        {tables.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select
        className="dbdata-cell-input"
        value={refCol}
        disabled={!refTable || loading}
        onChange={(e) => setRefCol(e.target.value)}
        title="Colonne référencée"
      >
        {loading && <option value="">chargement…</option>}
        {!loading && cols.length === 0 && <option value="">— colonne —</option>}
        {cols.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DbTableSchemaView({
  table,
  state,
  onRefresh,
  onOpenTable,
  onApply,
  active,
  driver,
  tables,
  onLoadColumns,
}: Props) {
  const [q, setQ] = useState("");
  const info = state.info;

  // ----- Modifications en attente -----
  const [colEdits, setColEdits] = useState<Map<string, ColEdit>>(new Map());
  const [colDrops, setColDrops] = useState<Set<string>>(new Set());
  const [colAdds, setColAdds] = useState<NewCol[]>([]);
  const [idxDrops, setIdxDrops] = useState<Set<string>>(new Set());
  const [idxAdds, setIdxAdds] = useState<NewIdx[]>([]);
  /** Contraintes marquées pour suppression : nom → type (syntaxe MySQL). */
  const [conDrops, setConDrops] = useState<Map<string, string>>(new Map());
  const [conAdds, setConAdds] = useState<NewCon[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const [editing, setEditing] = useState<EditTarget | null>(null);

  const reset = () => {
    setColEdits(new Map());
    setColDrops(new Set());
    setColAdds([]);
    setIdxDrops(new Set());
    setIdxAdds([]);
    setConDrops(new Map());
    setConAdds([]);
    setEditing(null);
    setSaveError(undefined);
  };

  // Une structure rechargée invalide toutes les modifications locales.
  useEffect(reset, [info]);

  /** Valeurs effectives d'une colonne : origine + modifications en attente. */
  const eff = (c: DbSchemaColumn) => {
    const e = colEdits.get(c.name) ?? {};
    return {
      name: (e.name as string) ?? c.name,
      type: (e.type as string) ?? c.full_type,
      nullable: (e.nullable as boolean) ?? c.nullable,
      default: e.default !== undefined ? (e.default as string | null) : c.default,
      comment: e.comment !== undefined ? (e.comment as string | null) : c.comment,
    };
  };
  const isEdited = (c: DbSchemaColumn, f: ColField) => colEdits.get(c.name)?.[f] !== undefined;

  const columns = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!info) return [];
    if (!s) return info.columns;
    return info.columns.filter(
      (c) =>
        c.name.toLowerCase().includes(s) ||
        c.full_type.toLowerCase().includes(s) ||
        (c.comment ?? "").toLowerCase().includes(s),
    );
  }, [q, info]);

  /** Colonnes proposées dans les listes : état *après* modifications en attente. */
  const availableColumns = useMemo(() => {
    const out: string[] = [];
    for (const c of info?.columns ?? []) {
      if (colDrops.has(c.name)) continue;
      out.push(eff(c).name);
    }
    for (const a of colAdds) if (a.name.trim()) out.push(a.name.trim());
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, colDrops, colEdits, colAdds]);

  const dirtyCount =
    colEdits.size +
    colDrops.size +
    colAdds.length +
    idxDrops.size +
    idxAdds.length +
    conDrops.size +
    conAdds.length;

  // Saisies incomplètes qui bloquent l'enregistrement.
  const invalid =
    // Colonne existante vidée de son nom ou de son type.
    (info?.columns ?? []).some((c) => {
      if (colDrops.has(c.name) || !colEdits.has(c.name)) return false;
      const v = eff(c);
      return !v.name.trim() || !v.type.trim();
    }) ||
    colAdds.some((a) => !a.name.trim() || !a.type.trim()) ||
    idxAdds.some((i) => !i.name.trim() || splitCols(i.columns).length === 0) ||
    conAdds.some((k) => {
      if (!k.name.trim()) return true;
      if (k.kind === "CHECK") return !k.expression.trim();
      if (splitCols(k.columns).length === 0) return true;
      return k.kind === "FOREIGN KEY" && parseReference(k.reference) === null;
    });

  // ----- Édition en place -----
  /** Enregistre la valeur d'un champ de colonne ; une valeur identique à
   *  l'origine retire la modification en attente. */
  const storeColEdit = (col: string, field: ColField, value: string | boolean | null) => {
    const orig = info?.columns.find((c) => c.name === col);
    if (!orig) return;
    const base: Record<ColField, string | boolean | null> = {
      name: orig.name,
      type: orig.full_type,
      nullable: orig.nullable,
      default: orig.default,
      comment: orig.comment,
    };
    setColEdits((prev) => {
      const n = new Map(prev);
      const cur: ColEdit = { ...(n.get(col) ?? {}) };
      if (value === base[field]) delete cur[field];
      else cur[field] = value;
      if (Object.keys(cur).length === 0) n.delete(col);
      else n.set(col, cur);
      return n;
    });
  };

  const patchList = <T extends { id: string }>(
    set: React.Dispatch<React.SetStateAction<T[]>>,
    id: string,
    patch: Partial<T>,
  ) => set((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const closeEditor = () => setEditing(null);

  /** Cellule modifiable : double-clic pour éditer, Entrée/blur pour valider. */
  const cell = (key: string, field: string, spec: CellSpec) => {
    const open = editing?.key === key && editing.field === field;
    if (open) {
      const props = {
        initial: spec.raw,
        onCommit: (v: string) => {
          spec.onCommit(v);
          closeEditor();
        },
        onCancel: closeEditor,
      };
      const kind = spec.editor ?? (spec.options ? "select" : "text");
      return (
        <td className="dbdata-editing">
          {kind === "select" ? (
            <SelectEditor {...props} options={spec.options ?? []} />
          ) : kind === "sqltype" ? (
            <TypeEditor {...props} driver={driver} />
          ) : kind === "columns" ? (
            <ColumnsEditor {...props} available={availableColumns} />
          ) : kind === "reference" ? (
            <ReferenceEditor {...props} tables={tables} onLoadColumns={onLoadColumns} />
          ) : (
            <TextEditor {...props} placeholder={spec.placeholder} />
          )}
        </td>
      );
    }
    // Le code couleur guide la saisie des lignes en création : rouge tant qu'un
    // champ obligatoire manque, vert dès qu'il est saisissable. Les lignes déjà
    // en base restent d'apparence normale — sauf si l'on vient d'y vider un
    // champ obligatoire, qui bloquerait l'enregistrement.
    const missing = spec.role === "req" && spec.raw.trim() === "";
    const showReq = missing && (isNewRowKey(key) || !!spec.edited);
    const showOpt = isNewRowKey(key) && !missing;
    const cls = [
      spec.className,
      showReq ? "dbschema-req" : showOpt ? "dbschema-opt" : "",
      // Le rouge prime sur le jaune « modifié » : c'est lui qui bloque.
      spec.edited && !showReq ? "dbdata-edited" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <td
        className={cls || undefined}
        title={
          (spec.title ?? "") +
          (showReq ? " — champ obligatoire" : "") +
          " — double-clic pour modifier"
        }
        onDoubleClick={() => setEditing({ key, field })}
      >
        {spec.display}
      </td>
    );
  };

  /** Bascule un nom dans un ensemble « marqué pour suppression ». */
  const toggleIn = (
    set: React.Dispatch<React.SetStateAction<Set<string>>>,
    name: string,
  ) =>
    set((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const toggleConDrop = (name: string, kind: string) =>
    setConDrops((prev) => {
      const n = new Map(prev);
      if (n.has(name)) n.delete(name);
      else n.set(name, kind);
      return n;
    });

  const removeFrom = <T extends { id: string }>(
    set: React.Dispatch<React.SetStateAction<T[]>>,
    id: string,
  ) => {
    set((prev) => prev.filter((x) => x.id !== id));
    setEditing((e) => (e && e.key.endsWith(id) ? null : e));
  };

  // ----- Enregistrement -----
  const save = async () => {
    if (saving || dirtyCount === 0 || !info) return;
    if (invalid) {
      setSaveError("Complétez les lignes signalées avant d'enregistrer.");
      return;
    }
    const changes: DbSchemaChange[] = [];
    for (const c of info.columns) {
      if (colDrops.has(c.name) || !colEdits.has(c.name)) continue;
      const v = eff(c);
      changes.push({
        op: "col_modify",
        name: c.name,
        new_name: v.name,
        type: v.type,
        old_type: c.full_type,
        nullable: v.nullable,
        default: v.default,
        comment: v.comment,
        extra: c.extra,
      });
    }
    for (const a of colAdds)
      changes.push({
        op: "col_add",
        name: a.name.trim(),
        type: a.type.trim(),
        nullable: a.nullable,
        default: a.default,
        comment: a.comment,
      });
    for (const name of colDrops) changes.push({ op: "col_drop", name });
    for (const i of idxAdds)
      changes.push({
        op: "idx_add",
        name: i.name.trim(),
        unique: i.unique,
        columns: splitCols(i.columns),
      });
    for (const name of idxDrops) changes.push({ op: "idx_drop", name });
    for (const k of conAdds) {
      const ref = k.kind === "FOREIGN KEY" ? parseReference(k.reference) : null;
      changes.push({
        op: "con_add",
        name: k.name.trim(),
        kind: k.kind,
        columns: k.kind === "CHECK" ? [] : splitCols(k.columns),
        ref_table: ref?.table ?? null,
        ref_columns: ref?.columns ?? [],
        on_update: k.onUpdate || null,
        on_delete: k.onDelete || null,
        expression: k.kind === "CHECK" ? k.expression.trim() : null,
      });
    }
    for (const [name, kind] of conDrops) changes.push({ op: "con_drop", name, kind });

    setSaving(true);
    setSaveError(undefined);
    const res = await onApply(changes);
    setSaving(false);
    if (!res.ok) setSaveError(res.message);
    // succès : le rechargement de la structure vide l'état en attente.
  };

  // Ctrl/Cmd + S enregistre (sous-onglet visible uniquement).
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

  const dash = <span className="dbdata-empty">—</span>;
  const req = (v: string, label: string) =>
    v || <span className="dbdata-newdefault">{label}</span>;

  /** Bouton d'action de ligne (supprimer / restaurer / retirer). */
  const actBtn = (
    ico: React.ReactNode,
    title: string,
    onClick: () => void,
    danger?: boolean,
  ) => (
    <td className="dbschema-rowact">
      <button
        className={"dbschema-act" + (danger ? " dbschema-act-del" : "")}
        title={title}
        onClick={onClick}
      >
        {ico}
      </button>
    </td>
  );

  return (
    <div className="dbschema">
      <div className="dbdata-head">
        <div className="dbdata-title">
          <h3 title={table}>{table}</h3>
          {info && (
            <span className="muted">
              {info.columns.length} colonne{info.columns.length > 1 ? "s" : ""}
              {info.indexes.length > 0 && ` · ${info.indexes.length} index`}
              {info.constraints.length > 0 &&
                ` · ${info.constraints.length} contrainte${
                  info.constraints.length > 1 ? "s" : ""
                }`}
            </span>
          )}
        </div>
        <div className="dbdata-head-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={onRefresh}
            disabled={state.loading || saving}
            title="Relire la structure"
          >
            ↻ Rafraîchir
          </button>
        </div>
      </div>

      <div className="dbdata-body">
        {state.error && <div className="banner-error dbdata-error">{state.error}</div>}
        {saveError && <div className="banner-error dbdata-error">{saveError}</div>}
        {state.loading ? (
          <div className="branch-loading">
            <span className="spinner" /> Lecture de la structure…
          </div>
        ) : !info ? (
          !state.error && <div className="empty">Structure non chargée.</div>
        ) : (
          <div className="dbschema-scroll">
            {/* ---- Résumé de la table ---- */}
            <div className="dbschema-summary">
              {info.engine && (
                <span className="dbschema-meta">
                  <b>Moteur</b> {info.engine}
                </span>
              )}
              {info.collation && (
                <span
                  className="dbschema-meta"
                  title="Collation appliquée aux colonnes marquées « default »"
                >
                  <b>Collation</b> {info.collation}
                </span>
              )}
              {info.est_rows !== null && (
                <span className="dbschema-meta" title="Estimation du moteur, non exacte">
                  <b>Lignes (est.)</b> ~{info.est_rows.toLocaleString("fr-FR")}
                </span>
              )}
              {info.size && (
                <span className="dbschema-meta">
                  <b>Taille</b> {info.size}
                </span>
              )}
            </div>
            {info.comment && <div className="dbschema-comment">{info.comment}</div>}

            {/* Rappel du code couleur, tant qu'une ligne est en cours de création. */}
            {(colAdds.length > 0 || idxAdds.length > 0 || conAdds.length > 0) && (
              <div className="dbschema-legend">
                <span className="dbschema-lg dbschema-lg-req">à renseigner</span>
                <span className="dbschema-lg dbschema-lg-opt">saisissable</span>
                <span className="dbschema-lg dbschema-lg-na">sans objet ici</span>
              </div>
            )}

            {/* ================= Colonnes ================= */}
            <div className="dbschema-sec-head">
              <h4>Colonnes</h4>
              <input
                className="dbschema-search"
                placeholder="Filtrer les colonnes…"
                spellCheck={false}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-sm dbschema-add"
                onClick={() =>
                  setColAdds((p) => [
                    ...p,
                    {
                      id: uid(),
                      name: "",
                      type: "varchar(255)",
                      nullable: true,
                      default: null,
                      comment: null,
                    },
                  ])
                }
                title="Ajouter une colonne"
              >
                + Colonne
              </button>
            </div>
            <table className="dbschema-table">
              <thead>
                <tr>
                  <th className="dbdata-rownum">#</th>
                  <th>Colonne</th>
                  <th>Type</th>
                  <th title="La colonne accepte-t-elle NULL ?">Null</th>
                  <th>Défaut</th>
                  <th>Référence</th>
                  <th title="auto_increment, identity, colonne générée…">Extra</th>
                  <th>Collation</th>
                  <th>Commentaire</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {/* Lignes à créer en haut du tableau, comme dans l'onglet Données. */}
                {colAdds.map((a) => {
                  const key = `newcol:${a.id}`;
                  return (
                    <tr key={key} className="dbdata-new-row">
                      <td className="dbdata-rownum">+</td>
                      {cell(key, "name", {
                        display: req(a.name, "nom requis"),
                        raw: a.name,
                        onCommit: (x) => patchList(setColAdds, a.id, { name: x.trim() }),
                        className: "dbschema-colname",
                        role: "req",
                      })}
                      {cell(key, "type", {
                        display: req(a.type, "type requis"),
                        raw: a.type,
                        editor: "sqltype",
                        onCommit: (x) => patchList(setColAdds, a.id, { type: x.trim() }),
                        className: "dbschema-type",
                        role: "req",
                      })}
                      {cell(key, "nullable", {
                        display: a.nullable ? (
                          <span className="dbdata-null">NULL</span>
                        ) : (
                          <span className="dbschema-notnull">NOT NULL</span>
                        ),
                        raw: a.nullable ? "1" : "0",
                        options: [
                          { value: "1", label: "NULL" },
                          { value: "0", label: "NOT NULL" },
                        ],
                        onCommit: (x) => patchList(setColAdds, a.id, { nullable: x === "1" }),
                      })}
                      {cell(key, "default", {
                        display:
                          a.default === null ? (
                            dash
                          ) : (
                            <code className="dbschema-code">{a.default}</code>
                          ),
                        raw: a.default ?? "",
                        placeholder: "expression SQL : 0, 'texte', CURRENT_TIMESTAMP…",
                        onCommit: (x) =>
                          patchList(setColAdds, a.id, { default: x.trim() || null }),
                      })}
                      <td>{dash}</td>
                      <td>{dash}</td>
                      <td>{dash}</td>
                      {cell(key, "comment", {
                        display: a.comment || dash,
                        raw: a.comment ?? "",
                        onCommit: (x) =>
                          patchList(setColAdds, a.id, { comment: x.trim() || null }),
                      })}
                      {actBtn(<IcoClose />, "Retirer cette nouvelle colonne", () =>
                        removeFrom(setColAdds, a.id),
                      )}
                    </tr>
                  );
                })}
                {columns.map((c) => {
                  const v = eff(c);
                  const key = `col:${c.name}`;
                  if (colDrops.has(c.name)) {
                    return (
                      <tr key={key} className="dbdata-del-row">
                        <td className="dbdata-rownum">{c.position}</td>
                        <td className="dbschema-colname" colSpan={8}>
                          <span className="dbschema-cn">{c.name}</span>
                          <span className="dbschema-droptag">sera supprimée</span>
                        </td>
                        {actBtn(<IcoUndo />, "Annuler la suppression", () =>
                          toggleIn(setColDrops, c.name),
                        )}
                      </tr>
                    );
                  }
                  return (
                    <tr key={key} className={c.primary_key ? "dbschema-pk-row" : undefined}>
                      <td className="dbdata-rownum">{c.position}</td>
                      {cell(key, "name", {
                        display: (
                          <>
                            <span className="dbschema-cn">{v.name}</span>
                            {keyBadges(c).map((b) => (
                              <span
                                key={b.label}
                                className={"dbschema-badge " + b.cls}
                                title={b.title}
                              >
                                {b.label}
                              </span>
                            ))}
                          </>
                        ),
                        raw: v.name,
                        onCommit: (x) => storeColEdit(c.name, "name", x.trim()),
                        edited: isEdited(c, "name"),
                        title: v.name,
                        className: "dbschema-colname",
                        role: "req",
                      })}
                      {cell(key, "type", {
                        display: (
                          <>
                            {v.type}
                            {c.enum_values.length > 0 && !isEdited(c, "type") && (
                              <span className="dbschema-enum" title={c.enum_values.join(" · ")}>
                                {c.enum_values.join(" · ")}
                              </span>
                            )}
                          </>
                        ),
                        raw: v.type,
                        editor: "sqltype",
                        onCommit: (x) => storeColEdit(c.name, "type", x.trim()),
                        edited: isEdited(c, "type"),
                        title: c.base_type,
                        className: "dbschema-type",
                        role: "req",
                      })}
                      {cell(key, "nullable", {
                        display: v.nullable ? (
                          <span className="dbdata-null">NULL</span>
                        ) : (
                          <span className="dbschema-notnull">NOT NULL</span>
                        ),
                        raw: v.nullable ? "1" : "0",
                        options: [
                          { value: "1", label: "NULL" },
                          { value: "0", label: "NOT NULL" },
                        ],
                        onCommit: (x) => storeColEdit(c.name, "nullable", x === "1"),
                        edited: isEdited(c, "nullable"),
                      })}
                      {cell(key, "default", {
                        display:
                          v.default === null ? (
                            dash
                          ) : (
                            <code className="dbschema-code">{v.default}</code>
                          ),
                        raw: v.default ?? "",
                        placeholder: "expression SQL : 0, 'texte', CURRENT_TIMESTAMP…",
                        onCommit: (x) => storeColEdit(c.name, "default", x.trim() || null),
                        edited: isEdited(c, "default"),
                        title: v.default ?? "",
                      })}
                      <td>
                        {c.fk ? (
                          <button
                            className="dbschema-fk-link"
                            onClick={() => onOpenTable(c.fk!.table)}
                            title={
                              `Ouvrir ${c.fk.table}` +
                              (c.fk.on_delete ? ` — ON DELETE ${c.fk.on_delete}` : "") +
                              (c.fk.on_update ? ` — ON UPDATE ${c.fk.on_update}` : "")
                            }
                          >
                            ↗ {c.fk.table}.{c.fk.column}
                          </button>
                        ) : (
                          dash
                        )}
                      </td>
                      <td title={c.extra}>{c.extra || dash}</td>
                      <td
                        title={
                          c.collation === "default"
                            ? `Collation par défaut de la base${
                                info.collation ? ` (${info.collation})` : ""
                              }`
                            : (c.collation ?? "")
                        }
                      >
                        {c.collation || dash}
                      </td>
                      {cell(key, "comment", {
                        display: v.comment || dash,
                        raw: v.comment ?? "",
                        onCommit: (x) => storeColEdit(c.name, "comment", x.trim() || null),
                        edited: isEdited(c, "comment"),
                        title: v.comment ?? "",
                      })}
                      {actBtn(
                        <IcoTrash />,
                        "Marquer la colonne pour suppression",
                        () => toggleIn(setColDrops, c.name),
                        true,
                      )}
                    </tr>
                  );
                })}

              </tbody>
            </table>
            {columns.length === 0 && colAdds.length === 0 && (
              <div className="empty">Aucune colonne « {q} ».</div>
            )}

            {/* ================= Index ================= */}
            <div className="dbschema-sec-head">
              <h4>Index</h4>
              <button
                className="btn btn-ghost btn-sm dbschema-add"
                onClick={() =>
                  setIdxAdds((p) => [...p, { id: uid(), name: "", unique: false, columns: "" }])
                }
                title="Créer un index"
              >
                + Index
              </button>
            </div>
            {info.indexes.length === 0 && idxAdds.length === 0 ? (
              <div className="empty">Aucun index.</div>
            ) : (
              <table className="dbschema-table">
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Type</th>
                    <th>Méthode</th>
                    <th>Colonnes</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {idxAdds.map((i) => {
                    const key = `newidx:${i.id}`;
                    return (
                      <tr key={key} className="dbdata-new-row">
                        {cell(key, "name", {
                          display: req(i.name, "nom requis"),
                          raw: i.name,
                          onCommit: (x) => patchList(setIdxAdds, i.id, { name: x.trim() }),
                          className: "dbschema-colname",
                          role: "req",
                        })}
                        {cell(key, "unique", {
                          display: (
                            <span
                              className={
                                "dbschema-badge " +
                                (i.unique ? "dbschema-badge-uq" : "dbschema-badge-ix")
                              }
                            >
                              {i.unique ? "UNIQUE" : "INDEX"}
                            </span>
                          ),
                          raw: i.unique ? "1" : "0",
                          options: [
                            { value: "0", label: "INDEX" },
                            { value: "1", label: "UNIQUE" },
                          ],
                          onCommit: (x) => patchList(setIdxAdds, i.id, { unique: x === "1" }),
                        })}
                        <td className="dbschema-type">—</td>
                        {cell(key, "columns", {
                          display: req(i.columns, "colonnes requises"),
                          raw: i.columns,
                          editor: "columns",
                          onCommit: (x) => patchList(setIdxAdds, i.id, { columns: x }),
                          className: "dbschema-code",
                          role: "req",
                        })}
                        {actBtn(<IcoClose />, "Retirer ce nouvel index", () =>
                          removeFrom(setIdxAdds, i.id),
                        )}
                      </tr>
                    );
                  })}
                  {info.indexes.map((ix) => {
                    const marked = idxDrops.has(ix.name);
                    return (
                      <tr
                        key={ix.name}
                        title={ix.definition ?? undefined}
                        className={marked ? "dbdata-del-row" : undefined}
                      >
                        <td className="dbschema-colname">
                          <span className="dbschema-cn">{ix.name}</span>
                          {marked && <span className="dbschema-droptag">sera supprimé</span>}
                        </td>
                        <td>
                          <span className={"dbschema-badge " + (ix.primary ? "dbschema-badge-pk" : ix.unique ? "dbschema-badge-uq" : "dbschema-badge-ix")}>
                            {ix.primary ? "PRIMARY" : ix.unique ? "UNIQUE" : "INDEX"}
                          </span>
                        </td>
                        <td className="dbschema-type">{ix.kind || "—"}</td>
                        <td className="dbschema-code">{ix.columns.join(", ")}</td>
                        {ix.primary ? (
                          <td className="dbschema-rowact" title="La clé primaire se supprime depuis les contraintes" />
                        ) : marked ? (
                          actBtn(<IcoUndo />, "Annuler la suppression", () =>
                            toggleIn(setIdxDrops, ix.name),
                          )
                        ) : (
                          actBtn(
                            <IcoTrash />,
                            "Marquer l'index pour suppression",
                            () => toggleIn(setIdxDrops, ix.name),
                            true,
                          )
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* ================= Contraintes ================= */}
            <div className="dbschema-sec-head">
              <h4>Contraintes</h4>
              <button
                className="btn btn-ghost btn-sm dbschema-add"
                onClick={() =>
                  setConAdds((p) => [
                    ...p,
                    {
                      id: uid(),
                      name: "",
                      kind: "FOREIGN KEY",
                      columns: "",
                      reference: "",
                      onUpdate: "",
                      onDelete: "",
                      expression: "",
                    },
                  ])
                }
                title="Créer une contrainte (unicité, clé étrangère, CHECK…)"
              >
                + Contrainte
              </button>
            </div>
            {info.constraints.length === 0 && conAdds.length === 0 ? (
              <div className="empty">Aucune contrainte.</div>
            ) : (
              <table className="dbschema-table">
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Type</th>
                    <th>Colonnes</th>
                    <th>Référence</th>
                    <th title="Propagation à la mise à jour de la clé référencée">ON UPDATE</th>
                    <th title="Propagation à la suppression de la ligne référencée">ON DELETE</th>
                    <th>Définition</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {conAdds.map((k) => {
                    const key = `newcon:${k.id}`;
                    const isFk = k.kind === "FOREIGN KEY";
                    const isCheck = k.kind === "CHECK";
                    const refOk = parseReference(k.reference) !== null;
                    return (
                      <tr key={key} className="dbdata-new-row">
                        {cell(key, "name", {
                          display: req(k.name, "nom requis"),
                          raw: k.name,
                          onCommit: (x) => patchList(setConAdds, k.id, { name: x.trim() }),
                          className: "dbschema-colname",
                          role: "req",
                        })}
                        {cell(key, "kind", {
                          display: (
                            <span className={"dbschema-badge " + kindClass(k.kind)}>{k.kind}</span>
                          ),
                          raw: k.kind,
                          options: CON_KINDS.map((v) => ({ value: v, label: v })),
                          onCommit: (x) =>
                            patchList(setConAdds, k.id, { kind: x as DbConstraintKind }),
                        })}
                        {isCheck ? (
                          <td>{dash}</td>
                        ) : (
                          cell(key, "columns", {
                            display: req(k.columns, "colonnes requises"),
                            raw: k.columns,
                            editor: "columns",
                            onCommit: (x) => patchList(setConAdds, k.id, { columns: x }),
                            className: "dbschema-code",
                            role: "req",
                          })
                        )}
                        {isFk ? (
                          cell(key, "reference", {
                            display: req(k.reference, "table(colonne) requis"),
                            raw: k.reference,
                            editor: "reference",
                            onCommit: (x) => patchList(setConAdds, k.id, { reference: x.trim() }),
                            className: "dbschema-code",
                            // Vert seulement quand « table(colonne) » est complet.
                            role: refOk ? "opt" : "req",
                          })
                        ) : (
                          <td>{dash}</td>
                        )}
                        {isFk ? (
                          cell(key, "onUpdate", {
                            display: k.onUpdate || dash,
                            raw: k.onUpdate,
                            options: FK_RULES.map((v) => ({ value: v, label: v || "—" })),
                            onCommit: (x) => patchList(setConAdds, k.id, { onUpdate: x }),
                          })
                        ) : (
                          <td>{dash}</td>
                        )}
                        {isFk ? (
                          cell(key, "onDelete", {
                            display: k.onDelete || dash,
                            raw: k.onDelete,
                            options: FK_RULES.map((v) => ({ value: v, label: v || "—" })),
                            onCommit: (x) => patchList(setConAdds, k.id, { onDelete: x }),
                          })
                        ) : (
                          <td>{dash}</td>
                        )}
                        {isCheck ? (
                          cell(key, "expression", {
                            display: req(k.expression, "expression requise"),
                            raw: k.expression,
                            placeholder: "prix >= 0",
                            onCommit: (x) =>
                              patchList(setConAdds, k.id, { expression: x.trim() }),
                            className: "dbschema-code",
                            role: "req",
                          })
                        ) : (
                          <td>{dash}</td>
                        )}
                        {actBtn(<IcoClose />, "Retirer cette nouvelle contrainte", () =>
                          removeFrom(setConAdds, k.id),
                        )}
                      </tr>
                    );
                  })}
                  {info.constraints.map((k) => {
                    const marked = conDrops.has(k.name);
                    return (
                      <tr
                        key={`${k.kind}:${k.name}`}
                        className={marked ? "dbdata-del-row" : undefined}
                      >
                        <td className="dbschema-colname">
                          <span className="dbschema-cn">{k.name}</span>
                          {marked && <span className="dbschema-droptag">sera supprimée</span>}
                        </td>
                        <td>
                          <span className={"dbschema-badge " + kindClass(k.kind)}>{k.kind}</span>
                        </td>
                        <td className="dbschema-code">
                          {k.columns.length > 0 ? k.columns.join(", ") : "—"}
                        </td>
                        <td className="dbschema-code">{k.references ?? "—"}</td>
                        <td>{k.on_update ?? "—"}</td>
                        <td>{k.on_delete ?? "—"}</td>
                        <td className="dbschema-code" title={k.expression ?? ""}>
                          {k.expression ?? "—"}
                        </td>
                        {marked
                          ? actBtn(<IcoUndo />, "Annuler la suppression", () =>
                              toggleConDrop(k.name, k.kind),
                            )
                          : actBtn(
                              <IcoTrash />,
                              "Marquer la contrainte pour suppression",
                              () => toggleConDrop(k.name, k.kind),
                              true,
                            )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {dirtyCount > 0 && (
        <div className="dbdata-foot">
          <div className="dbdata-foot-left">
            <span className="muted dbschema-warn">
              ⚠ Les modifications de structure sont irréversibles.
            </span>
          </div>
          <div className="dbdata-foot-right">
            <div className="dbdata-savebar">
              <span className={"dbdata-dirty" + (invalid ? " dbdata-dirty-ko" : "")}>
                {dirtyCount} en attente
                {invalid && " · ⚠ saisie incomplète"}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={reset} disabled={saving}>
                Annuler
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={save}
                disabled={saving || invalid}
                title={
                  invalid
                    ? "Complétez les lignes signalées"
                    : "Appliquer les modifications (Ctrl+S)"
                }
              >
                {saving ? <span className="spinner spinner-xs" /> : "💾 Appliquer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
