import type { DbDriver } from "./types";

/** Un type SQL proposé dans la liste déroulante de l'onglet « Structure ». */
export interface SqlTypeDef {
  /** Nom SQL, tel qu'écrit dans l'ALTER. */
  name: string;
  /**
   * Arguments demandés en plus du nom, dans l'ordre : `varchar` → longueur,
   * `decimal` → précision puis échelle. Rendus entre parenthèses.
   */
  params?: { label: string; default: string }[];
  /**
   * true = un seul champ libre pour la liste complète des arguments
   * (valeurs d'un `enum`, par exemple).
   */
  freeArgs?: boolean;
}

const LEN = (d: string) => [{ label: "longueur", default: d }];
const PREC = [
  { label: "précision", default: "10" },
  { label: "échelle", default: "2" },
];

const MY_TYPES: SqlTypeDef[] = [
  { name: "int" },
  { name: "bigint" },
  { name: "smallint" },
  { name: "tinyint" },
  { name: "decimal", params: PREC },
  { name: "float" },
  { name: "double" },
  { name: "boolean" },
  { name: "varchar", params: LEN("255") },
  { name: "char", params: LEN("1") },
  { name: "text" },
  { name: "mediumtext" },
  { name: "longtext" },
  { name: "json" },
  { name: "date" },
  { name: "datetime" },
  { name: "timestamp" },
  { name: "time" },
  { name: "year" },
  { name: "blob" },
  { name: "binary", params: LEN("16") },
  { name: "varbinary", params: LEN("255") },
  { name: "enum", freeArgs: true },
  { name: "set", freeArgs: true },
];

const PG_TYPES: SqlTypeDef[] = [
  { name: "integer" },
  { name: "bigint" },
  { name: "smallint" },
  { name: "serial" },
  { name: "bigserial" },
  { name: "numeric", params: PREC },
  { name: "real" },
  { name: "double precision" },
  { name: "boolean" },
  { name: "varchar", params: LEN("255") },
  { name: "char", params: LEN("1") },
  { name: "text" },
  { name: "uuid" },
  { name: "json" },
  { name: "jsonb" },
  { name: "date" },
  { name: "timestamp" },
  { name: "timestamptz" },
  { name: "time" },
  { name: "interval" },
  { name: "bytea" },
  { name: "inet" },
];

/**
 * Noms longs renvoyés par `format_type()` côté Postgres → entrée du catalogue.
 * Sans cela, le type d'une colonne existante ne correspondrait à aucune option.
 */
const PG_ALIASES: Record<string, string> = {
  "character varying": "varchar",
  character: "char",
  bpchar: "char",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  "time without time zone": "time",
  "time with time zone": "time",
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  bool: "boolean",
  decimal: "numeric",
};

export function sqlTypes(driver: DbDriver): SqlTypeDef[] {
  return driver === "postgres" ? PG_TYPES : MY_TYPES;
}

export interface ParsedType {
  /** Nom du type, ramené à une entrée du catalogue quand c'est possible. */
  base: string;
  /** Arguments trouvés entre parenthèses. */
  args: string[];
  /** false = type absent du catalogue (conservé tel quel dans la liste). */
  known: boolean;
}

/** « varchar(255) » → { base: "varchar", args: ["255"] }. */
export function parseSqlType(raw: string, catalog: SqlTypeDef[]): ParsedType {
  const m = raw.trim().match(/^([^(]+?)\s*(?:\(([\s\S]*)\))?$/);
  const rawBase = (m?.[1] ?? raw).trim();
  const argStr = m?.[2] ?? "";
  const args = argStr.trim() ? argStr.split(",").map((s) => s.trim()) : [];
  const lower = rawBase.toLowerCase();
  const key = PG_ALIASES[lower] ?? lower;
  const def = catalog.find((d) => d.name.toLowerCase() === key);
  return { base: def ? def.name : rawBase, args, known: !!def };
}

/** Assemble un type à partir de son nom et de ses arguments. */
export function formatSqlType(base: string, args: string[]): string {
  const kept = args.map((a) => a.trim()).filter(Boolean);
  return kept.length > 0 ? `${base}(${kept.join(", ")})` : base;
}
