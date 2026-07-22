export type ProjectKind = "service" | "package" | "front";

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  path: string;
  start_command: string | null;
  has_startup: boolean;
  has_package_json: boolean;
  has_env: boolean;
  port: number | null;
  /** Noms des scripts du package.json (ex. ["start", "build", "test"]). */
  scripts: string[];
}

export interface GitInfo {
  branch: string;
  changes: number;
  dirty: boolean;
}

export interface BranchInfo {
  name: string;
  /** true = branche présente uniquement sur le remote (branche « stale »). */
  remote: boolean;
}

export type LogStream = "out" | "err" | "sys";

export interface LogLine {
  target: string;
  line: string;
  stream: LogStream;
  ts: number;
  /** Clé de rendu stable, attribuée côté frontend à la réception. */
  key?: number;
}

export interface StatusEvent {
  id: string;
  running: boolean;
  code: number | null;
}

/** Une action = une commande unitaire jouée dans un projet. */
export interface ActionDef {
  id: string;
  label: string;
  /** Commande bash. `{branch}` est remplacé à l'exécution. */
  command: string;
  needsBranch?: boolean;
  danger?: boolean;
  /** "bash" (défaut), démarrage/arrêt, tests, ou opérations sur les packages. */
  kind?: "bash" | "link" | "restore" | "start" | "stop" | "restart" | "test";
  /** Couleur d'affichage du libellé (dérivée de config.action_colors à l'exécution). */
  color?: string;
  /** true = action réservée aux séquences : masquée du menu Actions des projets. */
  hidden?: boolean;
}

export interface TestResult {
  passed: number;
  failed: number;
  total: number;
  exit_code: number;
}

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface JobStep {
  id: string;
  label: string;
  status: JobStatus;
}

/** Une tâche de la file d'exécution (action seule ou séquence). */
export interface QJob {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  steps: JobStep[];
  status: JobStatus;
  cancellable: boolean;
}

/** Une séquence = un enchaînement ordonné d'étapes. */
export interface Sequence {
  id: string;
  name: string;
  /**
   * Étapes ordonnées : id d'action, ou référence à une autre séquence préfixée
   * par "seq:" (séquences générales). Voir `src/sequences.ts`.
   */
  actionIds: string[];
  /** true = séquence générale, jouable sur plusieurs services à la fois. */
  global?: boolean;
  /** Projets cibles (séquences générales), choisis à la création. */
  targets?: string[];
  /** Couleur d'affichage du nom (menu + réglages). */
  color?: string;
}

export type DbDriver = "mariadb" | "postgres";

/**
 * Connexion BDD d'un service : uniquement les *noms de clés* du .env pour
 * chaque champ (aucun identifiant stocké). À la réouverture, on relit le .env
 * pour résoudre les valeurs et se reconnecter.
 */
export interface DbConnection {
  driver: DbDriver;
  hostKey: string;
  portKey: string;
  userKey: string;
  passwordKey: string;
  databaseKey: string;
  /**
   * true = la dernière tentative de connexion (au dernier enregistrement de ce
   * mapping) a réussi. Sert à colorer le bouton BDD. Repart à false dès que le
   * mapping est ré-enregistré sans succès.
   */
  verified?: boolean;
}

/** Éditeur adapté à une colonne pour la modification en place. */
export type DbEditor = "text" | "number" | "bool" | "enum" | "date" | "time" | "datetime";

/** Référence de clé étrangère : table + colonne cibles. */
export interface DbFkRef {
  table: string;
  column: string;
}

/** Une ligne à modifier : `row` (valeurs actuelles, pour la clé primaire) +
 *  `sets` = colonnes à changer (valeur `null` = NULL SQL). */
export interface DbRowUpdate {
  row: (string | null)[];
  sets: { column: string; value: string | null }[];
}

/** Contenu d'un aperçu de table : colonnes + types SQL + lignes (nullables). */
export interface DbTableData {
  columns: string[];
  /** Type SQL de chaque colonne, aligné sur `columns` (ex. "int4", "varchar"). */
  types: string[];
  /** Éditeur adapté par colonne, aligné sur `columns`. */
  editors: DbEditor[];
  /** Valeurs possibles par colonne enum (vide sinon), aligné sur `columns`. */
  enums: string[][];
  /** Colonne obligatoire à l'insertion (NOT NULL sans défaut/auto), aligné. */
  required: boolean[];
  /** Clé étrangère par colonne (null sinon), aligné sur `columns`. */
  fks: (DbFkRef | null)[];
  rows: (string | null)[][];
}

export interface Config {
  projects_root: string;
  git_bash_path: string;
  /** Commande de démarrage par défaut (ex. "npm run start", "./startup.sh"). */
  start_command: string;
  /** Exceptions par projet : id ("service:nom", "front:…") → commande dédiée. */
  command_overrides: Record<string, string>;
  sequences: Sequence[];
  custom_actions: ActionDef[];
  /** Couleur d'affichage par action : id d'action → couleur CSS ("#rrggbb"). */
  action_colors: Record<string, string>;
  /** Vrai une fois les actions par défaut semées (évite leur réapparition). */
  actions_seeded: boolean;
  /** Connexions BDD par service : id de projet → mapping des clés .env. */
  db_connections: Record<string, DbConnection>;
  /** Nombre de lignes affichées par défaut dans l'aperçu d'une table. */
  db_row_limit: number;
  /** Services déclarés sans base de données : bouton BDD masqué. */
  db_disabled: Record<string, boolean>;
}

export interface PkgMeta {
  name: string;
  version: string;
}

export interface PortInfo {
  port: number;
  in_use: boolean;
  owned: boolean;
  pids: number[];
}

/** État d'un package dans le package.json d'un service. */
export interface ServiceDep {
  id: string;
  name: string;
  path: string;
  present: boolean;
  value: string | null;
  location: string | null;
  linked: boolean;
}
