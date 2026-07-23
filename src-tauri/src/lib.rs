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
    /// Connexions BDD par service : id de projet → mapping des clés .env
    /// (host/port/user/password/database). Aucun identifiant stocké, juste les
    /// noms de clés .env, pour pouvoir se reconnecter à la réouverture.
    #[serde(default)]
    db_connections: HashMap<String, serde_json::Value>,
    /// Nombre de lignes affichées par défaut dans l'aperçu d'une table.
    #[serde(default)]
    db_row_limit: Option<u32>,
    /// Services déclarés sans base de données : leur bouton BDD est masqué.
    #[serde(default)]
    db_disabled: HashMap<String, bool>,
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

/// Télécharge un fichier (installeur de mise à jour) dans le dossier
/// Téléchargements de l'utilisateur, sans passer par le navigateur.
/// Renvoie le chemin complet du fichier écrit.
#[tauri::command]
async fn download_file(app: AppHandle, url: String, filename: String) -> Result<String, String> {
    // Garde-fous : uniquement du HTTPS, et un nom de fichier sans chemin.
    if !url.starts_with("https://") {
        return Err("URL invalide (HTTPS requis)".into());
    }
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("Nom de fichier invalide".into());
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Dossier Téléchargements introuvable : {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(&filename);
        let resp = ureq::get(&url)
            .set("User-Agent", "DevLauncher")
            .call()
            .map_err(|e| format!("Téléchargement échoué : {e}"))?;
        let mut reader = resp.into_reader();
        // Écriture dans un fichier temporaire puis renommage : pas de fichier
        // partiel exploitable si le téléchargement est interrompu.
        let tmp = dir.join(format!("{filename}.part"));
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut reader, &mut out).map_err(|e| format!("Écriture échouée : {e}"))?;
        drop(out);
        let _ = std::fs::remove_file(&dest);
        std::fs::rename(&tmp, &dest).map_err(|e| format!("Renommage échoué : {e}"))?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ouvre l'explorateur sur un fichier (le sélectionne dans son dossier).
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Fichier introuvable".into());
    }
    std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
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
// Connexion base de données (test) : MariaDB/MySQL et PostgreSQL
// ---------------------------------------------------------------------------

/// Teste une connexion à la base d'un service. Les valeurs (host, identifiants…)
/// sont résolues côté front depuis le .env et passées ici en clair le temps du
/// test ; rien n'est stocké côté Rust. Renvoie la version du serveur si OK.
#[tauri::command]
async fn db_connect(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => pg_connect(&host, port, &user, &password, &database),
        "mariadb" | "mysql" => my_connect(&host, port, &user, &password, &database),
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Liste les tables (BASE TABLE) de la base d'un service.
#[tauri::command]
async fn db_tables(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => pg_tables(&host, port, &user, &password, &database),
        "mariadb" | "mysql" => my_tables(&host, port, &user, &password, &database),
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Message d'erreur Postgres lisible : le `Display` de l'erreur ne dit que
/// « db error », le vrai message SQL se trouve dans `as_db_error()`.
fn pg_err_msg(e: &postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => {
            let mut s = db.message().to_string();
            if let Some(detail) = db.detail() {
                s.push_str(" — ");
                s.push_str(detail);
            }
            if let Some(hint) = db.hint() {
                s.push_str(" (");
                s.push_str(hint);
                s.push(')');
            }
            s
        }
        None => e.to_string(),
    }
}

fn pg_client(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> Result<postgres::Client, String> {
    use postgres::{Config as PgConfig, NoTls};
    let mut cfg = PgConfig::new();
    cfg.host(host)
        .port(port)
        .user(user)
        .dbname(database)
        .connect_timeout(std::time::Duration::from_secs(5));
    if !password.is_empty() {
        cfg.password(password);
    }
    cfg.connect(NoTls)
        .map_err(|e| format!("Connexion PostgreSQL échouée : {}", pg_err_msg(&e)))
}

fn my_conn(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> Result<mysql::Conn, String> {
    use mysql::{Conn, OptsBuilder};
    let opts = OptsBuilder::new()
        .ip_or_hostname(Some(host.to_string()))
        .tcp_port(port)
        .user(Some(user.to_string()))
        .pass(Some(password.to_string()))
        .db_name(Some(database.to_string()))
        .tcp_connect_timeout(Some(std::time::Duration::from_secs(5)));
    Conn::new(opts).map_err(|e| format!("Connexion MariaDB échouée : {e}"))
}

fn pg_connect(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> Result<String, String> {
    let mut client = pg_client(host, port, user, password, database)?;
    let row = client
        .query_one("SELECT version()", &[])
        .map_err(|e| format!("Connecté mais requête échouée : {e}"))?;
    Ok(row.get::<_, String>(0))
}

fn pg_tables(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> Result<Vec<String>, String> {
    let mut client = pg_client(host, port, user, password, database)?;
    let rows = client
        .query(
            "SELECT table_schema, table_name FROM information_schema.tables \
             WHERE table_type = 'BASE TABLE' \
             AND table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name",
            &[],
        )
        .map_err(|e| format!("Lecture des tables échouée : {e}"))?;
    Ok(rows
        .iter()
        .map(|r| {
            let schema: String = r.get(0);
            let name: String = r.get(1);
            if schema == "public" {
                name
            } else {
                format!("{schema}.{name}")
            }
        })
        .collect())
}

fn my_connect(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> Result<String, String> {
    use mysql::prelude::Queryable;
    let mut conn = my_conn(host, port, user, password, database)?;
    let version: Option<String> = conn
        .query_first("SELECT VERSION()")
        .map_err(|e| format!("Connecté mais requête échouée : {e}"))?;
    Ok(version.unwrap_or_else(|| "MariaDB/MySQL".to_string()))
}

fn my_tables(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> Result<Vec<String>, String> {
    use mysql::prelude::Queryable;
    let mut conn = my_conn(host, port, user, password, database)?;
    let tables: Vec<String> = conn
        .query("SHOW TABLES")
        .map_err(|e| format!("Lecture des tables échouée : {e}"))?;
    Ok(tables)
}

/// Référence de clé étrangère : table + colonne cibles.
#[derive(Serialize, Clone)]
struct FkRef {
    table: String,
    column: String,
}

#[derive(Serialize)]
struct TableData {
    columns: Vec<String>,
    /// Type SQL de chaque colonne (aligné sur `columns`) : ex. "int4", "varchar".
    types: Vec<String>,
    /// Éditeur adapté par colonne : "text", "number", "bool" ou "enum".
    editors: Vec<String>,
    /// Valeurs possibles par colonne enum (vide sinon), aligné sur `columns`.
    enums: Vec<Vec<String>>,
    /// Colonne obligatoire à l'insertion (NOT NULL, sans défaut ni auto-généré).
    required: Vec<bool>,
    /// Clé étrangère par colonne (None sinon), aligné sur `columns`.
    fks: Vec<Option<FkRef>>,
    /// Chaque cellule est une chaîne, ou `null` pour un NULL SQL.
    rows: Vec<Vec<Option<String>>>,
}

/// Catégorie de comparaison déduite du type SQL de la colonne : pilote la façon
/// de comparer dans le filtre (numérique, booléen, ou texte lexicographique).
#[derive(Clone, Copy, PartialEq)]
enum ColKind {
    Num,
    Bool,
    Text,
}

#[derive(Clone)]
struct ColInfo {
    name: String,
    kind: ColKind,
}

fn pg_kind(type_name: &str) -> ColKind {
    match type_name {
        "int2" | "int4" | "int8" | "float4" | "float8" | "numeric" | "money" | "oid" => ColKind::Num,
        "bool" => ColKind::Bool,
        _ => ColKind::Text,
    }
}

/// Éditeur adapté au type Postgres (piloté par le nom du type SQL).
fn pg_editor(type_name: &str) -> &'static str {
    match type_name {
        "int2" | "int4" | "int8" | "float4" | "float8" | "numeric" | "money" | "oid" => "number",
        "bool" => "bool",
        "date" => "date",
        "time" | "timetz" => "time",
        "timestamp" | "timestamptz" => "datetime",
        _ => "text",
    }
}

/// Catégorie de comparaison MySQL à partir du DATA_TYPE d'information_schema.
fn my_kind_dt(data_type: &str) -> ColKind {
    match data_type {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal"
        | "numeric" | "float" | "double" | "year" | "bit" => ColKind::Num,
        _ => ColKind::Text,
    }
}

/// Éditeur MySQL adapté au type. `tinyint(1)` → booléen ; `enum` → liste.
fn my_editor(data_type: &str, column_type: &str) -> String {
    match data_type {
        "tinyint" if column_type.eq_ignore_ascii_case("tinyint(1)") => "bool",
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal"
        | "numeric" | "float" | "double" | "year" | "bit" => "number",
        "enum" => "enum",
        "date" => "date",
        "time" => "time",
        "datetime" | "timestamp" => "datetime",
        _ => "text",
    }
    .to_string()
}

/// Extrait les valeurs d'un type enum MySQL (« enum('a','b','c') »).
fn parse_mysql_enum(column_type: &str) -> Vec<String> {
    let start = match column_type.find('(') {
        Some(i) => i + 1,
        None => return vec![],
    };
    let end = column_type.rfind(')').unwrap_or(column_type.len());
    let chars: Vec<char> = column_type[start..end].chars().collect();
    let mut vals = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && (chars[i] == ',' || chars[i].is_whitespace()) {
            i += 1;
        }
        if i >= chars.len() || chars[i] != '\'' {
            break;
        }
        i += 1;
        let mut s = String::new();
        loop {
            if i >= chars.len() {
                break;
            }
            if chars[i] == '\'' {
                if i + 1 < chars.len() && chars[i + 1] == '\'' {
                    s.push('\'');
                    i += 2;
                    continue;
                }
                i += 1;
                break;
            }
            s.push(chars[i]);
            i += 1;
        }
        vals.push(s);
    }
    vals
}

// ---------------------------------------------------------------------------
// Filtre simple → clause WHERE paramétrée
//
// Grammaire (mots-clés insensibles à la casse) :
//   filtre    := condition ( (AND|OR) condition )*
//   condition := col = valeur | col (!=|<>) valeur | col LIKE valeur
//              | col [NOT] IN ( valeur, ... ) | col IS [NOT] NULL
//   valeur    := nombre | 'texte' | "texte" | true | false | mot
//
// Sécurité : les noms de colonnes sont validés contre les colonnes réelles de
// la table (liste blanche) ; toutes les valeurs sont liées en paramètres.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum FDriver {
    Pg,
    My,
}

enum Tok {
    Ident(String),
    Num(String),
    Str(String),
    Op(String),
}

fn ftokenize(s: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = s.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            i += 1;
            let mut val = String::new();
            loop {
                if i >= chars.len() {
                    return Err("Chaîne non terminée".into());
                }
                let ch = chars[i];
                if ch == quote {
                    if i + 1 < chars.len() && chars[i + 1] == quote {
                        val.push(quote);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                val.push(ch);
                i += 1;
            }
            toks.push(Tok::Str(val));
            continue;
        }
        if c.is_ascii_digit()
            || ((c == '-' || c == '+' || c == '.')
                && i + 1 < chars.len()
                && chars[i + 1].is_ascii_digit())
        {
            let mut num = String::new();
            if c == '-' || c == '+' {
                num.push(c);
                i += 1;
            }
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                num.push(chars[i]);
                i += 1;
            }
            toks.push(Tok::Num(num));
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let mut id = String::new();
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                id.push(chars[i]);
                i += 1;
            }
            toks.push(Tok::Ident(id));
            continue;
        }
        match c {
            '=' | '(' | ')' | ',' => {
                toks.push(Tok::Op(c.to_string()));
                i += 1;
            }
            '!' if i + 1 < chars.len() && chars[i + 1] == '=' => {
                toks.push(Tok::Op("!=".into()));
                i += 2;
            }
            '<' => {
                let n = chars.get(i + 1).copied();
                if n == Some('>') {
                    toks.push(Tok::Op("<>".into()));
                    i += 2;
                } else if n == Some('=') {
                    toks.push(Tok::Op("<=".into()));
                    i += 2;
                } else {
                    toks.push(Tok::Op("<".into()));
                    i += 1;
                }
            }
            '>' => {
                if chars.get(i + 1).copied() == Some('=') {
                    toks.push(Tok::Op(">=".into()));
                    i += 2;
                } else {
                    toks.push(Tok::Op(">".into()));
                    i += 1;
                }
            }
            _ => return Err(format!("Caractère inattendu : « {c} »")),
        }
    }
    Ok(toks)
}

enum FVal {
    Num(String),
    Str(String),
    Bool(bool),
}

fn fparse_value(tok: Option<&Tok>) -> Result<FVal, String> {
    match tok {
        Some(Tok::Num(s)) => Ok(FVal::Num(s.clone())),
        Some(Tok::Str(s)) => Ok(FVal::Str(s.clone())),
        Some(Tok::Ident(id)) if id.eq_ignore_ascii_case("true") => Ok(FVal::Bool(true)),
        Some(Tok::Ident(id)) if id.eq_ignore_ascii_case("false") => Ok(FVal::Bool(false)),
        Some(Tok::Ident(id)) => Ok(FVal::Str(id.clone())),
        _ => Err("Valeur attendue".into()),
    }
}

// Rend un paramètre lié en texte. Les booléens sont normalisés selon le pilote
// et le type de colonne : 'true'/'false' pour un booléen Postgres, sinon 1/0.
fn render_param(driver: FDriver, kind: ColKind, v: FVal) -> String {
    match v {
        FVal::Num(s) | FVal::Str(s) => s,
        FVal::Bool(b) => match (driver, kind) {
            (FDriver::Pg, ColKind::Bool) | (FDriver::Pg, ColKind::Text) => {
                if b { "true" } else { "false" }.to_string()
            }
            _ => if b { "1" } else { "0" }.to_string(),
        },
    }
}

fn fresolve_col(columns: &[ColInfo], name: &str) -> Result<ColInfo, String> {
    columns
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case(name))
        .cloned()
        .ok_or_else(|| format!("Colonne inconnue : « {name} »"))
}

fn fquote_col(driver: FDriver, col: &str) -> String {
    match driver {
        FDriver::Pg => format!("\"{}\"", col.replace('"', "\"\"")),
        FDriver::My => format!("`{}`", col.replace('`', "``")),
    }
}

fn fcast_col(driver: FDriver, col: &str) -> String {
    match driver {
        FDriver::Pg => format!("\"{}\"::text", col.replace('"', "\"\"")),
        FDriver::My => format!("CAST(`{}` AS CHAR)", col.replace('`', "``")),
    }
}

fn fplaceholder(driver: FDriver, n: usize) -> String {
    match driver {
        FDriver::Pg => format!("${n}"),
        FDriver::My => "?".into(),
    }
}

/// Expression du paramètre lié selon le type de colonne. Le paramètre est
/// toujours envoyé en texte (le driver sérialise une `String`) ; côté Postgres
/// on le force en texte avant de le caster (`($1::text)::numeric`), sinon
/// Postgres infère le type du paramètre depuis le cast et rejette la String
/// (« error serializing parameter »).
fn fplaceholder_expr(driver: FDriver, kind: ColKind, n: usize) -> String {
    let ph = fplaceholder(driver, n);
    match (driver, kind) {
        (FDriver::Pg, ColKind::Num) => format!("({ph}::text)::numeric"),
        (FDriver::Pg, ColKind::Bool) => format!("({ph}::text)::boolean"),
        _ => ph,
    }
}

/// Membre gauche d'une comparaison : la colonne native pour num/bool (comparaison
/// typée, donc correcte pour l'ordre), ou castée en texte pour le reste.
fn fcmp_lhs(driver: FDriver, col: &ColInfo) -> String {
    match col.kind {
        ColKind::Num | ColKind::Bool => fquote_col(driver, &col.name),
        ColKind::Text => fcast_col(driver, &col.name),
    }
}

/// Construit la clause WHERE (sans le mot « WHERE ») et les paramètres liés.
/// La comparaison est choisie d'après le type SQL de la colonne (`ColInfo`) :
/// numérique/booléen → comparaison typée (ordre correct), texte → lexicographique.
/// Filtre vide → ("", []).
fn build_where(
    columns: &[ColInfo],
    filter: &str,
    driver: FDriver,
) -> Result<(String, Vec<String>), String> {
    let toks = ftokenize(filter)?;
    if toks.is_empty() {
        return Ok((String::new(), vec![]));
    }
    let mut sql = String::new();
    let mut params: Vec<String> = Vec::new();
    let mut p = 0usize;
    // Ajoute « lhs op $n[cast] » avec le paramètre lié (valeur → texte).
    let push_binary =
        |sql: &mut String, params: &mut Vec<String>, col: &ColInfo, op: &str, v: FVal| {
            params.push(render_param(driver, col.kind, v));
            let ph = fplaceholder_expr(driver, col.kind, params.len());
            sql.push_str(&fcmp_lhs(driver, col));
            sql.push(' ');
            sql.push_str(op);
            sql.push(' ');
            sql.push_str(&ph);
        };
    loop {
        let col_name = match toks.get(p) {
            Some(Tok::Ident(s)) => s.clone(),
            _ => return Err("Nom de colonne attendu".into()),
        };
        let col = fresolve_col(columns, &col_name)?;
        p += 1;
        match toks.get(p) {
            Some(Tok::Ident(kw)) if kw.eq_ignore_ascii_case("is") => {
                p += 1;
                let mut not = false;
                if let Some(Tok::Ident(n)) = toks.get(p) {
                    if n.eq_ignore_ascii_case("not") {
                        not = true;
                        p += 1;
                    }
                }
                match toks.get(p) {
                    Some(Tok::Ident(nl)) if nl.eq_ignore_ascii_case("null") => p += 1,
                    _ => return Err("NULL attendu après IS".into()),
                }
                sql.push_str(&fquote_col(driver, &col.name));
                sql.push_str(if not { " IS NOT NULL" } else { " IS NULL" });
            }
            Some(Tok::Ident(kw))
                if kw.eq_ignore_ascii_case("in") || kw.eq_ignore_ascii_case("not") =>
            {
                let is_not = kw.eq_ignore_ascii_case("not");
                p += 1;
                if is_not {
                    match toks.get(p) {
                        Some(Tok::Ident(i)) if i.eq_ignore_ascii_case("in") => p += 1,
                        _ => return Err("IN attendu après NOT".into()),
                    }
                }
                match toks.get(p) {
                    Some(Tok::Op(o)) if o == "(" => p += 1,
                    _ => return Err("« ( » attendu après IN".into()),
                }
                let mut placeholders = Vec::new();
                loop {
                    let v = fparse_value(toks.get(p))?;
                    p += 1;
                    params.push(render_param(driver, col.kind, v));
                    placeholders.push(fplaceholder_expr(driver, col.kind, params.len()));
                    match toks.get(p) {
                        Some(Tok::Op(o)) if o == "," => p += 1,
                        Some(Tok::Op(o)) if o == ")" => {
                            p += 1;
                            break;
                        }
                        _ => return Err("« , » ou « ) » attendu dans IN".into()),
                    }
                }
                sql.push_str(&fcmp_lhs(driver, &col));
                sql.push_str(if is_not { " NOT IN (" } else { " IN (" });
                sql.push_str(&placeholders.join(", "));
                sql.push(')');
            }
            Some(Tok::Ident(kw)) if kw.eq_ignore_ascii_case("like") => {
                p += 1;
                let v = fparse_value(toks.get(p))?;
                p += 1;
                // LIKE : toujours sur la représentation texte.
                params.push(match v {
                    FVal::Num(s) | FVal::Str(s) => s,
                    FVal::Bool(b) => if b { "true" } else { "false" }.to_string(),
                });
                sql.push_str(&fcast_col(driver, &col.name));
                sql.push_str(" LIKE ");
                sql.push_str(&fplaceholder(driver, params.len()));
            }
            Some(Tok::Op(o))
                if matches!(o.as_str(), "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=") =>
            {
                let op = if o == "!=" { "<>" } else { o.as_str() };
                p += 1;
                let v = fparse_value(toks.get(p))?;
                p += 1;
                push_binary(&mut sql, &mut params, &col, op, v);
            }
            _ => {
                return Err(
                    "Opérateur attendu : =, !=, <, <=, >, >=, IN, LIKE ou IS NULL".into(),
                )
            }
        }
        match toks.get(p) {
            None => break,
            Some(Tok::Ident(kw)) if kw.eq_ignore_ascii_case("and") => {
                sql.push_str(" AND ");
                p += 1;
            }
            Some(Tok::Ident(kw)) if kw.eq_ignore_ascii_case("or") => {
                sql.push_str(" OR ");
                p += 1;
            }
            _ => return Err("AND / OR attendu entre les conditions".into()),
        }
    }
    Ok((sql, params))
}

/// Lit les premières lignes d'une table (bornées par `limit`). Les valeurs sont
/// renvoyées sous forme de texte (cast en base) pour un affichage uniforme.
#[tauri::command]
async fn db_table_rows(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    table: String,
    limit: u32,
    offset: u32,
    filter: String,
) -> Result<TableData, String> {
    let limit = limit.clamp(1, 100_000);
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => {
            pg_table_rows(&host, port, &user, &password, &database, &table, limit, offset, &filter)
        }
        "mariadb" | "mysql" => {
            my_table_rows(&host, port, &user, &password, &database, &table, limit, offset, &filter)
        }
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Qualifie un nom de table Postgres (« schema.name » ou « name ») en identifiant
/// cité, avec échappement des guillemets — évite toute injection via le nom.
fn pg_qualify(table: &str) -> String {
    let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    match table.split_once('.') {
        Some((schema, name)) => format!("{}.{}", quote(schema), quote(name)),
        None => quote(table),
    }
}

#[allow(clippy::too_many_arguments)]
fn pg_table_rows(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    limit: u32,
    offset: u32,
    filter: &str,
) -> Result<TableData, String> {
    let mut client = pg_client(host, port, user, password, database)?;
    let qualified = pg_qualify(table);
    // 1) Noms de colonnes (dans l'ordre) via un statement préparé « vide ».
    let stmt = client
        .prepare(&format!("SELECT * FROM {qualified} LIMIT 0"))
        .map_err(|e| format!("Table introuvable : {}", pg_err_msg(&e)))?;
    let cols_info: Vec<ColInfo> = stmt
        .columns()
        .iter()
        .map(|c| ColInfo {
            name: c.name().to_string(),
            kind: pg_kind(c.type_().name()),
        })
        .collect();
    let types: Vec<String> = stmt.columns().iter().map(|c| c.type_().name().to_string()).collect();
    // Éditeurs + valeurs enum (les enums Postgres exposent leurs variantes).
    let mut editors: Vec<String> = Vec::new();
    let mut enums: Vec<Vec<String>> = Vec::new();
    for c in stmt.columns() {
        match c.type_().kind() {
            postgres::types::Kind::Enum(vals) => {
                editors.push("enum".to_string());
                enums.push(vals.clone());
            }
            _ => {
                editors.push(pg_editor(c.type_().name()).to_string());
                enums.push(vec![]);
            }
        }
    }
    let columns: Vec<String> = cols_info.iter().map(|c| c.name.clone()).collect();
    // Colonnes obligatoires : NOT NULL, sans défaut, non-identity (serial inclus,
    // car ils ont un défaut nextval).
    let req_rows = client
        .query(
            "SELECT a.attname, a.attnotnull, \
             (pg_get_expr(d.adbin, d.adrelid) IS NOT NULL) AS has_default, \
             (a.attidentity <> '') AS is_identity \
             FROM pg_attribute a \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = ($1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped",
            &[&qualified],
        )
        .map_err(|e| format!("Lecture des contraintes échouée : {}", pg_err_msg(&e)))?;
    let mut req_map: HashMap<String, bool> = HashMap::new();
    for r in &req_rows {
        let name: String = r.get(0);
        let notnull: bool = r.get(1);
        let has_default: bool = r.get(2);
        let is_identity: bool = r.get(3);
        req_map.insert(name.to_lowercase(), notnull && !has_default && !is_identity);
    }
    let required: Vec<bool> =
        columns.iter().map(|c| *req_map.get(&c.to_lowercase()).unwrap_or(&false)).collect();
    // Clés étrangères (mono-colonne) : colonne → table.colonne cibles.
    let fk_rows = client
        .query(
            "SELECT a.attname, ns.nspname, cl.relname, af.attname \
             FROM pg_constraint c \
             JOIN pg_class cl ON cl.oid = c.confrelid \
             JOIN pg_namespace ns ON ns.oid = cl.relnamespace \
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] \
             JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1] \
             WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 \
             AND c.conrelid = ($1::text)::regclass",
            &[&qualified],
        )
        .map_err(|e| format!("Lecture des clés étrangères échouée : {}", pg_err_msg(&e)))?;
    let mut fk_map: HashMap<String, FkRef> = HashMap::new();
    for r in &fk_rows {
        let col: String = r.get(0);
        let fschema: String = r.get(1);
        let ftable: String = r.get(2);
        let fcol: String = r.get(3);
        let table = if fschema == "public" { ftable } else { format!("{fschema}.{ftable}") };
        fk_map.insert(col.to_lowercase(), FkRef { table, column: fcol });
    }
    let fks: Vec<Option<FkRef>> =
        columns.iter().map(|c| fk_map.get(&c.to_lowercase()).cloned()).collect();
    if columns.is_empty() {
        return Ok(TableData { columns, types, editors, enums, required, fks, rows: vec![] });
    }
    // 2) Valeurs castées en texte : lecture uniforme quel que soit le type.
    let cols_sql = columns
        .iter()
        .map(|c| format!("\"{}\"::text", c.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(", ");
    let (where_sql, params) = build_where(&cols_info, filter, FDriver::Pg)?;
    let where_clause = if where_sql.is_empty() {
        String::new()
    } else {
        format!(" WHERE {where_sql}")
    };
    let sql =
        format!("SELECT {cols_sql} FROM {qualified}{where_clause} LIMIT {limit} OFFSET {offset}");
    let param_refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
        params.iter().map(|s| s as &(dyn postgres::types::ToSql + Sync)).collect();
    let rows = client
        .query(&sql, &param_refs)
        .map_err(|e| format!("Lecture échouée : {}", pg_err_msg(&e)))?;
    let data = rows
        .iter()
        .map(|r| (0..columns.len()).map(|i| r.get::<_, Option<String>>(i)).collect())
        .collect();
    Ok(TableData { columns, types, editors, enums, required, fks, rows: data })
}

fn my_value_to_string(v: Option<&mysql::Value>) -> Option<String> {
    use mysql::Value;
    match v? {
        Value::NULL => None,
        Value::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, mo, d, h, mi, s, us) => {
            let frac = if *us > 0 { format!(".{us:06}") } else { String::new() };
            Some(format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}{frac}"))
        }
        Value::Time(neg, days, h, mi, s, us) => {
            let sign = if *neg { "-" } else { "" };
            let hours = *days * 24 + u32::from(*h);
            let frac = if *us > 0 { format!(".{us:06}") } else { String::new() };
            Some(format!("{sign}{hours:02}:{mi:02}:{s:02}{frac}"))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn my_table_rows(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    limit: u32,
    offset: u32,
    filter: &str,
) -> Result<TableData, String> {
    use mysql::prelude::Queryable;
    let mut conn = my_conn(host, port, user, password, database)?;
    let quoted = format!("`{}`", table.replace('`', "``"));
    // 1) Colonnes ordonnées (SELECT *) pour l'ordre d'affichage.
    let columns: Vec<String> = {
        let cols_res = conn
            .query_iter(format!("SELECT * FROM {quoted} LIMIT 0"))
            .map_err(|e| format!("Table introuvable : {e}"))?;
        cols_res.columns().as_ref().iter().map(|c| c.name_str().into_owned()).collect()
    };
    // 2) Métadonnées (type, éditeur, enum, obligatoire) depuis information_schema.
    //    (COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA)
    let meta: Vec<(String, String, String, String, Option<String>, String)> = conn
        .exec(
            "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (table,),
        )
        .map_err(|e| format!("Lecture des colonnes échouée : {e}"))?;
    let find_meta = |name: &str| {
        meta.iter()
            .find(|(n, ..)| n.eq_ignore_ascii_case(name))
            .cloned()
            .unwrap_or_else(|| {
                ("text".into(), "text".into(), String::new(), "YES".into(), None, String::new())
            })
    };
    let mut cols_info: Vec<ColInfo> = Vec::new();
    let mut types: Vec<String> = Vec::new();
    let mut editors: Vec<String> = Vec::new();
    let mut enums: Vec<Vec<String>> = Vec::new();
    let mut required: Vec<bool> = Vec::new();
    for name in &columns {
        let (_, dt, ct, nullable, default, extra) = find_meta(name);
        cols_info.push(ColInfo { name: name.clone(), kind: my_kind_dt(&dt) });
        editors.push(my_editor(&dt, &ct));
        enums.push(if dt == "enum" { parse_mysql_enum(&ct) } else { vec![] });
        let extra_lc = extra.to_lowercase();
        required.push(
            nullable.eq_ignore_ascii_case("NO")
                && default.is_none()
                && !extra_lc.contains("auto_increment")
                && !extra_lc.contains("default_generated"),
        );
        types.push(dt);
    }
    // Clés étrangères : colonne → table.colonne référencées.
    let fk_rows: Vec<(String, String, String)> = conn
        .exec(
            "SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? \
             AND REFERENCED_TABLE_NAME IS NOT NULL",
            (table,),
        )
        .map_err(|e| format!("Lecture des clés étrangères échouée : {e}"))?;
    let mut fk_map: HashMap<String, FkRef> = HashMap::new();
    for (col, ftable, fcol) in fk_rows {
        fk_map.insert(col.to_lowercase(), FkRef { table: ftable, column: fcol });
    }
    let fks: Vec<Option<FkRef>> =
        columns.iter().map(|c| fk_map.get(&c.to_lowercase()).cloned()).collect();
    // 3) Requête filtrée et paramétrée.
    let (where_sql, params) = build_where(&cols_info, filter, FDriver::My)?;
    let where_clause = if where_sql.is_empty() {
        String::new()
    } else {
        format!(" WHERE {where_sql}")
    };
    let sql = format!("SELECT * FROM {quoted}{where_clause} LIMIT {limit} OFFSET {offset}");
    let my_params = if params.is_empty() {
        mysql::Params::Empty
    } else {
        mysql::Params::Positional(params.iter().map(|s| mysql::Value::from(s.as_str())).collect())
    };
    let mut result = conn
        .exec_iter(sql, my_params)
        .map_err(|e| format!("Lecture échouée : {e}"))?;
    let mut rows = Vec::new();
    for row in result.by_ref() {
        let row = row.map_err(|e| e.to_string())?;
        let cells = (0..columns.len())
            .map(|i| my_value_to_string(row.as_ref(i)))
            .collect();
        rows.push(cells);
    }
    Ok(TableData { columns, types, editors, enums, required, fks, rows })
}

// ---------------------------------------------------------------------------
// Structure d'une table : colonnes détaillées, index et contraintes
// ---------------------------------------------------------------------------

/// Cible d'une clé étrangère, avec ses règles de propagation.
#[derive(Serialize, Clone)]
struct SchemaFk {
    table: String,
    column: String,
    on_update: Option<String>,
    on_delete: Option<String>,
}

/// Description complète d'une colonne (onglet « Structure »).
#[derive(Serialize)]
struct SchemaColumn {
    name: String,
    /// Position dans la table (1-based).
    position: u32,
    /// Type SQL complet tel que déclaré : « varchar(255) », « numeric(10,2) ».
    full_type: String,
    /// Type de base sans précision : « varchar », « int4 ».
    base_type: String,
    nullable: bool,
    default: Option<String>,
    /// Mentions supplémentaires : « auto_increment », « identity », « generated »…
    extra: String,
    comment: Option<String>,
    primary_key: bool,
    /// Couverte par une contrainte d'unicité (seule ou en tête d'index unique).
    unique: bool,
    /// Apparaît dans au moins un index.
    indexed: bool,
    fk: Option<SchemaFk>,
    /// Valeurs possibles d'une colonne enum (vide sinon).
    enum_values: Vec<String>,
    collation: Option<String>,
}

#[derive(Serialize)]
struct SchemaIndex {
    name: String,
    unique: bool,
    primary: bool,
    /// Méthode d'indexation : « BTREE », « HASH », « gin »…
    kind: String,
    columns: Vec<String>,
    /// Définition SQL complète (Postgres uniquement).
    definition: Option<String>,
}

#[derive(Serialize)]
struct SchemaConstraint {
    name: String,
    /// « PRIMARY KEY », « UNIQUE », « FOREIGN KEY » ou « CHECK ».
    kind: String,
    columns: Vec<String>,
    /// Cible d'une clé étrangère, au format « table(colonne) ».
    references: Option<String>,
    on_update: Option<String>,
    on_delete: Option<String>,
    /// Expression d'un CHECK, ou définition complète de la contrainte.
    expression: Option<String>,
}

#[derive(Serialize)]
struct TableSchema {
    table: String,
    /// Moteur de stockage (MariaDB/MySQL) ou type de relation (Postgres).
    engine: Option<String>,
    collation: Option<String>,
    comment: Option<String>,
    /// Nombre de lignes *estimé* par le moteur (statistiques, non exact).
    est_rows: Option<i64>,
    /// Taille totale (données + index), lisible.
    size: Option<String>,
    columns: Vec<SchemaColumn>,
    indexes: Vec<SchemaIndex>,
    constraints: Vec<SchemaConstraint>,
}

/// Taille en octets → texte lisible (« 12,4 Mo »).
fn human_size(bytes: i64) -> String {
    if bytes < 0 {
        return String::new();
    }
    const UNITS: [&str; 5] = ["o", "Ko", "Mo", "Go", "To"];
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{bytes} o")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

/// Lit la structure d'une table : colonnes (type, nullabilité, défaut, clés,
/// commentaire…), index et contraintes.
#[tauri::command]
async fn db_table_schema(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    table: String,
) -> Result<TableSchema, String> {
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => pg_table_schema(&host, port, &user, &password, &database, &table),
        "mariadb" | "mysql" => my_table_schema(&host, port, &user, &password, &database, &table),
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn pg_table_schema(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
) -> Result<TableSchema, String> {
    let mut client = pg_client(host, port, user, password, database)?;
    let qualified = pg_qualify(table);

    // --- Informations sur la relation elle-même ---
    let rel = client
        .query_one(
            "SELECT obj_description(c.oid, 'pg_class'), \
             c.reltuples::bigint, \
             pg_total_relation_size(c.oid)::bigint, \
             am.amname::text, \
             (SELECT d.datcollate FROM pg_database d WHERE d.datname = current_database()) \
             FROM pg_class c \
             LEFT JOIN pg_am am ON am.oid = c.relam \
             WHERE c.oid = ($1::text)::regclass",
            &[&qualified],
        )
        .map_err(|e| format!("Table introuvable : {}", pg_err_msg(&e)))?;
    let comment: Option<String> = rel.get(0);
    let est_rows: Option<i64> = rel.get(1);
    let size_bytes: Option<i64> = rel.get(2);
    let engine: Option<String> = rel.get(3);
    // Collation de la base : c'est elle que résout la collation « default » des
    // colonnes, affichée une seule fois dans le résumé de la table.
    let db_collation: Option<String> = rel.get(4);

    // --- Colonnes ---
    let col_rows = client
        .query(
            "SELECT a.attnum::int, \
             a.attname::text, \
             format_type(a.atttypid, a.atttypmod), \
             t.typname::text, \
             a.attnotnull, \
             pg_get_expr(d.adbin, d.adrelid), \
             (a.attidentity <> ''), \
             col_description(a.attrelid, a.attnum), \
             CASE WHEN t.typtype = 'e' THEN \
               ARRAY(SELECT e.enumlabel::text FROM pg_enum e \
                     WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) \
               ELSE ARRAY[]::text[] END, \
             (SELECT co.collname::text FROM pg_collation co WHERE co.oid = a.attcollation) \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = ($1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&qualified],
        )
        .map_err(|e| format!("Lecture des colonnes échouée : {}", pg_err_msg(&e)))?;

    // --- Contraintes (définition complète fournie par Postgres) ---
    let con_rows = client
        .query(
            "SELECT c.conname::text, \
             c.contype::text, \
             pg_get_constraintdef(c.oid), \
             ARRAY(SELECT a.attname::text \
                   FROM unnest(c.conkey) WITH ORDINALITY AS u(num, ord) \
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.num \
                   ORDER BY u.ord), \
             ns.nspname::text, cl.relname::text, \
             ARRAY(SELECT af.attname::text \
                   FROM unnest(c.confkey) WITH ORDINALITY AS uf(num, ord) \
                   JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = uf.num \
                   ORDER BY uf.ord), \
             c.confupdtype::text, c.confdeltype::text \
             FROM pg_constraint c \
             LEFT JOIN pg_class cl ON cl.oid = c.confrelid \
             LEFT JOIN pg_namespace ns ON ns.oid = cl.relnamespace \
             WHERE c.conrelid = ($1::text)::regclass \
             ORDER BY CASE c.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, \
             c.conname",
            &[&qualified],
        )
        .map_err(|e| format!("Lecture des contraintes échouée : {}", pg_err_msg(&e)))?;

    // Règle de propagation Postgres : lettre → libellé SQL.
    let fk_rule = |c: &str| match c {
        "a" => "NO ACTION",
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    };

    let mut constraints: Vec<SchemaConstraint> = Vec::new();
    let mut pk_cols: HashSet<String> = HashSet::new();
    let mut uniq_cols: HashSet<String> = HashSet::new();
    let mut fk_map: HashMap<String, SchemaFk> = HashMap::new();
    for r in &con_rows {
        let name: String = r.get(0);
        let ctype: String = r.get(1);
        let def: String = r.get(2);
        let cols: Vec<String> = r.get(3);
        let fschema: Option<String> = r.get(4);
        let ftable: Option<String> = r.get(5);
        let fcols: Vec<String> = r.get(6);
        let upd: Option<String> = r.get(7);
        let del: Option<String> = r.get(8);
        let kind = match ctype.as_str() {
            "p" => "PRIMARY KEY",
            "u" => "UNIQUE",
            "f" => "FOREIGN KEY",
            "c" => "CHECK",
            _ => "AUTRE",
        };
        match ctype.as_str() {
            "p" => pk_cols.extend(cols.iter().map(|c| c.to_lowercase())),
            "u" => uniq_cols.extend(cols.iter().map(|c| c.to_lowercase())),
            _ => {}
        }
        // Cible d'une clé étrangère : « table(col1, col2) », schéma préfixé hors public.
        let mut references = None;
        if let (Some(ftable), false) = (&ftable, fcols.is_empty()) {
            let full = match fschema.as_deref() {
                Some("public") | None => ftable.clone(),
                Some(s) => format!("{s}.{ftable}"),
            };
            references = Some(format!("{full}({})", fcols.join(", ")));
            // Suivi de FK côté colonne : mono-colonne uniquement.
            if ctype == "f" && cols.len() == 1 && fcols.len() == 1 {
                fk_map.insert(
                    cols[0].to_lowercase(),
                    SchemaFk {
                        table: full,
                        column: fcols[0].clone(),
                        on_update: upd.as_deref().map(|c| fk_rule(c).to_string()),
                        on_delete: del.as_deref().map(|c| fk_rule(c).to_string()),
                    },
                );
            }
        }
        constraints.push(SchemaConstraint {
            name,
            kind: kind.to_string(),
            columns: cols,
            references,
            on_update: if ctype == "f" {
                upd.as_deref().map(|c| fk_rule(c).to_string())
            } else {
                None
            },
            on_delete: if ctype == "f" {
                del.as_deref().map(|c| fk_rule(c).to_string())
            } else {
                None
            },
            expression: Some(def),
        });
    }

    // --- Index ---
    let idx_rows = client
        .query(
            "SELECT i.relname::text, ix.indisunique, ix.indisprimary, am.amname::text, \
             pg_get_indexdef(ix.indexrelid), \
             ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true) \
                   FROM generate_series(1, ix.indnatts::int) AS k) \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             LEFT JOIN pg_am am ON am.oid = i.relam \
             WHERE ix.indrelid = ($1::text)::regclass \
             ORDER BY ix.indisprimary DESC, ix.indisunique DESC, i.relname",
            &[&qualified],
        )
        .map_err(|e| format!("Lecture des index échouée : {}", pg_err_msg(&e)))?;
    let mut indexes: Vec<SchemaIndex> = Vec::new();
    let mut indexed_cols: HashSet<String> = HashSet::new();
    for r in &idx_rows {
        let cols: Vec<String> = r.get(5);
        let unique: bool = r.get(1);
        indexed_cols.extend(cols.iter().map(|c| c.to_lowercase()));
        // Index unique mono-colonne : la colonne est unique même sans contrainte.
        if unique && cols.len() == 1 {
            uniq_cols.insert(cols[0].to_lowercase());
        }
        indexes.push(SchemaIndex {
            name: r.get(0),
            unique,
            primary: r.get(2),
            kind: r.get::<_, Option<String>>(3).unwrap_or_default(),
            columns: cols,
            definition: r.get(4),
        });
    }

    let mut columns: Vec<SchemaColumn> = Vec::new();
    for r in &col_rows {
        let position: i32 = r.get(0);
        let name: String = r.get(1);
        let full_type: String = r.get(2);
        let base_type: String = r.get(3);
        let notnull: bool = r.get(4);
        let default: Option<String> = r.get(5);
        let is_identity: bool = r.get(6);
        let comment: Option<String> = r.get(7);
        let enum_values: Vec<String> = r.get(8);
        let collation: Option<String> = r.get(9);
        let key = name.to_lowercase();
        let mut extra: Vec<&str> = Vec::new();
        if is_identity {
            extra.push("identity");
        }
        if default.as_deref().is_some_and(|d| d.starts_with("nextval(")) {
            extra.push("auto-incrément");
        }
        columns.push(SchemaColumn {
            position: position.max(0) as u32,
            primary_key: pk_cols.contains(&key),
            unique: uniq_cols.contains(&key),
            indexed: indexed_cols.contains(&key),
            fk: fk_map.get(&key).cloned(),
            nullable: !notnull,
            default,
            extra: extra.join(", "),
            comment,
            enum_values,
            collation,
            name,
            full_type,
            base_type,
        });
    }

    Ok(TableSchema {
        table: table.to_string(),
        engine,
        collation: db_collation,
        comment,
        est_rows: est_rows.filter(|n| *n >= 0),
        size: size_bytes.map(human_size),
        columns,
        indexes,
        constraints,
    })
}

fn my_table_schema(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
) -> Result<TableSchema, String> {
    use mysql::prelude::Queryable;
    let mut conn = my_conn(host, port, user, password, database)?;
    // Toutes les valeurs passent par `my_value_to_string` : conversion tolérante,
    // quel que soit le type renvoyé par le serveur (bytes, entiers…).
    let cell = |row: &mysql::Row, i: usize| my_value_to_string(row.as_ref(i));
    let num = |row: &mysql::Row, i: usize| cell(row, i).and_then(|s| s.parse::<i64>().ok());

    // --- Informations sur la table ---
    let info: Option<mysql::Row> = conn
        .exec_first(
            "SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT, TABLE_ROWS, \
             (IFNULL(DATA_LENGTH, 0) + IFNULL(INDEX_LENGTH, 0)) \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
            (table,),
        )
        .map_err(|e| format!("Lecture de la table échouée : {e}"))?;
    let (engine, collation, comment, est_rows, size) = match &info {
        Some(r) => (
            cell(r, 0),
            cell(r, 1),
            cell(r, 2).filter(|s| !s.is_empty()),
            num(r, 3),
            num(r, 4).map(human_size),
        ),
        None => (None, None, None, None, None),
    };

    // --- Contraintes (PK / UNIQUE / FK) ---
    let con_rows: Vec<mysql::Row> = conn
        .exec(
            "SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, kcu.COLUMN_NAME, \
             kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, \
             rc.UPDATE_RULE, rc.DELETE_RULE \
             FROM information_schema.TABLE_CONSTRAINTS tc \
             JOIN information_schema.KEY_COLUMN_USAGE kcu \
               ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
              AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
              AND kcu.TABLE_NAME = tc.TABLE_NAME \
             LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
               ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
              AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
              AND rc.TABLE_NAME = tc.TABLE_NAME \
             WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? \
             ORDER BY FIELD(tc.CONSTRAINT_TYPE, 'PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY'), \
             tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            (table,),
        )
        .map_err(|e| format!("Lecture des contraintes échouée : {e}"))?;

    // Les lignes arrivent à plat (une par colonne) : on regroupe par contrainte
    // en conservant l'ordre de tri.
    let mut constraints: Vec<SchemaConstraint> = Vec::new();
    let mut pk_cols: HashSet<String> = HashSet::new();
    let mut uniq_cols: HashSet<String> = HashSet::new();
    let mut fk_map: HashMap<String, SchemaFk> = HashMap::new();
    for r in &con_rows {
        let name = cell(r, 0).unwrap_or_default();
        let kind = cell(r, 1).unwrap_or_default();
        let col = cell(r, 2).unwrap_or_default();
        let ftable = cell(r, 3);
        let fcol = cell(r, 4);
        let upd = cell(r, 5);
        let del = cell(r, 6);
        match kind.as_str() {
            "PRIMARY KEY" => {
                pk_cols.insert(col.to_lowercase());
            }
            "UNIQUE" => {
                uniq_cols.insert(col.to_lowercase());
            }
            "FOREIGN KEY" => {
                if let (Some(t), Some(fc)) = (&ftable, &fcol) {
                    fk_map.insert(
                        col.to_lowercase(),
                        SchemaFk {
                            table: t.clone(),
                            column: fc.clone(),
                            on_update: upd.clone(),
                            on_delete: del.clone(),
                        },
                    );
                }
            }
            _ => {}
        }
        match constraints.last_mut() {
            // Même contrainte que la ligne précédente : on ajoute la colonne.
            Some(last) if last.name == name && last.kind == kind => {
                last.columns.push(col);
                if let (Some(t), Some(fc)) = (&ftable, &fcol) {
                    last.references = Some(format!("{t}({fc})"));
                }
            }
            _ => constraints.push(SchemaConstraint {
                name,
                kind,
                columns: vec![col],
                references: match (&ftable, &fcol) {
                    (Some(t), Some(fc)) => Some(format!("{t}({fc})")),
                    _ => None,
                },
                on_update: upd,
                on_delete: del,
                expression: None,
            }),
        }
    }

    // --- Contraintes CHECK (MariaDB 10.2+ / MySQL 8.0.16+) : absentes des
    //     serveurs plus anciens, l'erreur est alors ignorée. ---
    let check_rows: Vec<mysql::Row> = conn
        .exec(
            "SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE \
             FROM information_schema.TABLE_CONSTRAINTS tc \
             JOIN information_schema.CHECK_CONSTRAINTS cc \
               ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
              AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
             WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? \
             AND tc.CONSTRAINT_TYPE = 'CHECK'",
            (table,),
        )
        .unwrap_or_default();
    for r in &check_rows {
        constraints.push(SchemaConstraint {
            name: cell(r, 0).unwrap_or_default(),
            kind: "CHECK".into(),
            columns: vec![],
            references: None,
            on_update: None,
            on_delete: None,
            expression: cell(r, 1),
        });
    }

    // --- Index ---
    let idx_rows: Vec<mysql::Row> = conn
        .exec(
            "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? \
             ORDER BY (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX",
            (table,),
        )
        .map_err(|e| format!("Lecture des index échouée : {e}"))?;
    let mut indexes: Vec<SchemaIndex> = Vec::new();
    let mut indexed_cols: HashSet<String> = HashSet::new();
    for r in &idx_rows {
        let name = cell(r, 0).unwrap_or_default();
        let unique = num(r, 1).unwrap_or(1) == 0;
        // NULL pour un index fonctionnel (MySQL 8) : on affiche l'expression.
        let col = cell(r, 2).unwrap_or_else(|| "(expression)".into());
        indexed_cols.insert(col.to_lowercase());
        match indexes.last_mut() {
            Some(last) if last.name == name => last.columns.push(col),
            _ => indexes.push(SchemaIndex {
                primary: name == "PRIMARY",
                name,
                unique,
                kind: cell(r, 3).unwrap_or_default(),
                columns: vec![col],
                definition: None,
            }),
        }
    }
    // Index unique mono-colonne : la colonne est unique même sans contrainte.
    for idx in &indexes {
        if idx.unique && idx.columns.len() == 1 {
            uniq_cols.insert(idx.columns[0].to_lowercase());
        }
    }

    // --- Colonnes ---
    let col_rows: Vec<mysql::Row> = conn
        .exec(
            "SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, \
             COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLLATION_NAME \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION",
            (table,),
        )
        .map_err(|e| format!("Lecture des colonnes échouée : {e}"))?;
    if col_rows.is_empty() {
        return Err(format!("Table introuvable : {table}"));
    }
    // MariaDB renvoie COLUMN_DEFAULT comme une *expression* SQL (« 'abc' ») ;
    // MySQL 8 renvoie le littéral brut (« abc ») sauf pour les défauts calculés
    // (marqués DEFAULT_GENERATED). On normalise pour que la valeur affichée soit
    // toujours une expression SQL valide, réutilisable telle quelle en ALTER.
    let is_mariadb = conn
        .query_first::<String, _>("SELECT VERSION()")
        .ok()
        .flatten()
        .is_some_and(|v| v.to_lowercase().contains("mariadb"));

    let mut columns: Vec<SchemaColumn> = Vec::new();
    for r in &col_rows {
        let name = cell(r, 0).unwrap_or_default();
        let full_type = cell(r, 2).unwrap_or_default();
        let base_type = cell(r, 3).unwrap_or_default();
        let key = name.to_lowercase();
        let extra = cell(r, 6).unwrap_or_default();
        let default = cell(r, 5).map(|d| {
            let literal = !is_mariadb
                && !extra.to_lowercase().contains("default_generated")
                && my_kind_dt(&base_type) == ColKind::Text;
            if literal {
                my_quote_str(&d)
            } else {
                d
            }
        });
        columns.push(SchemaColumn {
            position: num(r, 1).unwrap_or(0).max(0) as u32,
            nullable: cell(r, 4).is_some_and(|s| s.eq_ignore_ascii_case("YES")),
            default,
            extra,
            comment: cell(r, 7).filter(|s| !s.is_empty()),
            collation: cell(r, 8),
            primary_key: pk_cols.contains(&key),
            unique: uniq_cols.contains(&key),
            indexed: indexed_cols.contains(&key),
            fk: fk_map.get(&key).cloned(),
            enum_values: if base_type == "enum" || base_type == "set" {
                parse_mysql_enum(&full_type)
            } else {
                vec![]
            },
            name,
            full_type,
            base_type,
        });
    }

    Ok(TableSchema {
        table: table.to_string(),
        engine,
        collation,
        comment,
        est_rows,
        size,
        columns,
        indexes,
        constraints,
    })
}

/// Liste les noms de colonnes d'une table, dans l'ordre de déclaration. Sert à
/// alimenter les listes déroulantes de l'onglet « Structure » (cible d'une clé
/// étrangère notamment) sans relire toute la structure.
#[tauri::command]
async fn db_table_columns(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    table: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => {
            let mut client = pg_client(&host, port, &user, &password, &database)?;
            let stmt = client
                .prepare(&format!("SELECT * FROM {} LIMIT 0", pg_qualify(&table)))
                .map_err(|e| format!("Table introuvable : {}", pg_err_msg(&e)))?;
            Ok(stmt.columns().iter().map(|c| c.name().to_string()).collect())
        }
        "mariadb" | "mysql" => {
            use mysql::prelude::Queryable;
            let mut conn = my_conn(&host, port, &user, &password, &database)?;
            let res = conn
                .query_iter(format!("SELECT * FROM {} LIMIT 0", my_quote_ident(&table)))
                .map_err(|e| format!("Table introuvable : {e}"))?;
            Ok(res
                .columns()
                .as_ref()
                .iter()
                .map(|c| c.name_str().into_owned())
                .collect())
        }
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Modification de la structure : colonnes, index et contraintes
// ---------------------------------------------------------------------------

/// Une modification demandée depuis l'onglet « Structure ». Pour une colonne,
/// `col_type`, `default` et `comment` décrivent l'état *voulu*.
#[derive(Deserialize)]
#[serde(tag = "op")]
enum SchemaChange {
    #[serde(rename = "col_add")]
    ColAdd {
        name: String,
        #[serde(rename = "type")]
        col_type: String,
        nullable: bool,
        default: Option<String>,
        comment: Option<String>,
    },
    #[serde(rename = "col_modify")]
    ColModify {
        /// Nom actuel de la colonne (cible de l'ALTER).
        name: String,
        new_name: String,
        #[serde(rename = "type")]
        col_type: String,
        /// Type actuel : si identique, aucune conversion de type n'est émise.
        old_type: String,
        nullable: bool,
        default: Option<String>,
        comment: Option<String>,
        /// EXTRA MariaDB/MySQL à préserver (auto_increment, on update…).
        extra: String,
    },
    #[serde(rename = "col_drop")]
    ColDrop { name: String },
    #[serde(rename = "idx_add")]
    IdxAdd {
        name: String,
        unique: bool,
        columns: Vec<String>,
    },
    #[serde(rename = "idx_drop")]
    IdxDrop { name: String },
    #[serde(rename = "con_add")]
    ConAdd {
        name: String,
        /// « PRIMARY KEY », « UNIQUE », « FOREIGN KEY » ou « CHECK ».
        kind: String,
        columns: Vec<String>,
        ref_table: Option<String>,
        ref_columns: Vec<String>,
        on_update: Option<String>,
        on_delete: Option<String>,
        /// Expression d'un CHECK.
        expression: Option<String>,
    },
    #[serde(rename = "con_drop")]
    ConDrop { name: String, kind: String },
}

/// Ordre d'exécution : on libère (contraintes puis index) avant de toucher aux
/// colonnes, et on recrée à la fin, une fois les colonnes en place.
fn change_rank(c: &SchemaChange) -> u8 {
    match c {
        SchemaChange::ConDrop { .. } => 0,
        SchemaChange::IdxDrop { .. } => 1,
        SchemaChange::ColModify { .. } => 2,
        SchemaChange::ColAdd { .. } => 3,
        SchemaChange::ColDrop { .. } => 4,
        SchemaChange::IdxAdd { .. } => 5,
        SchemaChange::ConAdd { .. } => 6,
    }
}

/// Trie les modifications dans l'ordre d'exécution (tri stable : à rang égal,
/// l'ordre de saisie est conservé).
fn ordered_changes(changes: &[SchemaChange]) -> Vec<&SchemaChange> {
    let mut v: Vec<&SchemaChange> = changes.iter().collect();
    v.sort_by_key(|c| change_rank(c));
    v
}

/// Valide le type d'une contrainte et le normalise en majuscules.
fn check_con_kind(kind: &str) -> Result<String, String> {
    let k = kind.trim().to_uppercase();
    match k.as_str() {
        "PRIMARY KEY" | "UNIQUE" | "FOREIGN KEY" | "CHECK" => Ok(k),
        _ => Err(format!("Type de contrainte inconnu : « {kind} »")),
    }
}

/// Valide une règle de propagation de clé étrangère (liste blanche).
fn check_fk_rule(rule: &str) -> Result<String, String> {
    let r = rule.trim().to_uppercase();
    match r.as_str() {
        "CASCADE" | "RESTRICT" | "SET NULL" | "SET DEFAULT" | "NO ACTION" => Ok(r),
        _ => Err(format!("Règle de clé étrangère inconnue : « {rule} »")),
    }
}

/// Liste de colonnes citées, refusant une liste vide.
fn quote_cols(cols: &[String], quote: fn(&str) -> String) -> Result<String, String> {
    if cols.is_empty() {
        return Err("Aucune colonne indiquée.".into());
    }
    for c in cols {
        check_ident(c)?;
    }
    Ok(cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", "))
}

/// Corps d'une contrainte : « PRIMARY KEY (…) », « FOREIGN KEY (…) REFERENCES … ».
/// `quote_ident` cite une colonne, `quote_table` la table référencée.
fn constraint_body(
    kind: &str,
    columns: &[String],
    ref_table: Option<&str>,
    ref_columns: &[String],
    on_update: Option<&str>,
    on_delete: Option<&str>,
    expression: Option<&str>,
    quote_ident: fn(&str) -> String,
    quote_table: fn(&str) -> String,
) -> Result<String, String> {
    match kind {
        "PRIMARY KEY" => Ok(format!("PRIMARY KEY ({})", quote_cols(columns, quote_ident)?)),
        "UNIQUE" => Ok(format!("UNIQUE ({})", quote_cols(columns, quote_ident)?)),
        "CHECK" => {
            let e = expression.unwrap_or("").trim();
            check_sql_fragment("Expression du CHECK", e)?;
            Ok(format!("CHECK ({e})"))
        }
        "FOREIGN KEY" => {
            let rt = ref_table
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .ok_or("Clé étrangère sans table référencée.")?;
            check_ident(rt)?;
            let mut s = format!(
                "FOREIGN KEY ({}) REFERENCES {} ({})",
                quote_cols(columns, quote_ident)?,
                quote_table(rt),
                quote_cols(ref_columns, quote_ident)?
            );
            if let Some(r) = on_delete.map(str::trim).filter(|r| !r.is_empty()) {
                s.push_str(" ON DELETE ");
                s.push_str(&check_fk_rule(r)?);
            }
            if let Some(r) = on_update.map(str::trim).filter(|r| !r.is_empty()) {
                s.push_str(" ON UPDATE ");
                s.push_str(&check_fk_rule(r)?);
            }
            Ok(s)
        }
        _ => Err(format!("Type de contrainte inconnu : « {kind} »")),
    }
}

#[derive(Serialize)]
struct AlterResult {
    added: u32,
    modified: u32,
    dropped: u32,
    /// Instructions réellement exécutées (journalisées côté interface).
    statements: Vec<String>,
}

/// Littéral texte MariaDB/MySQL.
fn my_quote_str(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

/// Littéral texte Postgres.
fn pg_quote_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Identifiant Postgres cité.
fn pg_quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Identifiant MariaDB/MySQL cité.
fn my_quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

/// Garde-fou sur un fragment SQL saisi à la main (type, expression par défaut) :
/// ces morceaux ne peuvent pas être passés en paramètre lié dans du DDL, on
/// interdit donc tout ce qui permettrait d'enchaîner une autre instruction.
fn check_sql_fragment(what: &str, s: &str) -> Result<(), String> {
    let t = s.trim();
    if t.is_empty() {
        return Err(format!("{what} vide."));
    }
    if t.contains(';') || t.contains("--") || t.contains("/*") || t.contains('\0') {
        return Err(format!("{what} invalide : « {s} »"));
    }
    Ok(())
}

/// Vérifie qu'un nom de colonne est utilisable tel quel (le citer suffit à le
/// rendre sûr, mais on écarte les cas manifestement erronés).
fn check_ident(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Nom de colonne vide.".into());
    }
    if name.contains('\0') {
        return Err(format!("Nom de colonne invalide : « {name} »"));
    }
    Ok(())
}

/// Applique des modifications de structure (colonnes, index, contraintes).
/// Postgres : le tout dans une transaction. MariaDB/MySQL : le DDL déclenche un
/// commit implicite, les instructions sont donc jouées en série et l'exécution
/// s'arrête à la première erreur (les précédentes restent acquises).
#[tauri::command]
async fn db_alter_table(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    table: String,
    changes: Vec<SchemaChange>,
) -> Result<AlterResult, String> {
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => pg_alter_table(&host, port, &user, &password, &database, &table, &changes),
        "mariadb" | "mysql" => {
            my_alter_table(&host, port, &user, &password, &database, &table, &changes)
        }
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Définition complète d'une colonne MariaDB/MySQL (utilisée par ADD et CHANGE).
fn my_col_def(
    col_type: &str,
    nullable: bool,
    default: Option<&str>,
    comment: Option<&str>,
    extra: &str,
) -> Result<String, String> {
    check_sql_fragment("Type", col_type)?;
    let mut s = col_type.trim().to_string();
    s.push_str(if nullable { " NULL" } else { " NOT NULL" });
    if let Some(d) = default.map(str::trim).filter(|d| !d.is_empty()) {
        check_sql_fragment("Valeur par défaut", d)?;
        s.push_str(" DEFAULT ");
        s.push_str(d);
    }
    // EXTRA n'est pas modifiable ici mais doit être reconduit, sinon CHANGE
    // COLUMN le supprimerait silencieusement.
    let extra_lc = extra.to_lowercase();
    if extra_lc.contains("auto_increment") {
        s.push_str(" AUTO_INCREMENT");
    }
    if extra_lc.contains("on update current_timestamp") {
        s.push_str(" ON UPDATE CURRENT_TIMESTAMP");
    }
    if let Some(c) = comment {
        s.push_str(" COMMENT ");
        s.push_str(&my_quote_str(c));
    }
    Ok(s)
}

fn my_alter_table(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    changes: &[SchemaChange],
) -> Result<AlterResult, String> {
    use mysql::prelude::Queryable;
    let quoted = my_quote_ident(table);
    // Construction de toutes les instructions d'abord : une saisie invalide
    // échoue avant d'avoir touché la base.
    let mut stmts: Vec<String> = Vec::new();
    let (mut added, mut modified, mut dropped) = (0u32, 0u32, 0u32);
    for ch in ordered_changes(changes) {
        match ch {
            SchemaChange::ColAdd {
                name,
                col_type,
                nullable,
                default,
                comment,
            } => {
                check_ident(name)?;
                let def = my_col_def(col_type, *nullable, default.as_deref(), comment.as_deref(), "")?;
                stmts.push(format!(
                    "ALTER TABLE {quoted} ADD COLUMN {} {def}",
                    my_quote_ident(name)
                ));
                added += 1;
            }
            SchemaChange::ColModify {
                name,
                new_name,
                col_type,
                nullable,
                default,
                comment,
                extra,
                ..
            } => {
                check_ident(name)?;
                check_ident(new_name)?;
                let def = my_col_def(
                    col_type,
                    *nullable,
                    default.as_deref(),
                    comment.as_deref(),
                    extra,
                )?;
                stmts.push(format!(
                    "ALTER TABLE {quoted} CHANGE COLUMN {} {} {def}",
                    my_quote_ident(name),
                    my_quote_ident(new_name)
                ));
                modified += 1;
            }
            SchemaChange::ColDrop { name } => {
                check_ident(name)?;
                stmts.push(format!(
                    "ALTER TABLE {quoted} DROP COLUMN {}",
                    my_quote_ident(name)
                ));
                dropped += 1;
            }
            SchemaChange::IdxAdd {
                name,
                unique,
                columns,
            } => {
                check_ident(name)?;
                stmts.push(format!(
                    "CREATE {}INDEX {} ON {quoted} ({})",
                    if *unique { "UNIQUE " } else { "" },
                    my_quote_ident(name),
                    quote_cols(columns, my_quote_ident)?
                ));
                added += 1;
            }
            SchemaChange::IdxDrop { name } => {
                check_ident(name)?;
                stmts.push(format!(
                    "DROP INDEX {} ON {quoted}",
                    my_quote_ident(name)
                ));
                dropped += 1;
            }
            SchemaChange::ConAdd {
                name,
                kind,
                columns,
                ref_table,
                ref_columns,
                on_update,
                on_delete,
                expression,
            } => {
                let k = check_con_kind(kind)?;
                let body = constraint_body(
                    &k,
                    columns,
                    ref_table.as_deref(),
                    ref_columns,
                    on_update.as_deref(),
                    on_delete.as_deref(),
                    expression.as_deref(),
                    my_quote_ident,
                    my_quote_ident,
                )?;
                // MariaDB/MySQL nomme toujours la clé primaire « PRIMARY » :
                // un nom de contrainte y serait ignoré.
                if k == "PRIMARY KEY" {
                    stmts.push(format!("ALTER TABLE {quoted} ADD {body}"));
                } else {
                    check_ident(name)?;
                    stmts.push(format!(
                        "ALTER TABLE {quoted} ADD CONSTRAINT {} {body}",
                        my_quote_ident(name)
                    ));
                }
                added += 1;
            }
            SchemaChange::ConDrop { name, kind } => {
                // Chaque type de contrainte a sa propre syntaxe de suppression.
                let k = check_con_kind(kind)?;
                stmts.push(match k.as_str() {
                    "PRIMARY KEY" => format!("ALTER TABLE {quoted} DROP PRIMARY KEY"),
                    "FOREIGN KEY" => {
                        check_ident(name)?;
                        format!(
                            "ALTER TABLE {quoted} DROP FOREIGN KEY {}",
                            my_quote_ident(name)
                        )
                    }
                    "CHECK" => {
                        check_ident(name)?;
                        format!("ALTER TABLE {quoted} DROP CHECK {}", my_quote_ident(name))
                    }
                    // UNIQUE est porté par un index du même nom.
                    _ => {
                        check_ident(name)?;
                        format!("ALTER TABLE {quoted} DROP INDEX {}", my_quote_ident(name))
                    }
                });
                dropped += 1;
            }
        }
    }
    let mut conn = my_conn(host, port, user, password, database)?;
    let mut done: Vec<String> = Vec::new();
    for s in stmts {
        conn.query_drop(&s).map_err(|e| {
            format!(
                "{e}\n(instruction : {s})\n{} modification(s) déjà appliquée(s).",
                done.len()
            )
        })?;
        done.push(s);
    }
    Ok(AlterResult {
        added,
        modified,
        dropped,
        statements: done,
    })
}

fn pg_alter_table(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    changes: &[SchemaChange],
) -> Result<AlterResult, String> {
    let qualified = pg_qualify(table);
    // Un index vit dans le schéma de sa table : DROP INDEX doit le qualifier.
    let index_ref = |name: &str| match table.split_once('.') {
        Some((schema, _)) => format!("{}.{}", pg_quote_ident(schema), pg_quote_ident(name)),
        None => pg_quote_ident(name),
    };
    let mut stmts: Vec<String> = Vec::new();
    let (mut added, mut modified, mut dropped) = (0u32, 0u32, 0u32);
    for ch in ordered_changes(changes) {
        match ch {
            SchemaChange::ColAdd {
                name,
                col_type,
                nullable,
                default,
                comment,
            } => {
                check_ident(name)?;
                check_sql_fragment("Type", col_type)?;
                let col = pg_quote_ident(name);
                let mut s = format!(
                    "ALTER TABLE {qualified} ADD COLUMN {col} {}",
                    col_type.trim()
                );
                if !*nullable {
                    s.push_str(" NOT NULL");
                }
                if let Some(d) = default.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                    check_sql_fragment("Valeur par défaut", d)?;
                    s.push_str(" DEFAULT ");
                    s.push_str(d);
                }
                stmts.push(s);
                if let Some(c) = comment {
                    stmts.push(format!(
                        "COMMENT ON COLUMN {qualified}.{col} IS {}",
                        pg_quote_str(c)
                    ));
                }
                added += 1;
            }
            SchemaChange::ColModify {
                name,
                new_name,
                col_type,
                old_type,
                nullable,
                default,
                comment,
                ..
            } => {
                check_ident(name)?;
                check_ident(new_name)?;
                check_sql_fragment("Type", col_type)?;
                // Le renommage passe en premier : les instructions suivantes
                // désignent la colonne par son nouveau nom.
                if new_name != name {
                    stmts.push(format!(
                        "ALTER TABLE {qualified} RENAME COLUMN {} TO {}",
                        pg_quote_ident(name),
                        pg_quote_ident(new_name)
                    ));
                }
                let col = pg_quote_ident(new_name);
                // Une conversion de type réécrit la table : uniquement si besoin.
                if col_type.trim() != old_type.trim() {
                    let t = col_type.trim();
                    stmts.push(format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {col} TYPE {t} USING {col}::{t}"
                    ));
                }
                stmts.push(format!(
                    "ALTER TABLE {qualified} ALTER COLUMN {col} {} NOT NULL",
                    if *nullable { "DROP" } else { "SET" }
                ));
                match default.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                    Some(d) => {
                        check_sql_fragment("Valeur par défaut", d)?;
                        stmts.push(format!(
                            "ALTER TABLE {qualified} ALTER COLUMN {col} SET DEFAULT {d}"
                        ));
                    }
                    None => stmts.push(format!(
                        "ALTER TABLE {qualified} ALTER COLUMN {col} DROP DEFAULT"
                    )),
                }
                stmts.push(format!(
                    "COMMENT ON COLUMN {qualified}.{col} IS {}",
                    match comment {
                        Some(c) => pg_quote_str(c),
                        None => "NULL".to_string(),
                    }
                ));
                modified += 1;
            }
            SchemaChange::ColDrop { name } => {
                check_ident(name)?;
                stmts.push(format!(
                    "ALTER TABLE {qualified} DROP COLUMN {}",
                    pg_quote_ident(name)
                ));
                dropped += 1;
            }
            SchemaChange::IdxAdd {
                name,
                unique,
                columns,
            } => {
                check_ident(name)?;
                stmts.push(format!(
                    "CREATE {}INDEX {} ON {qualified} ({})",
                    if *unique { "UNIQUE " } else { "" },
                    pg_quote_ident(name),
                    quote_cols(columns, pg_quote_ident)?
                ));
                added += 1;
            }
            SchemaChange::IdxDrop { name } => {
                check_ident(name)?;
                stmts.push(format!("DROP INDEX {}", index_ref(name)));
                dropped += 1;
            }
            SchemaChange::ConAdd {
                name,
                kind,
                columns,
                ref_table,
                ref_columns,
                on_update,
                on_delete,
                expression,
            } => {
                check_ident(name)?;
                let k = check_con_kind(kind)?;
                let body = constraint_body(
                    &k,
                    columns,
                    ref_table.as_deref(),
                    ref_columns,
                    on_update.as_deref(),
                    on_delete.as_deref(),
                    expression.as_deref(),
                    pg_quote_ident,
                    |t| pg_qualify(t),
                )?;
                stmts.push(format!(
                    "ALTER TABLE {qualified} ADD CONSTRAINT {} {body}",
                    pg_quote_ident(name)
                ));
                added += 1;
            }
            SchemaChange::ConDrop { name, .. } => {
                check_ident(name)?;
                stmts.push(format!(
                    "ALTER TABLE {qualified} DROP CONSTRAINT {}",
                    pg_quote_ident(name)
                ));
                dropped += 1;
            }
        }
    }
    let mut client = pg_client(host, port, user, password, database)?;
    // Le DDL Postgres est transactionnel : tout passe, ou rien.
    let mut tx = client
        .transaction()
        .map_err(|e| format!("Transaction impossible : {}", pg_err_msg(&e)))?;
    for s in &stmts {
        tx.batch_execute(s)
            .map_err(|e| format!("{}\n(instruction : {s})", pg_err_msg(&e)))?;
    }
    tx.commit()
        .map_err(|e| format!("Validation échouée : {}", pg_err_msg(&e)))?;
    Ok(AlterResult {
        added,
        modified,
        dropped,
        statements: stmts,
    })
}

// ---------------------------------------------------------------------------
// Suppression de lignes sélectionnées (par clé primaire)
// ---------------------------------------------------------------------------

/// Supprime les lignes sélectionnées. Chaque ligne est identifiée par la valeur
/// (texte, telle qu'affichée) de sa clé primaire — la table doit en avoir une.
/// Renvoie le nombre de lignes réellement supprimées.
#[tauri::command]
async fn db_delete_rows(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
) -> Result<u64, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => {
            pg_delete_rows(&host, port, &user, &password, &database, &table, &columns, &rows)
        }
        "mariadb" | "mysql" => {
            my_delete_rows(&host, port, &user, &password, &database, &table, &columns, &rows)
        }
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Indices, dans `columns`, des colonnes de clé primaire `pk_cols`.
fn pk_indices(columns: &[String], pk_cols: &[String]) -> Result<Vec<usize>, String> {
    pk_cols
        .iter()
        .map(|pk| {
            columns
                .iter()
                .position(|c| c.eq_ignore_ascii_case(pk))
                .ok_or_else(|| format!("Colonne de clé primaire « {pk} » absente des données."))
        })
        .collect()
}

fn pg_delete_rows(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<u64, String> {
    let mut client = pg_client(host, port, user, password, database)?;
    let qualified = pg_qualify(table);
    let pk_rows = client
        .query(
            "SELECT a.attname FROM pg_index i \
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
             WHERE i.indrelid = ($1::text)::regclass AND i.indisprimary \
             ORDER BY array_position(i.indkey, a.attnum)",
            &[&qualified],
        )
        .map_err(|e| format!("Lecture de la clé primaire échouée : {e}"))?;
    let pk_cols: Vec<String> = pk_rows.iter().map(|r| r.get::<_, String>(0)).collect();
    if pk_cols.is_empty() {
        return Err("Table sans clé primaire : suppression impossible.".into());
    }
    let pk_idx = pk_indices(columns, &pk_cols)?;
    let mut params: Vec<String> = Vec::new();
    let mut ors: Vec<String> = Vec::new();
    for row in rows {
        let mut conds = Vec::new();
        for (pk_name, &idx) in pk_cols.iter().zip(pk_idx.iter()) {
            let val = row
                .get(idx)
                .and_then(|v| v.clone())
                .ok_or("Valeur de clé primaire manquante.")?;
            params.push(val);
            conds.push(format!(
                "\"{}\"::text = ${}",
                pk_name.replace('"', "\"\""),
                params.len()
            ));
        }
        ors.push(format!("({})", conds.join(" AND ")));
    }
    let sql = format!("DELETE FROM {qualified} WHERE {}", ors.join(" OR "));
    let param_refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
        params.iter().map(|s| s as &(dyn postgres::types::ToSql + Sync)).collect();
    client
        .execute(&sql, &param_refs)
        .map_err(|e| format!("Suppression échouée : {e}"))
}

fn my_delete_rows(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<u64, String> {
    use mysql::prelude::Queryable;
    let mut conn = my_conn(host, port, user, password, database)?;
    let quoted = format!("`{}`", table.replace('`', "``"));
    let pk_cols: Vec<String> = conn
        .exec(
            "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' \
             ORDER BY ORDINAL_POSITION",
            (table,),
        )
        .map_err(|e| format!("Lecture de la clé primaire échouée : {e}"))?;
    if pk_cols.is_empty() {
        return Err("Table sans clé primaire : suppression impossible.".into());
    }
    let pk_idx = pk_indices(columns, &pk_cols)?;
    let mut params: Vec<mysql::Value> = Vec::new();
    let mut ors: Vec<String> = Vec::new();
    for row in rows {
        let mut conds = Vec::new();
        for (pk_name, &idx) in pk_cols.iter().zip(pk_idx.iter()) {
            let val = row
                .get(idx)
                .and_then(|v| v.clone())
                .ok_or("Valeur de clé primaire manquante.")?;
            params.push(mysql::Value::from(val));
            conds.push(format!("CAST(`{}` AS CHAR) = ?", pk_name.replace('`', "``")));
        }
        ors.push(format!("({})", conds.join(" AND ")));
    }
    let sql = format!("DELETE FROM {quoted} WHERE {}", ors.join(" OR "));
    conn.exec_drop(sql, mysql::Params::Positional(params))
        .map_err(|e| format!("Suppression échouée : {e}"))?;
    Ok(conn.affected_rows())
}

// ---------------------------------------------------------------------------
// Modification d'une cellule (UPDATE par clé primaire)
// ---------------------------------------------------------------------------

/// Modifie une cellule : `SET column = value WHERE <clé primaire de la ligne>`.
/// La ligne est identifiée par sa clé primaire (extraite de `row`). La valeur
/// est liée en paramètre. Renvoie le nombre de lignes modifiées.
#[tauri::command]
async fn db_update_cell(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    table: String,
    columns: Vec<String>,
    row: Vec<Option<String>>,
    column: String,
    value: String,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => pg_update_cell(
            &host, port, &user, &password, &database, &table, &columns, &row, &column, &value,
        ),
        "mariadb" | "mysql" => my_update_cell(
            &host, port, &user, &password, &database, &table, &columns, &row, &column, &value,
        ),
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[allow(clippy::too_many_arguments)]
fn pg_update_cell(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    columns: &[String],
    row: &[Option<String>],
    column: &str,
    value: &str,
) -> Result<u64, String> {
    let mut client = pg_client(host, port, user, password, database)?;
    let qualified = pg_qualify(table);
    // Colonne cible + son type SQL exact (pour caster la valeur correctement).
    let stmt = client
        .prepare(&format!("SELECT * FROM {qualified} LIMIT 0"))
        .map_err(|e| format!("Table introuvable : {}", pg_err_msg(&e)))?;
    let target = stmt
        .columns()
        .iter()
        .find(|c| c.name().eq_ignore_ascii_case(column))
        .ok_or_else(|| format!("Colonne inconnue : « {column} »"))?;
    let target_name = target.name().to_string();
    let target_type = target.type_().name().to_string();
    // Clé primaire.
    let pk_rows = client
        .query(
            "SELECT a.attname FROM pg_index i \
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
             WHERE i.indrelid = ($1::text)::regclass AND i.indisprimary \
             ORDER BY array_position(i.indkey, a.attnum)",
            &[&qualified],
        )
        .map_err(|e| format!("Lecture de la clé primaire échouée : {e}"))?;
    let pk_cols: Vec<String> = pk_rows.iter().map(|r| r.get::<_, String>(0)).collect();
    if pk_cols.is_empty() {
        return Err("Table sans clé primaire : modification impossible.".into());
    }
    let pk_idx = pk_indices(columns, &pk_cols)?;
    // $1 = nouvelle valeur (castée vers le type exact de la colonne).
    let mut params: Vec<String> = vec![value.to_string()];
    let set = format!(
        "\"{}\" = ($1::text)::{}",
        target_name.replace('"', "\"\""),
        target_type
    );
    let mut conds = Vec::new();
    for (pk_name, &idx) in pk_cols.iter().zip(pk_idx.iter()) {
        let val = row
            .get(idx)
            .and_then(|v| v.clone())
            .ok_or("Valeur de clé primaire manquante.")?;
        params.push(val);
        conds.push(format!(
            "\"{}\"::text = ${}",
            pk_name.replace('"', "\"\""),
            params.len()
        ));
    }
    let sql = format!("UPDATE {qualified} SET {set} WHERE {}", conds.join(" AND "));
    let param_refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
        params.iter().map(|s| s as &(dyn postgres::types::ToSql + Sync)).collect();
    client
        .execute(&sql, &param_refs)
        .map_err(|e| format!("Modification échouée : {e}"))
}

#[allow(clippy::too_many_arguments)]
fn my_update_cell(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    columns: &[String],
    row: &[Option<String>],
    column: &str,
    value: &str,
) -> Result<u64, String> {
    use mysql::prelude::Queryable;
    let mut conn = my_conn(host, port, user, password, database)?;
    let quoted = format!("`{}`", table.replace('`', "``"));
    // Valide la colonne cible contre les colonnes réelles.
    let cols: Vec<String> = {
        let r = conn
            .query_iter(format!("SELECT * FROM {quoted} LIMIT 0"))
            .map_err(|e| format!("Table introuvable : {e}"))?;
        r.columns().as_ref().iter().map(|c| c.name_str().into_owned()).collect()
    };
    let target = cols
        .iter()
        .find(|c| c.eq_ignore_ascii_case(column))
        .ok_or_else(|| format!("Colonne inconnue : « {column} »"))?
        .clone();
    let pk_cols: Vec<String> = conn
        .exec(
            "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' \
             ORDER BY ORDINAL_POSITION",
            (table,),
        )
        .map_err(|e| format!("Lecture de la clé primaire échouée : {e}"))?;
    if pk_cols.is_empty() {
        return Err("Table sans clé primaire : modification impossible.".into());
    }
    let pk_idx = pk_indices(columns, &pk_cols)?;
    let mut params: Vec<mysql::Value> = vec![mysql::Value::from(value)];
    let mut conds = Vec::new();
    for (pk_name, &idx) in pk_cols.iter().zip(pk_idx.iter()) {
        let val = row
            .get(idx)
            .and_then(|v| v.clone())
            .ok_or("Valeur de clé primaire manquante.")?;
        params.push(mysql::Value::from(val));
        conds.push(format!("CAST(`{}` AS CHAR) = ?", pk_name.replace('`', "``")));
    }
    let sql = format!(
        "UPDATE {quoted} SET `{}` = ? WHERE {}",
        target.replace('`', "``"),
        conds.join(" AND ")
    );
    conn.exec_drop(sql, mysql::Params::Positional(params))
        .map_err(|e| format!("Modification échouée : {e}"))?;
    Ok(conn.affected_rows())
}

// ---------------------------------------------------------------------------
// Application groupée des modifications (transaction : tout ou rien)
// ---------------------------------------------------------------------------

/// Une colonne à modifier : nom + nouvelle valeur (`None` = NULL SQL).
#[derive(Deserialize)]
struct CellSet {
    column: String,
    value: Option<String>,
}

/// Une ligne modifiée : identifiée par ses valeurs actuelles `row` (pour la clé
/// primaire) + les colonnes à changer.
#[derive(Deserialize)]
struct RowUpdate {
    row: Vec<Option<String>>,
    sets: Vec<CellSet>,
}

#[derive(Serialize)]
struct ApplyResult {
    inserted: u64,
    updated: u64,
    deleted: u64,
}

/// Applique en une seule transaction toutes les modifications (updates) et
/// suppressions (deletes) mises en attente côté UI. En cas d'erreur, rien n'est
/// enregistré (rollback implicite).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn db_apply_changes(
    driver: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    table: String,
    columns: Vec<String>,
    inserts: Vec<Vec<CellSet>>,
    updates: Vec<RowUpdate>,
    deletes: Vec<Vec<Option<String>>>,
) -> Result<ApplyResult, String> {
    if inserts.is_empty() && updates.is_empty() && deletes.is_empty() {
        return Ok(ApplyResult { inserted: 0, updated: 0, deleted: 0 });
    }
    tauri::async_runtime::spawn_blocking(move || match driver.as_str() {
        "postgres" => pg_apply(
            &host, port, &user, &password, &database, &table, &columns, &inserts, &updates,
            &deletes,
        ),
        "mariadb" | "mysql" => my_apply(
            &host, port, &user, &password, &database, &table, &columns, &inserts, &updates,
            &deletes,
        ),
        other => Err(format!("Pilote inconnu : {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn pg_pk(client: &mut postgres::Client, qualified: &str) -> Result<Vec<String>, String> {
    let rows = client
        .query(
            "SELECT a.attname FROM pg_index i \
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
             WHERE i.indrelid = ($1::text)::regclass AND i.indisprimary \
             ORDER BY array_position(i.indkey, a.attnum)",
            &[&qualified],
        )
        .map_err(|e| format!("Lecture de la clé primaire échouée : {}", pg_err_msg(&e)))?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

#[allow(clippy::too_many_arguments)]
fn pg_apply(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    columns: &[String],
    inserts: &[Vec<CellSet>],
    updates: &[RowUpdate],
    deletes: &[Vec<Option<String>>],
) -> Result<ApplyResult, String> {
    let mut client = pg_client(host, port, user, password, database)?;
    let qualified = pg_qualify(table);
    // Colonnes réelles + leur type (pour caster les valeurs).
    let stmt = client
        .prepare(&format!("SELECT * FROM {qualified} LIMIT 0"))
        .map_err(|e| format!("Table introuvable : {}", pg_err_msg(&e)))?;
    let col_types: HashMap<String, String> = stmt
        .columns()
        .iter()
        .map(|c| (c.name().to_lowercase(), c.type_().name().to_string()))
        .collect();
    let col_type = |name: &str| {
        col_types
            .get(&name.to_lowercase())
            .cloned()
            .ok_or_else(|| format!("Colonne inconnue : « {name} »"))
    };
    // La clé primaire n'est requise que pour modifier/supprimer.
    let pk_cols = if updates.is_empty() && deletes.is_empty() {
        Vec::new()
    } else {
        let pk = pg_pk(&mut client, &qualified)?;
        if pk.is_empty() {
            return Err("Table sans clé primaire : enregistrement impossible.".into());
        }
        pk
    };
    let pk_idx = pk_indices(columns, &pk_cols)?;

    let mut tx = client.transaction().map_err(|e| pg_err_msg(&e))?;

    let mut inserted = 0u64;
    for ins in inserts {
        let mut params: Vec<String> = Vec::new();
        let mut cols = Vec::new();
        let mut vals = Vec::new();
        for set in ins {
            let ty = col_type(&set.column)?;
            cols.push(format!("\"{}\"", set.column.replace('"', "\"\"")));
            match &set.value {
                None => vals.push("NULL".to_string()),
                Some(v) => {
                    params.push(v.clone());
                    vals.push(format!("(${}::text)::{}", params.len(), ty));
                }
            }
        }
        let sql = if cols.is_empty() {
            format!("INSERT INTO {qualified} DEFAULT VALUES")
        } else {
            format!("INSERT INTO {qualified} ({}) VALUES ({})", cols.join(", "), vals.join(", "))
        };
        let refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
            params.iter().map(|s| s as &(dyn postgres::types::ToSql + Sync)).collect();
        inserted += tx
            .execute(&sql, &refs)
            .map_err(|e| format!("Insertion échouée : {}", pg_err_msg(&e)))?;
    }

    let mut updated = 0u64;
    for up in updates {
        if up.sets.is_empty() {
            continue;
        }
        let mut params: Vec<String> = Vec::new();
        let mut set_parts = Vec::new();
        for set in &up.sets {
            let ty = col_types
                .get(&set.column.to_lowercase())
                .cloned()
                .ok_or_else(|| format!("Colonne inconnue : « {} »", set.column))?;
            let col = set.column.replace('"', "\"\"");
            match &set.value {
                None => set_parts.push(format!("\"{col}\" = NULL")),
                Some(val) => {
                    params.push(val.clone());
                    set_parts.push(format!("\"{col}\" = (${}::text)::{}", params.len(), ty));
                }
            }
        }
        let mut conds = Vec::new();
        for (pk_name, &idx) in pk_cols.iter().zip(pk_idx.iter()) {
            let v = up
                .row
                .get(idx)
                .and_then(|x| x.clone())
                .ok_or("Valeur de clé primaire manquante.")?;
            params.push(v);
            conds.push(format!(
                "\"{}\"::text = ${}",
                pk_name.replace('"', "\"\""),
                params.len()
            ));
        }
        let sql = format!(
            "UPDATE {qualified} SET {} WHERE {}",
            set_parts.join(", "),
            conds.join(" AND ")
        );
        let refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
            params.iter().map(|s| s as &(dyn postgres::types::ToSql + Sync)).collect();
        updated += tx
            .execute(&sql, &refs)
            .map_err(|e| format!("Modification échouée : {}", pg_err_msg(&e)))?;
    }

    let mut deleted = 0u64;
    if !deletes.is_empty() {
        let mut params: Vec<String> = Vec::new();
        let mut ors = Vec::new();
        for row in deletes {
            let mut conds = Vec::new();
            for (pk_name, &idx) in pk_cols.iter().zip(pk_idx.iter()) {
                let v = row
                    .get(idx)
                    .and_then(|x| x.clone())
                    .ok_or("Valeur de clé primaire manquante.")?;
                params.push(v);
                conds.push(format!(
                    "\"{}\"::text = ${}",
                    pk_name.replace('"', "\"\""),
                    params.len()
                ));
            }
            ors.push(format!("({})", conds.join(" AND ")));
        }
        let sql = format!("DELETE FROM {qualified} WHERE {}", ors.join(" OR "));
        let refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
            params.iter().map(|s| s as &(dyn postgres::types::ToSql + Sync)).collect();
        deleted = tx
            .execute(&sql, &refs)
            .map_err(|e| format!("Suppression échouée : {}", pg_err_msg(&e)))?;
    }

    tx.commit()
        .map_err(|e| format!("Enregistrement échoué : {}", pg_err_msg(&e)))?;
    Ok(ApplyResult { inserted, updated, deleted })
}

#[allow(clippy::too_many_arguments)]
fn my_apply(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    table: &str,
    columns: &[String],
    inserts: &[Vec<CellSet>],
    updates: &[RowUpdate],
    deletes: &[Vec<Option<String>>],
) -> Result<ApplyResult, String> {
    use mysql::prelude::Queryable;
    let mut conn = my_conn(host, port, user, password, database)?;
    let quoted = format!("`{}`", table.replace('`', "``"));
    let valid_cols: Vec<String> = {
        let r = conn
            .query_iter(format!("SELECT * FROM {quoted} LIMIT 0"))
            .map_err(|e| format!("Table introuvable : {e}"))?;
        r.columns().as_ref().iter().map(|c| c.name_str().into_owned()).collect()
    };
    let canon_col = |name: &str| {
        valid_cols
            .iter()
            .find(|c| c.eq_ignore_ascii_case(name))
            .map(|c| c.replace('`', "``"))
            .ok_or_else(|| format!("Colonne inconnue : « {name} »"))
    };
    // Clé primaire requise seulement pour modifier/supprimer.
    let pk_cols: Vec<String> = if updates.is_empty() && deletes.is_empty() {
        Vec::new()
    } else {
        let pk: Vec<String> = conn
            .exec(
                "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' \
                 ORDER BY ORDINAL_POSITION",
                (table,),
            )
            .map_err(|e| format!("Lecture de la clé primaire échouée : {e}"))?;
        if pk.is_empty() {
            return Err("Table sans clé primaire : enregistrement impossible.".into());
        }
        pk
    };
    let pk_idx = pk_indices(columns, &pk_cols)?;

    let mut tx = conn
        .start_transaction(mysql::TxOpts::default())
        .map_err(|e| e.to_string())?;

    let mut inserted = 0u64;
    for ins in inserts {
        let mut params: Vec<mysql::Value> = Vec::new();
        let mut cols = Vec::new();
        let mut ph = Vec::new();
        for set in ins {
            cols.push(format!("`{}`", canon_col(&set.column)?));
            match &set.value {
                None => ph.push("NULL".to_string()),
                Some(v) => {
                    params.push(mysql::Value::from(v.clone()));
                    ph.push("?".to_string());
                }
            }
        }
        let sql = if cols.is_empty() {
            format!("INSERT INTO {quoted} () VALUES ()")
        } else {
            format!("INSERT INTO {quoted} ({}) VALUES ({})", cols.join(", "), ph.join(", "))
        };
        tx.exec_drop(sql, mysql::Params::Positional(params))
            .map_err(|e| format!("Insertion échouée : {e}"))?;
        inserted += tx.affected_rows();
    }

    let mut updated = 0u64;
    for up in updates {
        if up.sets.is_empty() {
            continue;
        }
        let mut params: Vec<mysql::Value> = Vec::new();
        let mut set_parts = Vec::new();
        for set in &up.sets {
            let canon = valid_cols
                .iter()
                .find(|c| c.eq_ignore_ascii_case(&set.column))
                .ok_or_else(|| format!("Colonne inconnue : « {} »", set.column))?
                .replace('`', "``");
            match &set.value {
                None => set_parts.push(format!("`{canon}` = NULL")),
                Some(val) => {
                    params.push(mysql::Value::from(val.clone()));
                    set_parts.push(format!("`{canon}` = ?"));
                }
            }
        }
        let mut conds = Vec::new();
        for (pk_name, &idx) in pk_cols.iter().zip(pk_idx.iter()) {
            let v = up
                .row
                .get(idx)
                .and_then(|x| x.clone())
                .ok_or("Valeur de clé primaire manquante.")?;
            params.push(mysql::Value::from(v));
            conds.push(format!("CAST(`{}` AS CHAR) = ?", pk_name.replace('`', "``")));
        }
        let sql = format!(
            "UPDATE {quoted} SET {} WHERE {}",
            set_parts.join(", "),
            conds.join(" AND ")
        );
        tx.exec_drop(sql, mysql::Params::Positional(params))
            .map_err(|e| format!("Modification échouée : {e}"))?;
        updated += tx.affected_rows();
    }

    let mut deleted = 0u64;
    if !deletes.is_empty() {
        let mut params: Vec<mysql::Value> = Vec::new();
        let mut ors = Vec::new();
        for row in deletes {
            let mut conds = Vec::new();
            for (pk_name, &idx) in pk_cols.iter().zip(pk_idx.iter()) {
                let v = row
                    .get(idx)
                    .and_then(|x| x.clone())
                    .ok_or("Valeur de clé primaire manquante.")?;
                params.push(mysql::Value::from(v));
                conds.push(format!("CAST(`{}` AS CHAR) = ?", pk_name.replace('`', "``")));
            }
            ors.push(format!("({})", conds.join(" AND ")));
        }
        let sql = format!("DELETE FROM {quoted} WHERE {}", ors.join(" OR "));
        tx.exec_drop(sql, mysql::Params::Positional(params))
            .map_err(|e| format!("Suppression échouée : {e}"))?;
        deleted += tx.affected_rows();
    }

    tx.commit().map_err(|e| format!("Enregistrement échoué : {e}"))?;
    Ok(ApplyResult { inserted, updated, deleted })
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
            open_url,
            download_file,
            reveal_path,
            db_connect,
            db_tables,
            db_table_rows,
            db_table_schema,
            db_table_columns,
            db_alter_table,
            db_delete_rows,
            db_update_cell,
            db_apply_changes
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
