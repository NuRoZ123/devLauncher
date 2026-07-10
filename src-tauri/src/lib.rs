use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_LOG_LINES: usize = 5000;

// ---------------------------------------------------------------------------
// Accès natif aux process Windows (snapshot + kill) : quelques millisecondes,
// zéro process spawné — remplace PowerShell (Get-CimInstance) et taskkill.
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod winproc {
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    /// Map PID -> PID parent de tous les process du système.
    pub fn parents() -> HashMap<u32, u32> {
        let mut map = HashMap::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return map;
            }
            let mut e: PROCESSENTRY32 = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
            if Process32First(snap, &mut e) != 0 {
                loop {
                    map.insert(e.th32ProcessID, e.th32ParentProcessID);
                    if Process32Next(snap, &mut e) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        map
    }

    /// Termine un process par PID (équivalent `taskkill /F`, en natif).
    pub fn kill(pid: u32) {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !h.is_null() {
                TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Job Object Windows : le kill fiable.
//
// Le parcours PPID (kill_tree) ne suffit pas : git-bash/MSYS intercale des
// process transitoires quand il lance le wrapper sh `npm`. Une fois morts,
// le PPID des petits-enfants (node npm → cmd → nest --watch → node) pointe
// dans le vide et Windows ne re-parente pas : l'arbre est coupé, le watcher
// survit à l'arrêt et se relance à chaque changement de fichier.
//
// Un Job Object suit l'appartenance au niveau du noyau : tout descendant en
// hérite, même orphelin. TerminateJobObject tue tout le monde d'un coup, et
// le flag kill-on-close achève les survivants à la fermeture du handle —
// y compris si le launcher crashe (l'OS ferme alors tous ses handles).
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod winjob {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // Un HANDLE de job est un objet noyau utilisable depuis n'importe quel
    // thread ; seul Drop le ferme.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// Crée un job « kill on close » et y place le process fraîchement
        /// spawné ; tous ses futurs descendants en hériteront.
        pub fn assign(child: &std::process::Child) -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) != 0
                    && AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) != 0;
                if !ok {
                    CloseHandle(job);
                    return None;
                }
                Some(Job(job))
            }
        }

        /// Tue immédiatement tous les process encore membres du job.
        pub fn kill(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // kill-on-close : fermer le handle tue les process restants.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod winjob {
    /// Stub hors Windows : l'arrêt repose alors sur kill_tree/kill_port.
    pub struct Job;
    impl Job {
        pub fn assign(_child: &std::process::Child) -> Option<Job> {
            None
        }
        pub fn kill(&self) {}
    }
}

// ---------------------------------------------------------------------------
// État partagé de l'application
// ---------------------------------------------------------------------------

/// Process suivi d'un service : PID du bash + port (pour bien le libérer)
/// + job englobant tout l'arbre (la seule garantie d'arrêt complet).
#[derive(Clone)]
struct Tracked {
    pid: u32,
    port: Option<u16>,
    job: Option<Arc<winjob::Job>>,
}

/// Process d'une action/test en cours, avec son job (pour pouvoir l'annuler
/// proprement, arbre complet compris).
#[derive(Clone)]
struct ActionProc {
    pid: u32,
    job: Option<Arc<winjob::Job>>,
}

#[derive(Default)]
struct AppState {
    /// id de projet -> process suivi
    processes: Mutex<HashMap<String, Tracked>>,
    /// runId -> process d'une action/test en cours (pour pouvoir l'annuler)
    actions: Mutex<HashMap<String, ActionProc>>,
    /// id de projet -> tampon de logs
    logs: Mutex<HashMap<String, Vec<LogLine>>>,
    /// lignes en attente d'émission vers le frontend (vidées toutes les 50 ms
    /// par le thread de flush lancé dans `run`)
    pending: Mutex<Vec<LogLine>>,
}

// ---------------------------------------------------------------------------
// Types sérialisés vers le frontend
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct LogLine {
    target: String,
    line: String,
    stream: String, // "out" | "err" | "sys"
    ts: u64,
}

#[derive(Clone, Serialize)]
struct StatusEvent {
    id: String,
    running: bool,
    code: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Config {
    #[serde(default)]
    projects_root: String,
    #[serde(default)]
    git_bash_path: String,
    /// Commande de démarrage par défaut (ex. "npm run start", "./startup.sh").
    #[serde(default)]
    start_command: String,
    /// Exceptions par projet : id ("service:nom", "front:…") → commande dédiée.
    #[serde(default)]
    command_overrides: HashMap<String, String>,
    #[serde(default)]
    sequences: Vec<serde_json::Value>,
    #[serde(default)]
    custom_actions: Vec<serde_json::Value>,
    /// Couleur d'affichage par action : id d'action → couleur CSS ("#rrggbb").
    #[serde(default)]
    action_colors: HashMap<String, String>,
    /// Vrai une fois les actions par défaut semées : évite de les réinjecter
    /// (sinon elles réapparaissent après suppression à chaque redémarrage).
    #[serde(default)]
    actions_seeded: bool,
}

#[derive(Serialize)]
struct Project {
    id: String,
    name: String,
    kind: String, // "service" | "package" | "front"
    path: String,
    start_command: Option<String>,
    has_startup: bool,
    has_package_json: bool,
    has_env: bool,
    port: Option<u16>,
    /// Noms des scripts définis dans le package.json (dans l'ordre du fichier).
    scripts: Vec<String>,
}

#[derive(Serialize)]
struct GitInfo {
    branch: String,
    changes: u32,
    dirty: bool,
}

#[derive(Serialize)]
struct BranchInfo {
    name: String,
    /// true = branche présente uniquement sur le remote (aucune copie locale),
    /// c.-à-d. une branche « stale » à afficher avec un badge.
    remote: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Construit une commande lancée via git-bash, dans le dossier `cwd`,
/// sans ouvrir de fenêtre console externe.
fn make_bash(bash: &str, cwd: &str, script: &str) -> Command {
    let mut c = Command::new(bash);
    c.arg("-lc").arg(script).current_dir(cwd);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Ajoute une ligne au tampon de logs et la met en file d'émission.
/// L'émission est faite par un thread unique (toutes les 50 ms, voir `run`) :
/// la console reste à jour même quand un flux se tait (ce que le batch par
/// lecteur ne garantissait pas), et l'ordre sortie process / messages système
/// est global. La purge se fait par gros blocs pour rester O(1) amorti.
fn push_log(app: &AppHandle, target: &str, line: String, stream: &str) {
    let entry = LogLine {
        target: target.to_string(),
        line,
        stream: stream.to_string(),
        ts: now_ms(),
    };
    let state = app.state::<AppState>();
    {
        let mut logs = state.logs.lock().unwrap();
        let buf = logs.entry(target.to_string()).or_default();
        buf.push(entry.clone());
        if buf.len() > MAX_LOG_LINES + 1024 {
            let excess = buf.len() - MAX_LOG_LINES;
            buf.drain(0..excess);
        }
    }
    state.pending.lock().unwrap().push(entry);
}

/// Filtre les séquences d'échappement ANSI et les retours chariot, en un seul
/// passage sans allocation intermédiaire (les lecteurs traitent chaque ligne :
/// c'est le chemin chaud des gros flux de sortie).
/// `keep_colors` conserve les séquences SGR (`ESC[…m`) pour l'affichage couleur.
fn filter_ansi(input: &str, keep_colors: bool) -> String {
    let mut out = String::with_capacity(input.len());
    let mut it = input.char_indices().peekable();
    while let Some((start, c)) = it.next() {
        if c == '\u{1b}' {
            match it.peek().map(|&(_, n)| n) {
                // CSI : ESC [ ... <octet final 0x40..=0x7e>
                Some('[') => {
                    it.next();
                    let mut fin: Option<(usize, char)> = None;
                    for (j, cj) in it.by_ref() {
                        if (0x40..=0x7e).contains(&(cj as u32)) {
                            fin = Some((j, cj));
                            break;
                        }
                    }
                    // séquence de couleur (SGR) : conservée si demandé
                    if keep_colors {
                        if let Some((j, 'm')) = fin {
                            out.push_str(&input[start..=j]);
                        }
                    }
                }
                // OSC : ESC ] ... (BEL ou ST) -> supprimé
                Some(']') => {
                    it.next();
                    while let Some((_, cj)) = it.next() {
                        if cj == '\u{07}' {
                            break;
                        }
                        if cj == '\u{1b}' {
                            if let Some(&(_, '\\')) = it.peek() {
                                it.next();
                                break;
                            }
                        }
                    }
                }
                // ESC isolé
                _ => {}
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Retire toutes les séquences ANSI (pour le parsing des résumés de tests).
fn strip_ansi(input: &str) -> String {
    filter_ansi(input, false)
}

/// Retire les séquences ANSI sauf les couleurs, gardées pour la console.
fn clean_ansi(input: &str) -> String {
    filter_ansi(input, true)
}

/// Lit un flux ligne par ligne et pousse chaque ligne dans les logs.
/// L'émission par lots vers le frontend est assurée par le thread de flush
/// global (voir `run`) : pas de ligne « coincée » quand le flux se tait.
fn spawn_reader<R: Read + Send + 'static>(
    app: AppHandle,
    target: String,
    reader: R,
    stream: &'static str,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let bufr = BufReader::new(reader);
        for line in bufr.lines() {
            match line {
                Ok(l) => push_log(&app, &target, clean_ansi(&l), stream),
                Err(_) => break,
            }
        }
    })
}

/// Comme `spawn_reader` mais accumule aussi la sortie (pour analyser les tests).
fn read_stream_collect<R: Read + Send + 'static>(
    app: AppHandle,
    target: String,
    reader: R,
    stream: &'static str,
    collect: std::sync::Arc<Mutex<String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let bufr = BufReader::new(reader);
        for line in bufr.lines() {
            let l = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let s = clean_ansi(&l);
            {
                let mut g = collect.lock().unwrap();
                g.push_str(&s);
                g.push('\n');
            }
            push_log(&app, &target, s, stream);
        }
    })
}

/// Exécute une commande courte et renvoie sa sortie standard.
fn run_capture(bash: &str, cwd: &str, script: &str) -> Result<String, String> {
    let out = make_bash(bash, cwd, script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Tue le(s) process qui écoute(nt) sur ce port (le node détaché, typiquement),
/// avec leurs descendants. netstat + kill natif : pas de PowerShell (lent).
fn kill_port(port: u16) {
    #[cfg(windows)]
    {
        if let Some(pids) = netstat_listen().get(&port) {
            let uniq: HashSet<u32> = pids.iter().copied().collect();
            for pid in uniq {
                let _ = kill_tree(pid);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = port;
    }
}

/// Tue tous les services suivis ET les actions en cours (appelé à la fermeture
/// de l'application pour ne pas laisser de process node orphelins).
fn kill_all_tracked(app: &AppHandle) {
    let (tracked, actions): (Vec<Tracked>, Vec<ActionProc>) = {
        let state = app.state::<AppState>();
        let t = state.processes.lock().unwrap().drain().map(|(_, v)| v).collect();
        let a = state.actions.lock().unwrap().drain().map(|(_, v)| v).collect();
        (t, a)
    };
    for t in tracked {
        if let Some(job) = &t.job {
            job.kill();
        }
        let _ = kill_tree(t.pid);
        if let Some(port) = t.port {
            kill_port(port);
        }
    }
    for a in actions {
        if let Some(job) = &a.job {
            job.kill();
        }
        let _ = kill_tree(a.pid);
    }
}

/// Tous les PID descendant de `root` (enfants, petits-enfants…).
#[cfg(windows)]
fn descendants_of(root: u32, parents: &HashMap<u32, u32>) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&c, &p) in parents.iter() {
        if c != p {
            children.entry(p).or_default().push(c);
        }
    }
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if let Some(cs) = children.get(&p) {
            for &c in cs {
                if seen.insert(c) {
                    out.push(c);
                    stack.push(c);
                }
            }
        }
    }
    out
}

/// Tue tout l'arbre de processus (bash + node + workers jest…) en natif.
/// La racine d'abord (pour qu'un superviseur ne relance pas ses enfants),
/// puis chaque descendant explicitement (ceux que `taskkill /T` ratait).
fn kill_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let parents = winproc::parents();
        let descendants = descendants_of(pid, &parents);
        winproc::kill(pid);
        for p in descendants {
            winproc::kill(p);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Config (persistée dans le dossier de config de l'app)
// ---------------------------------------------------------------------------

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<Option<Config>, String> {
    let p = config_path(&app)?;
    if !p.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let c: Config = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    Ok(Some(c))
}

/// Ouvre une URL dans le navigateur par défaut (Windows).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // On n'ouvre que des URL http(s) (garde-fou : évite d'exécuter autre chose).
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL invalide".into());
    }
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let p = config_path(&app)?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Détection du port d'un service
// ---------------------------------------------------------------------------

/// Renvoie le premier nombre rencontré dans `s` (1..=65535).
fn first_number(s: &str) -> Option<u16> {
    let mut digits = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else if !digits.is_empty() {
            break;
        }
    }
    digits.parse::<u16>().ok().filter(|&p| p >= 1)
}

/// Cherche un port dans le contenu d'un fichier (.env, startup.sh, main.ts…).
fn find_port_in(text: &str) -> Option<u16> {
    const KEYS: [&str; 6] = ["port", "app_port", "server_port", "http_port", "api_port", "nest_port"];
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('#') || l.starts_with("//") {
            continue;
        }
        let ll = l.to_lowercase();
        // --port 3000 / --port=3000
        if let Some(idx) = ll.find("--port") {
            if let Some(p) = first_number(&l[idx + 6..]) {
                return Some(p);
            }
        }
        // KEY=3000 (uniquement des clés de port connues, pas DATABASE_PORT…)
        if let Some(eq) = l.find('=') {
            let key = ll[..eq].trim().trim_start_matches("export ").trim();
            if KEYS.contains(&key) {
                if let Some(p) = first_number(&l[eq + 1..]) {
                    return Some(p);
                }
            }
        }
    }
    // Repli : app.listen(3000)
    if let Some(idx) = text.find("listen(") {
        if let Some(p) = first_number(&text[idx + 7..]) {
            return Some(p);
        }
    }
    None
}

/// Inspecte quelques fichiers du projet pour en déduire le port.
fn detect_port(dir: &Path) -> Option<u16> {
    const FILES: [&str; 6] = [
        ".env",
        ".env.local",
        ".env.development",
        "startup.sh",
        "src/main.ts",
        "main.ts",
    ];
    for f in FILES {
        if let Ok(txt) = std::fs::read_to_string(dir.join(f)) {
            if let Some(port) = find_port_in(&txt) {
                return Some(port);
            }
        }
    }
    None
}

#[derive(Serialize)]
struct PortInfo {
    port: u16,
    in_use: bool,
    owned: bool, // le process qui écoute a été lancé par nous
    pids: Vec<u32>,
}

/// `netstat -ano` -> map port -> PID(s) en écoute.
fn netstat_listen() -> HashMap<u16, Vec<u32>> {
    let mut map: HashMap<u16, Vec<u32>> = HashMap::new();
    let mut c = Command::new("netstat");
    c.arg("-ano");
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = c.output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if !line.contains("LISTENING") {
                continue;
            }
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
                continue;
            }
            let pid: u32 = match cols[cols.len() - 1].parse() {
                Ok(p) => p,
                Err(_) => continue,
            };
            // Adresse locale : "0.0.0.0:3000" ou "[::]:3000" -> port après le dernier ':'
            if let Some(idx) = cols[1].rfind(':') {
                if let Ok(port) = cols[1][idx + 1..].parse::<u16>() {
                    map.entry(port).or_default().push(pid);
                }
            }
        }
    }
    map
}

/// Map enfant -> parent de tous les process (snapshot natif, quasi instantané —
/// cette fonction est appelée par le polling des ports toutes les 4 s).
fn process_parents() -> HashMap<u32, u32> {
    #[cfg(windows)]
    {
        winproc::parents()
    }
    #[cfg(not(windows))]
    {
        HashMap::new()
    }
}

/// Ensemble des PID descendant (directement ou non) d'une de nos racines.
fn owned_pids(roots: &[u32], parents: &HashMap<u32, u32>) -> HashSet<u32> {
    let rootset: HashSet<u32> = roots.iter().copied().collect();
    let mut owned: HashSet<u32> = rootset.clone();
    for &pid in parents.keys() {
        let mut cur = pid;
        let mut guard = 0;
        loop {
            if rootset.contains(&cur) {
                owned.insert(pid);
                break;
            }
            match parents.get(&cur) {
                Some(&pp) if pp != cur => cur = pp,
                _ => break,
            }
            guard += 1;
            if guard > 64 {
                break;
            }
        }
    }
    owned
}

/// Pour une liste de ports : occupé ? par un de nos process ? avec quels PID.
#[tauri::command]
async fn ports_status(app: AppHandle, ports: Vec<u16>) -> Result<Vec<PortInfo>, String> {
    let roots: Vec<u32> = app
        .state::<AppState>()
        .processes
        .lock()
        .unwrap()
        .values()
        .map(|t| t.pid)
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let listen = netstat_listen();
        let parents = process_parents();
        let owned = owned_pids(&roots, &parents);
        ports
            .into_iter()
            .map(|p| {
                let pids = listen.get(&p).cloned().unwrap_or_default();
                let in_use = !pids.is_empty();
                let is_owned = pids.iter().any(|pid| owned.contains(pid));
                PortInfo {
                    port: p,
                    in_use,
                    owned: is_owned,
                    pids,
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Tue le(s) process qui écoute(nt) sur ce port (orphelin d'une session précédente).
#[tauri::command]
async fn free_port(port: u16) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || kill_port(port))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Détection des projets
// ---------------------------------------------------------------------------

/// Lit les noms des scripts du package.json d'un dossier (ordre du fichier).
fn read_scripts(dir: &Path) -> Vec<String> {
    let s = match std::fs::read_to_string(dir.join("package.json")) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let v: serde_json::Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    v.get("scripts")
        .and_then(|x| x.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

fn scan_dir(
    root: &str,
    sub: &str,
    kind: &str,
    start_cmd: &str,
    overrides: &HashMap<String, String>,
    out: &mut Vec<Project>,
) {
    let base = Path::new(root).join(sub);
    if let Ok(entries) = std::fs::read_dir(&base) {
        let mut dirs: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        dirs.sort();
        for p in dirs {
            if !p.is_dir() {
                continue;
            }
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let has_startup = p.join("startup.sh").is_file();
            let has_pkg = p.join("package.json").is_file();
            let has_env = p.join(".env").is_file();
            let id = format!("{}:{}", kind, name);
            // Commande de démarrage : l'exception du projet si elle existe,
            // sinon la commande par défaut définie par l'utilisateur (config).
            let cmd = overrides.get(&id).map(String::as_str).unwrap_or(start_cmd);
            let start_command = if kind == "service" && (has_pkg || has_startup) && !cmd.is_empty() {
                Some(cmd.to_string())
            } else {
                None // les packages sont des librairies : pas de démarrage
            };
            let port = if kind == "service" { detect_port(&p) } else { None };
            let scripts = if has_pkg { read_scripts(&p) } else { Vec::new() };
            out.push(Project {
                id,
                name,
                kind: kind.to_string(),
                path: p.to_string_lossy().to_string(),
                start_command,
                has_startup,
                has_package_json: has_pkg,
                has_env,
                port,
                scripts,
            });
        }
    }
}

#[tauri::command]
async fn scan_projects(
    root: String,
    start_command: String,
    command_overrides: HashMap<String, String>,
) -> Result<Vec<Project>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if root.is_empty() || !Path::new(&root).is_dir() {
            return Err(format!("Dossier racine introuvable : {}", root));
        }
        let mut projects = Vec::new();
        scan_dir(&root, "services", "service", &start_command, &command_overrides, &mut projects);

        // Front principal : portail-occupant. Comme les services, il démarre
        // avec la commande par défaut, sauf exception définie pour lui.
        let front = Path::new(&root).join("portail-occupant");
        if front.is_dir() {
            let has_pkg = front.join("package.json").is_file();
            let has_env = front.join(".env").is_file();
            let id = "front:portail-occupant".to_string();
            let cmd = command_overrides
                .get(&id)
                .map(String::as_str)
                .unwrap_or(start_command.as_str());
            projects.push(Project {
                id,
                name: "portail-occupant".to_string(),
                kind: "front".to_string(),
                path: front.to_string_lossy().to_string(),
                start_command: if cmd.is_empty() { None } else { Some(cmd.to_string()) },
                has_startup: false,
                has_package_json: has_pkg,
                has_env,
                // Le front (CRA) tourne sur 3000 par défaut si rien n'est détecté.
                port: detect_port(&front).or(Some(3000)),
                scripts: if has_pkg { read_scripts(&front) } else { Vec::new() },
            });
        }

        scan_dir(&root, "packages", "package", &start_command, &command_overrides, &mut projects);
        Ok(projects)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

#[tauri::command]
async fn git_info(bash: String, path: String) -> Result<GitInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = "printf '%s\\n' \"$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\" \"$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')\"";
        let out = run_capture(&bash, &path, script)?;
        let mut lines = out.lines();
        let branch = lines.next().unwrap_or("").trim().to_string();
        let changes: u32 = lines.next().unwrap_or("0").trim().parse().unwrap_or(0);
        Ok(GitInfo {
            branch: if branch.is_empty() {
                "—".to_string()
            } else {
                branch
            },
            changes,
            dirty: changes > 0,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_branches(bash: String, path: String) -> Result<Vec<BranchInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // On liste les branches locales (refs/heads) ET distantes (refs/remotes),
        // afin d'inclure aussi les branches « stale » (présentes seulement sur le
        // remote, sans copie locale). Le format %(refname) renvoie le nom complet
        // (ex. refs/heads/main, refs/remotes/origin/feature-x) pour distinguer les
        // deux et retirer proprement le préfixe du remote.
        let out = run_capture(
            &bash,
            &path,
            "git for-each-ref --format='%(refname)' refs/heads refs/remotes 2>/dev/null",
        )?;

        let mut branches: Vec<BranchInfo> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for raw in out.lines() {
            let line = raw.trim().trim_matches('\'');
            if let Some(name) = line.strip_prefix("refs/heads/") {
                if !name.is_empty() && seen.insert(name.to_string()) {
                    branches.push(BranchInfo {
                        name: name.to_string(),
                        remote: false,
                    });
                }
            } else if let Some(rest) = line.strip_prefix("refs/remotes/") {
                // rest = "origin/feature-x" : on retire le nom du remote (1er
                // segment) et on ignore le pointeur symbolique origin/HEAD.
                if let Some((_, name)) = rest.split_once('/') {
                    if name != "HEAD" && !name.is_empty() && seen.insert(name.to_string()) {
                        branches.push(BranchInfo {
                            name: name.to_string(),
                            remote: true,
                        });
                    }
                }
            }
        }

        Ok(branches)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Démarrage / arrêt des services
// ---------------------------------------------------------------------------

#[tauri::command]
fn start_service(
    app: AppHandle,
    id: String,
    cwd: String,
    command: String,
    bash: String,
    port: Option<u16>,
) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        if state.processes.lock().unwrap().contains_key(&id) {
            return Err("Le service est déjà démarré".to_string());
        }
    }
    push_log(&app, &id, format!("$ {}", command), "sys");

    let mut child = make_bash(&bash, &cwd, &command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Échec du démarrage : {}", e))?;

    let pid = child.id();
    // Place le bash (et tous ses futurs descendants : npm, cmd, nest --watch,
    // node) dans un Job : c'est lui qui garantit l'arrêt complet, le parcours
    // PPID étant cassé par les process transitoires de git-bash.
    let job = winjob::Job::assign(&child).map(Arc::new);
    let stdout = child.stdout.take().ok_or("stdout indisponible")?;
    let stderr = child.stderr.take().ok_or("stderr indisponible")?;

    {
        let state = app.state::<AppState>();
        state
            .processes
            .lock()
            .unwrap()
            .insert(id.clone(), Tracked { pid, port, job });
    }
    let _ = app.emit(
        "status",
        StatusEvent {
            id: id.clone(),
            running: true,
            code: None,
        },
    );

    spawn_reader(app.clone(), id.clone(), stdout, "out");
    spawn_reader(app.clone(), id.clone(), stderr, "err");

    // Surveille la fin du process pour mettre à jour le statut.
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        {
            // Le remove libère le dernier handle du job (kill-on-close) : si
            // le bash racine meurt en laissant des descendants (watcher…),
            // ils sont achevés ici au lieu de devenir des orphelins.
            let state = app2.state::<AppState>();
            state.processes.lock().unwrap().remove(&id2);
        }
        push_log(&app2, &id2, format!("● process terminé (code {:?})", code), "sys");
        let _ = app2.emit(
            "status",
            StatusEvent {
                id: id2,
                running: false,
                code,
            },
        );
    });

    Ok(())
}

#[tauri::command]
async fn stop_service(app: AppHandle, id: String) -> Result<(), String> {
    let tracked = app
        .state::<AppState>()
        .processes
        .lock()
        .unwrap()
        .get(&id)
        .cloned();
    match tracked {
        Some(t) => {
            push_log(&app, &id, "■ arrêt demandé…".to_string(), "sys");
            // Hors du thread principal : le kill (snapshot + netstat) ne doit
            // pas geler l'interface.
            tauri::async_runtime::spawn_blocking(move || {
                // Le job tue TOUT l'arbre d'un coup, y compris les branches
                // que le parcours PPID ne voit plus (nest --watch notamment).
                if let Some(job) = &t.job {
                    job.kill();
                }
                // Filets de sécurité : job indisponible, ou orphelins d'une
                // session précédente encore accrochés au port.
                let res = kill_tree(t.pid);
                if let Some(port) = t.port {
                    kill_port(port);
                }
                res
            })
            .await
            .map_err(|e| e.to_string())?
        }
        None => Err("Le service n'est pas démarré".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Actions (one-shot, attendues jusqu'à la fin → permet d'enchaîner une séquence)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn run_action(
    app: AppHandle,
    run_id: String,
    target: String,
    cwd: String,
    command: String,
    bash: String,
) -> Result<i32, String> {
    push_log(&app, &target, format!("$ {}", command), "sys");

    tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
        let mut child = make_bash(&bash, &cwd, &command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

        let pid = child.id();
        let job = winjob::Job::assign(&child).map(Arc::new);
        app.state::<AppState>()
            .actions
            .lock()
            .unwrap()
            .insert(run_id.clone(), ActionProc { pid, job });

        let stdout = child.stdout.take().ok_or("stdout indisponible")?;
        let stderr = child.stderr.take().ok_or("stderr indisponible")?;

        let h1 = spawn_reader(app.clone(), target.clone(), stdout, "out");
        let h2 = spawn_reader(app.clone(), target.clone(), stderr, "err");

        let wait_res = child.wait();
        let _ = h1.join();
        let _ = h2.join();

        // Retiré AVANT le `?` : sinon un échec de wait() laisserait le runId
        // orphelin dans la map des actions.
        app.state::<AppState>().actions.lock().unwrap().remove(&run_id);
        let code = wait_res.map_err(|e| e.to_string())?.code().unwrap_or(-1);

        let mark = if code == 0 { "✔" } else { "✖" };
        push_log(&app, &target, format!("{} terminé (code {})", mark, code), "sys");
        Ok(code)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Annule une action/test en cours (tue son arbre de process).
#[tauri::command]
async fn cancel_action(app: AppHandle, run_id: String) -> Result<(), String> {
    let proc = app
        .state::<AppState>()
        .actions
        .lock()
        .unwrap()
        .get(&run_id)
        .cloned();
    if let Some(p) = proc {
        tauri::async_runtime::spawn_blocking(move || {
            // Le job couvre tout l'arbre (le kill_tree seul ratait le vrai
            // npm, séparé du bash par un process transitoire déjà mort).
            if let Some(job) = &p.job {
                job.kill();
            }
            let _ = kill_tree(p.pid);
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests (npm run test) + parsing du résumé Jest
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct TestResult {
    passed: u32,
    failed: u32,
    total: u32,
    exit_code: i32,
}

/// Récupère le nombre juste avant un mot-clé ("12 passed" -> 12).
fn num_before(tokens: &[&str], keyword: &str) -> u32 {
    for (i, t) in tokens.iter().enumerate() {
        if t.starts_with(keyword) && i > 0 {
            if let Ok(n) = tokens[i - 1].parse::<u32>() {
                return n;
            }
        }
    }
    0
}

/// Parse la ligne "Tests: X failed, Y passed, Z total" de Jest.
fn parse_jest(text: &str) -> (u32, u32, u32) {
    let text = strip_ansi(text); // les chiffres peuvent être colorés
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("Tests:") {
            let toks: Vec<&str> = l.split_whitespace().collect();
            return (
                num_before(&toks, "passed"),
                num_before(&toks, "failed"),
                num_before(&toks, "total"),
            );
        }
    }
    (0, 0, 0)
}

#[tauri::command]
async fn run_tests(
    app: AppHandle,
    run_id: String,
    target: String,
    cwd: String,
    command: String,
    bash: String,
) -> Result<TestResult, String> {
    push_log(&app, &target, format!("$ {}", command), "sys");
    tauri::async_runtime::spawn_blocking(move || -> Result<TestResult, String> {
        let mut child = make_bash(&bash, &cwd, &command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let pid = child.id();
        let job = winjob::Job::assign(&child).map(Arc::new);
        app.state::<AppState>()
            .actions
            .lock()
            .unwrap()
            .insert(run_id.clone(), ActionProc { pid, job });
        let stdout = child.stdout.take().ok_or("stdout indisponible")?;
        let stderr = child.stderr.take().ok_or("stderr indisponible")?;

        let collected = std::sync::Arc::new(Mutex::new(String::new()));

        let h1 = read_stream_collect(app.clone(), target.clone(), stdout, "out", collected.clone());
        let h2 = read_stream_collect(app.clone(), target.clone(), stderr, "err", collected.clone());

        let wait_res = child.wait();
        let _ = h1.join();
        let _ = h2.join();
        app.state::<AppState>().actions.lock().unwrap().remove(&run_id);
        let code = wait_res.map_err(|e| e.to_string())?.code().unwrap_or(-1);

        let text = collected.lock().unwrap().clone();
        let (passed, failed, total) = parse_jest(&text);
        let mark = if failed == 0 && total > 0 { "✔" } else { "✖" };
        push_log(
            &app,
            &target,
            format!(
                "{} tests : {} passés, {} échoués, {} total (code {})",
                mark, passed, failed, total, code
            ),
            "sys",
        );
        Ok(TestResult {
            passed,
            failed,
            total,
            exit_code: code,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Packages : lier / délier dans le package.json d'un service
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct PkgMeta {
    name: String,
    version: String,
}

#[derive(Serialize)]
struct ServiceDep {
    id: String,
    name: String,
    path: String,
    present: bool,
    value: Option<String>,
    location: Option<String>, // "dependencies" | "devDependencies"
    linked: bool,
}

/// Lit le `name` et la `version` d'un package.json.
#[tauri::command]
async fn read_package_json(path: String) -> Result<PkgMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path).join("package.json");
        let s = std::fs::read_to_string(&p)
            .map_err(|e| format!("package.json introuvable : {}", e))?;
        let v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        Ok(PkgMeta {
            name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            version: v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lit le contenu brut du fichier `.env` d'un projet.
#[tauri::command]
async fn read_env(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path).join(".env");
        std::fs::read_to_string(&p).map_err(|e| format!(".env introuvable : {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Écrit le contenu du fichier `.env` d'un projet.
#[tauri::command]
async fn save_env(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path).join(".env");
        std::fs::write(&p, content).map_err(|e| format!("écriture .env impossible : {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn is_linked_value(v: &str) -> bool {
    v.starts_with("file:") || v.starts_with("..") || v.starts_with("./") || v.contains("packages/")
}

fn dep_lookup(pkg: &Path, dep: &str) -> (bool, Option<String>, Option<String>) {
    let s = match std::fs::read_to_string(pkg) {
        Ok(s) => s,
        Err(_) => return (false, None, None),
    };
    let v: serde_json::Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return (false, None, None),
    };
    for loc in ["dependencies", "devDependencies"] {
        if let Some(val) = v.get(loc).and_then(|d| d.get(dep)).and_then(|x| x.as_str()) {
            return (true, Some(val.to_string()), Some(loc.to_string()));
        }
    }
    (false, None, None)
}

/// Pour un package donné, indique son état dans chaque service.
#[tauri::command]
async fn package_links(root: String, dep_name: String) -> Result<Vec<ServiceDep>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = Path::new(&root).join("services");
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&base) {
            let mut dirs: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            dirs.sort();
            for p in dirs {
                if !p.is_dir() {
                    continue;
                }
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                if name.starts_with('.') {
                    continue;
                }
                let pkg = p.join("package.json");
                if !pkg.is_file() {
                    continue;
                }
                let (present, value, location) = dep_lookup(&pkg, &dep_name);
                let linked = value.as_deref().map(is_linked_value).unwrap_or(false);
                out.push(ServiceDep {
                    id: format!("service:{}", name),
                    name,
                    path: p.to_string_lossy().to_string(),
                    present,
                    value,
                    location,
                    linked,
                });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Modifie la valeur d'une dépendance dans le package.json d'un service.
/// Ne fait RIEN (erreur) si la dépendance n'y est pas déclarée.
#[tauri::command]
async fn set_dep_version(
    service_path: String,
    dep_name: String,
    value: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pkg = Path::new(&service_path).join("package.json");
        let s = std::fs::read_to_string(&pkg).map_err(|e| e.to_string())?;
        let mut v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;

        let mut done = false;
        for loc in ["dependencies", "devDependencies"] {
            if let Some(obj) = v.get_mut(loc).and_then(|d| d.as_object_mut()) {
                if obj.contains_key(&dep_name) {
                    obj.insert(dep_name.clone(), serde_json::Value::String(value.clone()));
                    done = true;
                    break;
                }
            }
        }
        if !done {
            return Err(format!(
                "{} n'est pas présent dans le package.json — aucune modification",
                dep_name
            ));
        }

        let mut out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
        out.push('\n');
        std::fs::write(&pkg, out).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_logs(app: AppHandle, id: String) -> Vec<LogLine> {
    app.state::<AppState>()
        .logs
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
fn clear_logs(app: AppHandle, id: String) {
    app.state::<AppState>().logs.lock().unwrap().remove(&id);
}

#[tauri::command]
fn running_ids(app: AppHandle) -> Vec<String> {
    app.state::<AppState>()
        .processes
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState::default())
        .setup(|app| {
            // Thread unique de flush des logs : émet la file en attente toutes
            // les 50 ms. Un seul événement IPC par lot (au lieu d'un par ligne)
            // et aucune ligne coincée quand un flux se tait.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let batch: Vec<LogLine> = {
                    let state = handle.state::<AppState>();
                    let mut pending = state.pending.lock().unwrap();
                    if pending.is_empty() {
                        continue;
                    }
                    std::mem::take(&mut *pending)
                };
                let _ = handle.emit("logs", &batch);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            scan_projects,
            git_info,
            list_branches,
            start_service,
            stop_service,
            run_action,
            run_tests,
            cancel_action,
            get_logs,
            clear_logs,
            running_ids,
            read_package_json,
            read_env,
            save_env,
            package_links,
            set_dep_version,
            ports_status,
            free_port,
            open_url
        ])
        .build(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri")
        .run(|app_handle, event| {
            // À la fermeture, on tue tous les services lancés pour libérer les
            // ports. Sur les deux événements (idempotent : la map est drainée)
            // pour couvrir tous les chemins de sortie.
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    kill_all_tracked(app_handle);
                }
                _ => {}
            }
        });
}
