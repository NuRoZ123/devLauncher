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
  DbDriver,
  DbRowUpdate,
  DbTableData,
  GitInfo,
  LogLine,
  PkgMeta,
  PortInfo,
  Project,
  ServiceDep,
  StatusEvent,
  TestResult,
} from "./types";

export const api = {
  loadConfig: () => invoke<Config | null>("load_config"),
  saveConfig: (config: Config) => invoke<void>("save_config", { config }),

  scanProjects: (root: string, startCommand: string, commandOverrides: Record<string, string>) =>
    invoke<Project[]>("scan_projects", { root, startCommand, commandOverrides }),

  gitInfo: (bash: string, path: string) =>
    invoke<GitInfo>("git_info", { bash, path }),
  listBranches: (bash: string, path: string) =>
    invoke<BranchInfo[]>("list_branches", { bash, path }),

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

  readPackageJson: (path: string) => invoke<PkgMeta>("read_package_json", { path }),
  readEnv: (path: string) => invoke<string>("read_env", { path }),
  saveEnv: (path: string, content: string) =>
    invoke<void>("save_env", { path, content }),
  packageLinks: (root: string, depName: string) =>
    invoke<ServiceDep[]>("package_links", { root, depName }),

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

  /** Lit les premières lignes d'une table (bornées par `limit`). */
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

export async function pickBashExe(): Promise<string | null> {
  const res = await open({
    directory: false,
    multiple: false,
    title: "Sélectionner bash.exe (Git Bash)",
    filters: [{ name: "Exécutable", extensions: ["exe"] }],
  });
  return typeof res === "string" ? res : null;
}
