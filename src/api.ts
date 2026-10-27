import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  disable as autoDisable,
  enable as autoEnable,
  isEnabled as autoIsEnabled,
} from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BranchInfo,
  Config,
  ConflictVersions,
  FileVersions,
  LogCommit,
  Outgoing,
  MergeState,
  RemoteBranches,
  DbAlterResult,
  GitChange,
  DbDriver,
  DbGraphData,
  DbRowUpdate,
  DbSchemaChange,
  DbSqlResult,
  DbTableData,
  DbTableSchema,
  GitInfo,
  LogLine,
  PkgMeta,
  PortInfo,
  Project,
  ProjectSource,
  ServiceDep,
  StatusEvent,
  TestResult,
} from "./types";

export const api = {
  loadConfig: () => invoke<Config | null>("load_config"),
  saveConfig: (config: Config) => invoke<void>("save_config", { config }),

  scanProjects: (
    sources: ProjectSource[],
    startCommand: string,
    commandOverrides: Record<string, string>,
  ) => invoke<Project[]>("scan_projects", { sources, startCommand, commandOverrides }),

  /** Liste les sous-dossiers directs d'un dossier (typage d'un dossier parent). */
  listSubdirs: (path: string) => invoke<string[]>("list_subdirs", { path }),

  gitInfo: (git: string, path: string) =>
    invoke<GitInfo>("git_info", { git, path }),
  listBranches: (git: string, path: string) =>
    invoke<BranchInfo[]>("list_branches", { git, path }),

  /** Liste les fichiers modifiés du dépôt (git status). */
  gitChanges: (git: string, path: string) =>
    invoke<GitChange[]>("git_changes", { git, path }),
  /** Diff d'un fichier (vs HEAD, ou vs vide si non suivi). */
  gitDiff: (git: string, path: string, file: string, untracked: boolean) =>
    invoke<string>("git_diff", { git, path, file, untracked }),
  /** Ajoute des fichiers à l'index (git add). */
  gitStage: (git: string, path: string, files: string[]) =>
    invoke<void>("git_stage", { git, path, files }),
  /** Annule les modifications non indexées (suivis : version de l'index ; non suivis : supprimés). */
  gitRollback: (git: string, path: string, tracked: string[], untracked: string[]) =>
    invoke<void>("git_rollback", { git, path, tracked, untracked }),
  /** Retire des fichiers de l'index (git reset). */
  gitUnstage: (git: string, path: string, files: string[]) =>
    invoke<void>("git_unstage", { git, path, files }),
  /** Valide ce qui est dans l'index (git commit -m). Renvoie la sortie git. */
  gitCommit: (git: string, path: string, message: string) =>
    invoke<string>("git_commit", { git, path, message }),
  /** Pousse la branche courante (git push). Renvoie la sortie git. */
  gitPush: (git: string, path: string) =>
    invoke<string>("git_push", { git, path }),
  /** Met à jour la branche courante (git pull --autostash, merge ou rebase). */
  gitPull: (git: string, path: string, rebase: boolean, remote?: string, branch?: string) =>
    invoke<string>("git_pull", { git, path, rebase, remote: remote ?? null, branch: branch ?? null }),
  /** Branches distantes connues (après un git fetch si `fetch`). */
  gitRemoteBranches: (git: string, path: string, fetch: boolean) =>
    invoke<RemoteBranches>("git_remote_branches", { git, path, fetch }),
  /** Opération en cours (merge/rebase…) et fichiers en conflit. */
  gitMergeState: (git: string, path: string) =>
    invoke<MergeState>("git_merge_state", { git, path }),
  /** Versions base / ours / theirs d'un fichier en conflit. */
  gitConflictVersions: (git: string, path: string, file: string) =>
    invoke<ConflictVersions>("git_conflict_versions", { git, path, file }),
  /** Écrit le contenu fusionné d'un fichier et le marque résolu (git add). */
  gitResolveFile: (git: string, path: string, file: string, content: string) =>
    invoke<void>("git_resolve_file", { git, path, file, content }),
  /** Résout des fichiers en prenant un côté entier (stage 2 ou 3). */
  gitResolveSide: (git: string, path: string, files: string[], side: "ours" | "theirs") =>
    invoke<void>("git_resolve_side", { git, path, files, side }),
  /** --continue / --abort / --skip de l'opération en cours. */
  gitMergeAction: (git: string, path: string, operation: string, action: "continue" | "abort" | "skip") =>
    invoke<string>("git_merge_action", { git, path, operation, action }),

  /** Historique d'une branche ("--all" : toutes) ou d'un fichier, par pages. */
  gitLog: (
    git: string,
    path: string,
    rev: string,
    file: string | null,
    skip: number,
    limit: number,
    search: string | null = null,
  ) => invoke<LogCommit[]>("git_log", { git, path, rev, file, skip, limit, search }),
  /** Branches locales et distantes (noms courts). */
  gitRefs: (git: string, path: string) => invoke<string[]>("git_refs", { git, path }),
  /** Fichiers suivis du dépôt. */
  gitLsFiles: (git: string, path: string) => invoke<string[]>("git_ls_files", { git, path }),
  /** Fichiers modifiés par un commit (vs son 1er parent, "" = commit racine). */
  gitCommitChanges: (git: string, path: string, hash: string, parent: string) =>
    invoke<GitChange[]>("git_commit_changes", { git, path, hash, parent }),
  /** Versions avant (1er parent) / après d'un fichier dans un commit. */
  gitCommitFileVersions: (git: string, path: string, hash: string, parent: string, file: string, orig: string | null) =>
    invoke<FileVersions>("git_commit_file_versions", { git, path, hash, parent, file, orig }),
  /** Diff d'un fichier dans un commit. */
  gitCommitDiff: (git: string, path: string, hash: string, parent: string, file: string, orig: string | null) =>
    invoke<string>("git_commit_diff", { git, path, hash, parent, file, orig }),
  /** Commits non poussés et commits distants à récupérer. */
  gitOutgoing: (git: string, path: string) => invoke<Outgoing>("git_outgoing", { git, path }),
  /** Version HEAD et version de travail d'un fichier (vue de comparaison). */
  /** side : fichier partiellement indexé, "staged" = HEAD ↔ index, "unstaged" = index ↔ travail. */
  gitFileVersions: (
    git: string,
    path: string,
    file: string,
    orig: string | null,
    side?: "staged" | "unstaged",
  ) => invoke<FileVersions>("git_file_versions", { git, path, file, orig, side: side ?? null }),
  /** Écrit la version de travail d'un fichier (sans toucher à l'index). */
  gitWriteWorktreeFile: (git: string, path: string, file: string, content: string) =>
    invoke<void>("git_write_worktree_file", { git, path, file, content }),
  /** Vérifie un exécutable git ; renvoie sa version (« git version … »). */
  checkGit: (git: string) => invoke<string>("check_git", { git }),
  /** Chemin de git.exe probable (à côté de Git Bash, sinon dans le PATH), "" sinon. */
  suggestGitPath: (bash: string) => invoke<string>("suggest_git_path", { bash }),

  startService: (id: string, cwd: string, command: string, bash: string, port: number | null) =>
    invoke<void>("start_service", { id, cwd, command, bash, port }),
  stopService: (id: string) => invoke<void>("stop_service", { id }),
  runAction: (runId: string, target: string, cwd: string, command: string, bash: string) =>
    invoke<number>("run_action", { runId, target, cwd, command, bash }),
  runTests: (runId: string, target: string, cwd: string, command: string, bash: string) =>
    invoke<TestResult>("run_tests", { runId, target, cwd, command, bash }),
  cancelAction: (runId: string) => invoke<void>("cancel_action", { runId }),

  getLogs: (id: string) => invoke<LogLine[]>("get_logs", { id }),
  clearLogs: (id: string) => invoke<void>("clear_logs", { id }),
  runningIds: () => invoke<string[]>("running_ids"),

  portsStatus: (ports: number[]) => invoke<PortInfo[]>("ports_status", { ports }),
  freePort: (port: number) => invoke<void>("free_port", { port }),

  openUrl: (url: string) => invoke<void>("open_url", { url }),

  /** Télécharge un fichier dans le dossier Téléchargements ; renvoie son chemin. */
  downloadFile: (url: string, filename: string) =>
    invoke<string>("download_file", { url, filename }),
  /** Ouvre l'explorateur en sélectionnant le fichier. */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),

  readPackageJson: (path: string) => invoke<PkgMeta>("read_package_json", { path }),
  readEnv: (path: string) => invoke<string>("read_env", { path }),
  saveEnv: (path: string, content: string) =>
    invoke<void>("save_env", { path, content }),
  packageLinks: (services: { id: string; name: string; path: string }[], depName: string) =>
    invoke<ServiceDep[]>("package_links", { services, depName }),

  /** Teste une connexion BDD (valeurs résolues depuis le .env). Renvoie la
   *  version du serveur si OK, rejette avec un message sinon. */
  dbConnect: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
  ) =>
    invoke<string>("db_connect", { driver, host, port, user, password, database }),

  /** Liste les tables de la base (valeurs résolues depuis le .env). */
  dbTables: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
  ) =>
    invoke<string[]>("db_tables", { driver, host, port, user, password, database }),

  /** Exécute un script SQL brut (une ou plusieurs instructions). */
  dbQuery: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    sql: string,
  ) =>
    invoke<DbSqlResult[]>("db_query", { driver, host, port, user, password, database, sql }),

  /** Lit les premières lignes d'une table (bornées par `limit`). Tri optionnel
   *  par `orderBy` (nom de colonne) dans le sens `orderDir` (asc / desc). */
  dbTableRows: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    table: string,
    limit: number,
    offset: number,
    filter: string,
    orderBy?: string,
    orderDir?: "asc" | "desc",
  ) =>
    invoke<DbTableData>("db_table_rows", {
      driver,
      host,
      port,
      user,
      password,
      database,
      table,
      limit,
      offset,
      filter,
      orderBy: orderBy ?? null,
      orderDir: orderDir ?? null,
    }),

  /** Lit la structure d'une table : colonnes, index et contraintes. */
  dbTableSchema: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    table: string,
  ) =>
    invoke<DbTableSchema>("db_table_schema", {
      driver,
      host,
      port,
      user,
      password,
      database,
      table,
    }),

  /** Lit le schéma de la base : colonnes de chaque table et clés étrangères. */
  dbGraph: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
  ) => invoke<DbGraphData>("db_graph", { driver, host, port, user, password, database }),

  /** Liste les noms de colonnes d'une table (listes déroulantes de structure). */
  dbTableColumns: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    table: string,
  ) =>
    invoke<string[]>("db_table_columns", {
      driver,
      host,
      port,
      user,
      password,
      database,
      table,
    }),

  /** Applique des modifications de structure (colonnes, index, contraintes)
   *  via ALTER TABLE / CREATE INDEX. */
  dbAlterTable: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    table: string,
    changes: DbSchemaChange[],
  ) =>
    invoke<DbAlterResult>("db_alter_table", {
      driver,
      host,
      port,
      user,
      password,
      database,
      table,
      changes,
    }),

  /** Supprime les lignes sélectionnées (identifiées par leur clé primaire).
   *  `rows` = valeurs de cellules (texte) alignées sur `columns`. */
  dbDeleteRows: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    table: string,
    columns: string[],
    rows: (string | null)[][],
  ) =>
    invoke<number>("db_delete_rows", {
      driver,
      host,
      port,
      user,
      password,
      database,
      table,
      columns,
      rows,
    }),

  /** Modifie une cellule (SET column = value WHERE clé primaire de la ligne).
   *  `row` = valeurs de la ligne (texte) pour identifier la ligne par sa PK. */
  dbUpdateCell: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    table: string,
    columns: string[],
    row: (string | null)[],
    column: string,
    value: string,
  ) =>
    invoke<number>("db_update_cell", {
      driver,
      host,
      port,
      user,
      password,
      database,
      table,
      columns,
      row,
      column,
      value,
    }),

  /** Applique en une transaction les modifications + suppressions en attente. */
  dbApplyChanges: (
    driver: DbDriver,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    table: string,
    columns: string[],
    inserts: { column: string; value: string | null }[][],
    updates: DbRowUpdate[],
    deletes: (string | null)[][],
  ) =>
    invoke<{ inserted: number; updated: number; deleted: number }>("db_apply_changes", {
      driver,
      host,
      port,
      user,
      password,
      database,
      table,
      columns,
      inserts,
      updates,
      deletes,
    }),
  setDepVersion: (servicePath: string, depName: string, value: string) =>
    invoke<void>("set_dep_version", { servicePath, depName, value }),
};

export const autostart = {
  isEnabled: () => autoIsEnabled(),
  enable: () => autoEnable(),
  disable: () => autoDisable(),
};

export function onLogs(cb: (l: LogLine[]) => void): Promise<UnlistenFn> {
  return listen<LogLine[]>("logs", (e) => cb(e.payload));
}

export function onStatus(cb: (s: StatusEvent) => void): Promise<UnlistenFn> {
  return listen<StatusEvent>("status", (e) => cb(e.payload));
}

export async function pickFolder(title: string): Promise<string | null> {
  const res = await open({ directory: true, multiple: false, title });
  return typeof res === "string" ? res : null;
}

export async function pickGitExe(): Promise<string | null> {
  const res = await open({
    directory: false,
    multiple: false,
    title: "Sélectionner git.exe",
    filters: [{ name: "Exécutable", extensions: ["exe"] }],
  });
  return typeof res === "string" ? res : null;
}

export async function pickBashExe(): Promise<string | null> {
  const res = await open({
    directory: false,
    multiple: false,
    title: "Sélectionner bash.exe (Git Bash)",
    filters: [{ name: "Exécutable", extensions: ["exe"] }],
  });
  return typeof res === "string" ? res : null;
}
