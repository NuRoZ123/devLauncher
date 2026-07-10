import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, autostart, onLogs, onStatus, pickBashExe, pickFolder } from "./api";
import { BranchModal, type BranchModalState } from "./components/BranchModal";
import { Console } from "./components/Console";
import { ColorPicker } from "./components/ColorPicker";
import { CustomActionManager } from "./components/CustomActionManager";
import { EnvModal, type EnvModalState } from "./components/EnvModal";
import { PackageLinkModal, type LinkModalState } from "./components/PackageLinkModal";
import { ProjectRow } from "./components/ProjectRow";
import { SequenceManager } from "./components/SequenceManager";
import { Setup } from "./components/Setup";
import { StartCommandModal } from "./components/StartCommandModal";
import { TaskQueue } from "./components/TaskQueue";
import {
  actionAllowed,
  BUILTIN_ACTIONS,
  CORE_ACTIONS,
  seedActions,
  DEFAULT_GIT_BASH,
  DEFAULT_SEQUENCES,
  START_COMMAND_PLACEHOLDER,
} from "./constants";
import { GeneralSequenceModal } from "./components/GeneralSequenceModal";
import { checkForUpdate, type UpdateInfo } from "./update";
import type {
  ActionDef,
  Config,
  GitInfo,
  JobStatus,
  LogLine,
  PortInfo,
  Project,
  ProjectKind,
  QJob,
  Sequence,
  ServiceDep,
  TestResult,
} from "./types";

type StepToken = { cancelled: boolean; runId: string };
type StepPlan = { action: ActionDef; branch?: string };

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// Clé de rendu stable attribuée à chaque ligne de log à la réception :
// permet de mémoïser les lignes de la console (pas de re-parse ANSI ni de
// re-rendu des lignes déjà affichées).
let logSeq = 0;
const tagKey = (l: LogLine): LogLine => {
  l.key = ++logSeq;
  return l;
};

const MAX_LINES = 5000;
// Identité stable pour « aucune exception » (évite de relancer le scan pour rien).
const NO_OVERRIDES: Record<string, string> = {};
const NO_COLORS: Record<string, string> = {};
const KIND_ORDER: ProjectKind[] = ["service", "front", "package"];
const KIND_TITLE: Record<ProjectKind, string> = {
  service: "Services",
  front: "Front",
  package: "Packages",
};

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  // Config incomplète chargée du disque (ex. commande de démarrage manquante) :
  // sert à pré-remplir l'écran Setup et à conserver séquences/actions existantes.
  const [partialConfig, setPartialConfig] = useState<Config | null>(null);
  const [ready, setReady] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");

  const [projects, setProjects] = useState<Project[]>([]);
  const [gitMap, setGitMap] = useState<Record<string, GitInfo>>({});
  const [portInfo, setPortInfo] = useState<Record<string, PortInfo>>({});
  const [pkgLinks, setPkgLinks] = useState<Record<string, { linked: number; present: number }>>(
    {},
  );
  const [linkVersion, setLinkVersion] = useState(0);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const [jobs, setJobs] = useState<QJob[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const jobsRef = useRef<QJob[]>([]);
  const tokensRef = useRef<Map<string, StepToken>>(new Map());
  const jobCancelRef = useRef<Set<string>>(new Set());
  const projectChains = useRef<Map<string, Promise<void>>>(new Map());
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Trace une opération non annulable (scan, libération de port…) dans la file.
  const track = useCallback(
    async <T,>(title: string, projectName: string, run: () => Promise<T>): Promise<T> => {
      const job: QJob = {
        id: uid(),
        title,
        projectId: "",
        projectName,
        steps: [{ id: uid(), label: title, status: "running" }],
        status: "running",
        cancellable: false,
      };
      setJobs((js) => [job, ...js]);
      const finish = (st: JobStatus) =>
        setJobs((js) =>
          js.map((j) =>
            j.id === job.id
              ? { ...j, status: st, steps: j.steps.map((s) => ({ ...s, status: st })) }
              : j,
          ),
        );
      try {
        const r = await run();
        finish("done");
        return r;
      } catch (e) {
        finish("failed");
        throw e;
      }
    },
    [],
  );
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [activeConsole, setActiveConsole] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<Set<string>>(new Set());
  const [closedTabs, setClosedTabs] = useState<Set<string>>(new Set());
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const logBuf = useRef<LogLine[]>([]);

  const [linkModal, setLinkModal] = useState<LinkModalState | null>(null);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const linkModalRef = useRef<LinkModalState | null>(null);
  useEffect(() => {
    linkModalRef.current = linkModal;
  }, [linkModal]);

  const [generalSeq, setGeneralSeq] = useState<Sequence | null>(null);
  const [seqMenuOpen, setSeqMenuOpen] = useState(false);

  const [splitPct, setSplitPct] = useState<number>(() => {
    const v = Number(localStorage.getItem("dl.splitPct"));
    return v >= 25 && v <= 78 ? v : 54;
  });
  const mainRef = useRef<HTMLDivElement>(null);
  const draggingSplit = useRef(false);

  // Mémorise la largeur du panneau (persistée entre les sessions).
  useEffect(() => {
    localStorage.setItem("dl.splitPct", String(splitPct));
  }, [splitPct]);

  const [branchModal, setBranchModal] = useState<BranchModalState | null>(null);
  const branchResolver = useRef<((b: string | null) => void) | null>(null);

  const [envModal, setEnvModal] = useState<EnvModalState | null>(null);

  const bash = config?.git_bash_path ?? DEFAULT_GIT_BASH;
  const root = config?.projects_root ?? "";
  const startCmd = config?.start_command ?? "";
  const cmdOverrides = config?.command_overrides ?? NO_OVERRIDES;
  const sequences = config?.sequences ?? [];
  const customActions = config?.custom_actions ?? [];
  const actionColors = config?.action_colors ?? NO_COLORS;
  const allActions = useMemo(
    () => [...BUILTIN_ACTIONS, ...customActions].map((a) => ({ ...a, color: actionColors[a.id] })),
    [customActions, actionColors],
  );
  const resolveAction = useCallback(
    (id: string) => allActions.find((a) => a.id === id),
    [allActions],
  );

  // ----- Chargement initial de la config -----
  useEffect(() => {
    api.loadConfig().then((c) => {
      // La commande de démarrage fait partie de la config minimale : si elle
      // manque (ancienne config), on repasse par l'écran Setup pré-rempli.
      if (c && c.projects_root && c.start_command) {
        // Les actions par défaut ne sont semées qu'une seule fois : après quoi
        // le drapeau est persisté, et les suppressions de l'utilisateur tiennent.
        const alreadySeeded = c.actions_seeded ?? false;
        const next: Config = {
          projects_root: c.projects_root,
          git_bash_path: c.git_bash_path || DEFAULT_GIT_BASH,
          start_command: c.start_command,
          command_overrides: c.command_overrides ?? NO_OVERRIDES,
          sequences: c.sequences?.length ? c.sequences : DEFAULT_SEQUENCES,
          custom_actions: alreadySeeded ? (c.custom_actions ?? []) : seedActions(c.custom_actions ?? []),
          action_colors: c.action_colors ?? {},
          actions_seeded: true,
        };
        setConfig(next);
        if (!alreadySeeded) void api.saveConfig(next); // fige le semis dès le 1er lancement
      } else if (c) {
        setPartialConfig(c);
      }
      setReady(true);
    });
  }, []);

  // ----- Vérification d'une nouvelle version (GitHub) : au démarrage + toutes les 6 h -----
  useEffect(() => {
    const run = () => checkForUpdate().then((u) => u && setUpdate(u)).catch(() => {});
    run();
    const iv = setInterval(run, 6 * 60 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // ----- Logs (bufferisés puis flush périodique) -----
  useEffect(() => {
    const unBatch = onLogs((arr) => {
      for (const l of arr) logBuf.current.push(tagKey(l));
    });
    const iv = setInterval(() => {
      if (!logBuf.current.length) return;
      const batch = logBuf.current;
      logBuf.current = [];
      setLogs((prev) => {
        const next = { ...prev };
        // copie de chaque tampon au plus UNE fois par flush (et non par ligne)
        const touched = new Set<string>();
        for (const l of batch) {
          if (!touched.has(l.target)) {
            next[l.target] = next[l.target] ? next[l.target].slice() : [];
            touched.add(l.target);
          }
          next[l.target].push(l);
        }
        for (const t of touched) {
          const arr = next[t];
          if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
        }
        return next;
      });
    }, 150);
    return () => {
      unBatch.then((u) => u());
      clearInterval(iv);
    };
  }, []);

  // ----- Statut des process -----
  useEffect(() => {
    const un = onStatus((s) => {
      setRunning((prev) => {
        const n = new Set(prev);
        if (s.running) n.add(s.id);
        else n.delete(s.id);
        return n;
      });
    });
    return () => {
      un.then((u) => u());
    };
  }, []);

  // ----- Splitter (redimensionnement projets / console) -----
  useEffect(() => {
    function move(e: MouseEvent) {
      if (!draggingSplit.current || !mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      let pct = ((e.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(25, Math.min(78, pct));
      setSplitPct(pct);
    }
    function up() {
      if (!draggingSplit.current) return;
      draggingSplit.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  function startSplit(e: React.MouseEvent) {
    e.preventDefault();
    draggingSplit.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // ----- Git info -----
  const refreshGitFor = useCallback(
    async (p: Project) => {
      try {
        const g = await api.gitInfo(bash, p.path);
        setGitMap((m) => ({ ...m, [p.id]: g }));
      } catch {
        /* ignore */
      }
    },
    [bash],
  );

  // ----- Scan -----
  const rescan = useCallback(async () => {
    if (!root) return;
    setScanError(null);
    setScanning(true);
    try {
      await track("Scan des projets", "", async () => {
        const list = await api.scanProjects(root, startCmd, cmdOverrides);
        setProjects(list);
        setGitMap({}); // recharge l'état git
        const ids = await api.runningIds();
        setRunning(new Set(ids));
        const hists = await Promise.all(ids.map((id) => api.getLogs(id)));
        setLogs((prev) => {
          const next = { ...prev };
          ids.forEach((id, i) => {
            if (hists[i].length) next[id] = hists[i].map(tagKey);
          });
          return next;
        });
        // la tâche reste « en cours » tant que les branches ne sont pas chargées
        await Promise.all(list.map((p) => refreshGitFor(p)));
      });
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  }, [root, startCmd, cmdOverrides, refreshGitFor, track]);

  // Ne rescanne que si une valeur pertinente au scan change réellement. On compare
  // le *contenu* des overrides (et non la référence, reconstruite à chaque save) :
  // sinon toute sauvegarde de réglage (couleurs, actions…) relançait un scan.
  useEffect(() => {
    if (config) rescan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config?.projects_root,
    config?.git_bash_path,
    config?.start_command,
    JSON.stringify(config?.command_overrides ?? {}),
  ]);

  // ----- Vérification des ports (polling régulier via netstat -ano) -----
  const portsBusy = useRef(false);
  const refreshPorts = useCallback(async () => {
    if (portsBusy.current) return; // pas d'empilement si le backend est lent
    const ports = [...new Set(projects.filter((p) => p.port != null).map((p) => p.port!))];
    if (!ports.length) {
      setPortInfo({});
      return;
    }
    portsBusy.current = true;
    try {
      const infos = await api.portsStatus(ports);
      const byPort = new Map(infos.map((i) => [i.port, i]));
      const next: Record<string, PortInfo> = {};
      for (const p of projects) {
        if (p.port != null) {
          const info = byPort.get(p.port);
          if (info) next[p.id] = info;
        }
      }
      setPortInfo(next);
    } catch {
      /* ignore */
    } finally {
      portsBusy.current = false;
    }
  }, [projects]);

  useEffect(() => {
    refreshPorts();
    const iv = setInterval(refreshPorts, 4000);
    return () => clearInterval(iv);
  }, [refreshPorts, running]);

  const onFreePort = useCallback(
    async (p: Project) => {
      if (p.port == null) return;
      setBusyFor(p.id, "Libération du port");
      try {
        await track(`Libérer le port ${p.port}`, p.name, () => api.freePort(p.port!));
      } catch (e) {
        console.error(e);
      } finally {
        setBusyFor(p.id, null);
        refreshPorts();
      }
    },
    [refreshPorts, track],
  );

  // ----- État de liaison des packages (combien de services les utilisent / lient) -----
  const refreshPkgLinks = useCallback(
    async (list: Project[]) => {
      const pkgs = list.filter((p) => p.kind === "package");
      if (!pkgs.length) {
        setPkgLinks({});
        return;
      }
      const result: Record<string, { linked: number; present: number }> = {};
      await Promise.all(
        pkgs.map(async (p) => {
          try {
            const meta = await api.readPackageJson(p.path);
            const services = await api.packageLinks(root, meta.name);
            const present = services.filter((s) => s.present);
            result[p.id] = {
              present: present.length,
              linked: present.filter((s) => s.linked).length,
            };
          } catch {
            result[p.id] = { present: 0, linked: 0 };
          }
        }),
      );
      setPkgLinks(result);
    },
    [root],
  );

  useEffect(() => {
    refreshPkgLinks(projects);
  }, [projects, linkVersion, refreshPkgLinks]);

  // Services dont le port est occupé par un process qui n'est PAS le nôtre.
  const orphanPorts = useMemo(
    () =>
      projects.filter((p) => {
        const i = portInfo[p.id];
        return p.port != null && !!i?.in_use && !i.owned && !running.has(p.id);
      }),
    [projects, portInfo, running],
  );

  const freeAllPorts = useCallback(async () => {
    await track("Libérer tous les ports", "", async () => {
      for (const p of orphanPorts) {
        if (p.port == null) continue;
        setBusyFor(p.id, "Libération du port");
        try {
          await api.freePort(p.port);
        } catch (e) {
          console.error(e);
        } finally {
          setBusyFor(p.id, null);
        }
      }
    });
    refreshPorts();
  }, [orphanPorts, refreshPorts, track]);

  // ----- Busy -----
  const setBusyFor = (id: string, label: string | null) =>
    setBusy((b) => {
      const n = { ...b };
      if (label) n[id] = label;
      else delete n[id];
      return n;
    });

  // ----- Modal de branche (renvoie une promesse) -----
  const askBranch = useCallback(
    (p: Project): Promise<string | null> => {
      setBranchModal({
        projectId: p.id,
        projectName: p.name,
        current: gitMap[p.id]?.branch ?? "—",
        branches: [],
        loading: true,
      });
      api
        .listBranches(bash, p.path)
        .then((bs) =>
          setBranchModal((m) =>
            m && m.projectId === p.id ? { ...m, branches: bs, loading: false } : m,
          ),
        )
        .catch(() =>
          setBranchModal((m) => (m && m.projectId === p.id ? { ...m, loading: false } : m)),
        );
      return new Promise<string | null>((resolve) => {
        branchResolver.current = resolve;
      });
    },
    [bash, gitMap],
  );

  function closeBranch(result: string | null) {
    branchResolver.current?.(result);
    branchResolver.current = null;
    setBranchModal(null);
  }

  // ----- Console : ouvrir / épingler un onglet -----
  const openConsole = useCallback((id: string) => {
    // ré-affiche un onglet qu'on aurait fermé
    setClosedTabs((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    setOpenTabs((s) => {
      if (s.has(id)) return s;
      const n = new Set(s);
      n.add(id);
      return n;
    });
    setActiveConsole(id);
  }, []);

  // Masque un onglet (sans toucher aux logs) : il réapparaît via « Console ».
  const closeConsole = useCallback((id: string) => {
    setClosedTabs((s) => {
      const n = new Set(s);
      n.add(id);
      return n;
    });
    setOpenTabs((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);

  // ----- Actions -----
  const startProject = useCallback(
    async (p: Project) => {
      if (!p.start_command) return;
      openConsole(p.id);
      try {
        await api.startService(p.id, p.path, p.start_command, bash, p.port);
      } catch (e) {
        console.error(e);
      }
    },
    [bash, openConsole],
  );

  const stopProject = useCallback(async (p: Project) => {
    try {
      await api.stopService(p.id);
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Écrit une ligne directement dans la console d'un projet (pour les actions
  // qui ne passent pas par un process : liaison de package).
  const pushLocal = useCallback(
    (target: string, line: string, stream: "out" | "err" | "sys" = "sys") => {
      logBuf.current.push(tagKey({ target, line, stream, ts: Date.now() }));
    },
    [],
  );

  // Après (dé)liaison d'un package dans un service : on arrête le service s'il
  // tournait, on retire le package de node_modules, npm install, puis on relance.
  const postLink = useCallback(
    async (svcId: string, svcPath: string, depName: string, token?: StepToken) => {
      const project = projects.find((p) => p.id === svcId);
      const wasRunning = running.has(svcId);
      const rid = () => token?.runId ?? uid();
      openConsole(svcId);
      setBusyFor(svcId, "MAJ du lien…");
      try {
        if (token?.cancelled) return;
        if (wasRunning) {
          pushLocal(svcId, "■ arrêt avant mise à jour du lien", "sys");
          await api.stopService(svcId);
        }
        if (token?.cancelled) return;
        // Supprime uniquement CE package dans node_modules, où qu'il soit :
        //  - à la racine       node_modules/<nom>
        //  - dans un sous-dossier (scoped, ou autre)  node_modules/*/<nom>
        //  - copies imbriquées (hoisting)  */node_modules/<nom>
        // On ne supprime que de VRAIS packages (présence d'un package.json) ou
        // un lien symbolique déjà posé — jamais un dossier homonyme quelconque.
        // rm -rf gère aussi bien un dossier réel qu'un symlink. Ensuite npm
        // install réinstalle en lien symbolique (package.json -> chemin local).
        const base = depName.split("/").pop() ?? depName;
        const rmCmd =
          `name="${depName}"; base="${base}"; ` +
          `{ printf '%s\\n' "node_modules/$name"; ` +
          `find node_modules -mindepth 2 -maxdepth 2 -name "$base" ! -path "*/.bin/*" 2>/dev/null; ` +
          `find node_modules -path "*/node_modules/$name" -prune 2>/dev/null; } ` +
          `| sort -u | while IFS= read -r d; do ` +
          `[ -n "$d" ] || continue; ` +
          `if [ -L "$d" ] || [ -f "$d/package.json" ]; then echo "suppression: $d"; rm -rf "$d"; fi; ` +
          `done`;
        await api.runAction(rid(), svcId, svcPath, rmCmd, bash);
        if (token?.cancelled) return;
        await api.runAction(rid(), svcId, svcPath, "npm install", bash);
        if (token?.cancelled) return;
        if (wasRunning && project?.start_command) {
          pushLocal(svcId, "▶ redémarrage", "sys");
          await api.startService(svcId, svcPath, project.start_command, bash, project.port);
        }
      } catch (e) {
        pushLocal(svcId, `✖ ${e}`, "err");
      } finally {
        setBusyFor(svcId, null);
      }
    },
    [bash, projects, running, openConsole, pushLocal],
  );

  // Lie (chemin local) ou restaure (version) le package dans tous les services
  // qui le déclarent. Renvoie un code (0 = succès).
  const runPackageDep = useCallback(
    async (p: Project, link: boolean, token?: StepToken): Promise<number> => {
      try {
        const meta = await api.readPackageJson(p.path);
        const value = link ? `../../packages/${p.name}` : meta.version;
        const services = await api.packageLinks(root, meta.name);
        const present = services.filter((s) => s.present);
        pushLocal(p.id, `$ ${link ? "Lier" : "Restaurer"} ${meta.name} → ${value}`, "sys");
        if (!present.length) {
          pushLocal(p.id, `Aucun service n'utilise ${meta.name} — rien à faire.`, "sys");
          return 0;
        }
        for (const s of present) {
          if (token?.cancelled) break;
          try {
            await api.setDepVersion(s.path, meta.name, value);
            pushLocal(p.id, `✔ ${s.name} — reinstallation…`, "out");
            await postLink(s.id, s.path, meta.name, token);
          } catch (e) {
            pushLocal(p.id, `✖ ${s.name} : ${e}`, "err");
          }
        }
        pushLocal(p.id, `✔ terminé (${present.length} service${present.length > 1 ? "s" : ""})`, "sys");
        setLinkVersion((v) => v + 1);
        return token?.cancelled ? 1 : 0;
      } catch (e) {
        pushLocal(p.id, `✖ ${e}`, "err");
        return 1;
      }
    },
    [root, pushLocal, postLink],
  );

  // Exécute une action (bash, démarrage/arrêt, tests, ou opération de package).
  const executeAction = useCallback(
    async (p: Project, a: ActionDef, branch?: string, token?: StepToken): Promise<number> => {
      const runId = token?.runId ?? uid();
      if (a.kind === "start") {
        await startProject(p);
        return 0;
      }
      if (a.kind === "stop") {
        if (running.has(p.id)) await stopProject(p);
        return 0;
      }
      if (a.kind === "restart") {
        if (running.has(p.id)) await stopProject(p);
        await startProject(p);
        return 0;
      }
      if (a.kind === "link") return runPackageDep(p, true, token);
      if (a.kind === "restore") return runPackageDep(p, false, token);
      if (a.kind === "test") {
        openConsole(p.id);
        try {
          const res = await api.runTests(runId, p.id, p.path, a.command || "npm run test:sq", bash);
          setTestResults((m) => ({ ...m, [p.id]: res }));
          return res.failed > 0 ? 1 : 0;
        } catch (e) {
          console.error(e);
          return 1;
        }
      }
      const cmd = a.command.replace("{branch}", branch ?? "");
      return api.runAction(runId, p.id, p.path, cmd, bash);
    },
    [bash, running, openConsole, startProject, stopProject, runPackageDep],
  );

  // ----- File d'exécution (jobs) -----
  function patchStep(jobId: string, stepId: string, status: JobStatus) {
    setJobs((js) =>
      js.map((j) =>
        j.id === jobId
          ? { ...j, steps: j.steps.map((s) => (s.id === stepId ? { ...s, status } : s)) }
          : j,
      ),
    );
  }
  function patchJob(jobId: string, status: JobStatus) {
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, status } : j)));
  }
  function createJob(title: string, project: Project, plan: StepPlan[]): QJob {
    const steps = plan.map((s) => {
      const id = uid();
      tokensRef.current.set(id, { cancelled: false, runId: uid() });
      return { id, label: s.action.label, status: "pending" as JobStatus };
    });
    return {
      id: uid(),
      title,
      projectId: project.id,
      projectName: project.name,
      steps,
      status: "pending",
      cancellable: true,
    };
  }

  const processJob = useCallback(
    async (job: QJob, project: Project, plan: StepPlan[]) => {
      if (jobCancelRef.current.has(job.id)) {
        job.steps.forEach((s) => patchStep(job.id, s.id, "cancelled"));
        patchJob(job.id, "cancelled");
        jobCancelRef.current.delete(job.id);
        return;
      }
      patchJob(job.id, "running");
      openConsole(project.id);
      setBusyFor(project.id, job.title);
      let failed = false;
      let cancelled = false;
      for (let i = 0; i < plan.length; i++) {
        const step = job.steps[i];
        const token = tokensRef.current.get(step.id)!;
        if (token.cancelled) {
          patchStep(job.id, step.id, "cancelled");
          cancelled = true;
          continue;
        }
        patchStep(job.id, step.id, "running");
        let code = 1;
        try {
          code = await executeAction(project, plan[i].action, plan[i].branch, token);
        } catch (e) {
          console.error(e);
          code = 1;
        }
        if (token.cancelled) {
          patchStep(job.id, step.id, "cancelled");
          cancelled = true;
          for (let k = i + 1; k < job.steps.length; k++) {
            const t = tokensRef.current.get(job.steps[k].id);
            if (t) t.cancelled = true;
            patchStep(job.id, job.steps[k].id, "cancelled");
          }
          break;
        }
        if (code !== 0) {
          patchStep(job.id, step.id, "failed");
          failed = true;
          for (let k = i + 1; k < job.steps.length; k++) {
            patchStep(job.id, job.steps[k].id, "cancelled");
          }
          break;
        }
        patchStep(job.id, step.id, "done");
      }
      setBusyFor(project.id, null);
      refreshGitFor(project);
      patchJob(job.id, cancelled ? "cancelled" : failed ? "failed" : "done");
      job.steps.forEach((s) => tokensRef.current.delete(s.id));
      jobCancelRef.current.delete(job.id);
    },
    [executeAction, openConsole, refreshGitFor],
  );

  // Enchaîne les jobs d'un même projet (file d'attente par projet) : si une
  // action tourne déjà, la nouvelle attend la fin de la précédente.
  const chain = useCallback(
    (job: QJob, project: Project, plan: StepPlan[]): Promise<void> => {
      const prev = projectChains.current.get(project.id) ?? Promise.resolve();
      const next = prev.then(() => processJob(job, project, plan)).catch(() => {});
      projectChains.current.set(project.id, next);
      return next;
    },
    [processJob],
  );

  const runActionOn = useCallback(
    (p: Project, a: ActionDef, branch?: string) => {
      const plan: StepPlan[] = [{ action: a, branch }];
      const job = createJob(a.label, p, plan);
      setJobs((js) => [job, ...js]);
      return chain(job, p, plan);
    },
    [chain],
  );

  const runSequenceOn = useCallback(
    async (p: Project, seq: Sequence) => {
      const plan: StepPlan[] = [];
      for (const aid of seq.actionIds) {
        const a = resolveAction(aid);
        if (!a || !actionAllowed(a, p)) continue;
        let branch: string | undefined;
        if (a.needsBranch) {
          const b = await askBranch(p);
          if (!b) continue;
          branch = b;
        }
        plan.push({ action: a, branch });
      }
      if (!plan.length) return;
      const job = createJob(`Séquence « ${seq.name} »`, p, plan);
      setJobs((js) => [job, ...js]);
      await chain(job, p, plan);
    },
    [askBranch, chain, resolveAction],
  );

  const cancelStep = useCallback((jobId: string, stepId: string) => {
    const token = tokensRef.current.get(stepId);
    if (token) {
      token.cancelled = true;
      api.cancelAction(token.runId);
    }
    setJobs((js) =>
      js.map((j) =>
        j.id === jobId
          ? {
              ...j,
              steps: j.steps.map((s) =>
                s.id === stepId && (s.status === "running" || s.status === "pending")
                  ? { ...s, status: "cancelled" }
                  : s,
              ),
            }
          : j,
      ),
    );
  }, []);

  const cancelJob = useCallback((jobId: string) => {
    jobCancelRef.current.add(jobId);
    const job = jobsRef.current.find((j) => j.id === jobId);
    job?.steps.forEach((s) => {
      const t = tokensRef.current.get(s.id);
      if (t && (s.status === "running" || s.status === "pending")) {
        t.cancelled = true;
        api.cancelAction(t.runId);
      }
    });
    setJobs((js) =>
      js.map((j) =>
        j.id === jobId
          ? {
              ...j,
              status: "cancelled",
              steps: j.steps.map((s) =>
                s.status === "done" || s.status === "failed" ? s : { ...s, status: "cancelled" },
              ),
            }
          : j,
      ),
    );
  }, []);

  const clearJobs = useCallback(() => {
    setJobs((js) => js.filter((j) => j.status === "running" || j.status === "pending"));
  }, []);

  // Handlers stables passés aux lignes de projets (nécessaire pour que leur
  // mémoïsation tienne : une arrow inline casserait React.memo).
  const onStartRow = useCallback(
    (p: Project) => {
      const a = resolveAction("start");
      if (a) runActionOn(p, a);
    },
    [resolveAction, runActionOn],
  );
  const onStopRow = useCallback(
    (p: Project) => {
      const a = resolveAction("stop");
      if (a) runActionOn(p, a);
    },
    [resolveAction, runActionOn],
  );
  const onRunTestsRow = useCallback(
    (p: Project) => {
      const a = resolveAction("test");
      if (a) runActionOn(p, a);
    },
    [resolveAction, runActionOn],
  );
  const onOpenConsoleRow = useCallback((p: Project) => openConsole(p.id), [openConsole]);

  // Commande saisie manuellement dans la console d'un projet.
  const runCommandIn = useCallback(
    (target: string, command: string) => {
      const p = projects.find((pr) => pr.id === target);
      if (!p) return;
      runActionOn(p, { id: `cmd-${uid()}`, label: command, command, kind: "bash" });
    },
    [projects, runActionOn],
  );

  const checkout = useCallback(
    async (p: Project) => {
      const target = await askBranch(p);
      if (!target || target === gitMap[p.id]?.branch) return;
      await runActionOn(
        p,
        { id: "checkout", label: "Changer de branche", command: "git checkout {branch}" },
        target,
      );
    },
    [askBranch, gitMap, runActionOn],
  );

  // ----- Édition du fichier .env -----
  const openEnv = useCallback(
    (p: Project) => {
      setEnvModal({
        projectId: p.id,
        projectName: p.name,
        path: p.path,
        original: "",
        running: running.has(p.id),
        loading: true,
        saving: false,
      });
      api
        .readEnv(p.path)
        .then((content) =>
          setEnvModal((m) =>
            m && m.projectId === p.id ? { ...m, original: content, loading: false } : m,
          ),
        )
        .catch((e) =>
          setEnvModal((m) =>
            m && m.projectId === p.id
              ? { ...m, loading: false, error: String(e) }
              : m,
          ),
        );
    },
    [running],
  );

  const saveEnv = useCallback(
    async (content: string) => {
      const m = envModal;
      if (!m) return;
      const p = projects.find((x) => x.id === m.projectId);
      if (!p) return;
      const changed = content !== m.original;
      setEnvModal((cur) => (cur ? { ...cur, saving: true, error: undefined } : cur));
      try {
        await api.saveEnv(p.path, content);
        // Redémarrage uniquement si le contenu a réellement changé et que le
        // service tourne (même logique que l'action « Redémarrer »).
        if (changed && running.has(p.id) && p.start_command) {
          pushLocal(p.id, "▶ .env modifié — redémarrage du service", "sys");
          await stopProject(p);
          await startProject(p);
        }
        setEnvModal(null);
      } catch (e) {
        setEnvModal((cur) => (cur ? { ...cur, saving: false, error: String(e) } : cur));
      }
    },
    [envModal, projects, running, pushLocal, stopProject, startProject],
  );

  // ----- Liaison package <-> service -----
  const openPackageLinks = useCallback(
    async (p: Project) => {
      setLinkModal({
        pkg: p,
        depName: "",
        version: "",
        folder: p.name,
        services: [],
        loading: true,
      });
      try {
        const meta = await api.readPackageJson(p.path);
        const services = await api.packageLinks(root, meta.name);
        setLinkModal((m) =>
          m && m.pkg.id === p.id
            ? { ...m, depName: meta.name, version: meta.version, services, loading: false }
            : m,
        );
      } catch (e) {
        setLinkModal((m) =>
          m && m.pkg.id === p.id ? { ...m, loading: false, error: String(e) } : m,
        );
      }
    },
    [root],
  );

  const applyLink = useCallback(
    async (svc: ServiceDep, link: boolean) => {
      const m = linkModalRef.current;
      if (!m) return;
      const value = link ? `../../packages/${m.folder}` : m.version;
      setLinkBusy(svc.id);
      try {
        await api.setDepVersion(svc.path, m.depName, value);
        await postLink(svc.id, svc.path, m.depName);
        const services = await api.packageLinks(root, m.depName);
        setLinkModal((cur) => (cur && cur.pkg.id === m.pkg.id ? { ...cur, services } : cur));
        setLinkVersion((v) => v + 1);
      } catch (e) {
        setLinkModal((cur) => (cur ? { ...cur, error: String(e) } : cur));
      } finally {
        setLinkBusy(null);
      }
    },
    [root, postLink],
  );

  // ----- Séquences générales (multi-services) -----
  const runGeneralSequence = useCallback(
    async (seq: Sequence, targetIds: string[], branch: string) => {
      const targets = projects.filter((p) => targetIds.includes(p.id));
      const built = targets
        .map((p) => {
          const plan: StepPlan[] = [];
          for (const aid of seq.actionIds) {
            const a = resolveAction(aid);
            if (!a || !actionAllowed(a, p)) continue;
            if (a.needsBranch && !branch) continue;
            plan.push({ action: a, branch: a.needsBranch ? branch : undefined });
          }
          return { job: createJob(`Séquence « ${seq.name} »`, p, plan), project: p, plan };
        })
        .filter((b) => b.plan.length > 0);
      if (!built.length) return;
      setJobs((js) => [...built.map((b) => b.job), ...js]);
      // chaque projet s'exécute dans sa propre file (en parallèle entre projets)
      built.forEach((b) => chain(b.job, b.project, b.plan));
    },
    [projects, chain, resolveAction],
  );

  // ----- Actions globales -----
  const startAll = useCallback(() => {
    projects
      .filter((p) => p.start_command && !running.has(p.id) && !busy[p.id])
      .forEach((p) => startProject(p));
  }, [projects, running, busy, startProject]);

  const stopAll = useCallback(() => {
    projects.filter((p) => running.has(p.id)).forEach((p) => stopProject(p));
  }, [projects, running, stopProject]);

  const restartAll = useCallback(() => {
    const a = resolveAction("restart");
    if (!a) return;
    projects
      .filter((p) => p.start_command && running.has(p.id))
      .forEach((p) => runActionOn(p, a));
  }, [projects, running, runActionOn, resolveAction]);

  // ----- Config -----
  const persist = useCallback(async (next: Config) => {
    setConfig(next);
    await api.saveConfig(next);
  }, []);

  const onSetupSubmit = useCallback(
    async (r: string, b: string, cmd: string) => {
      // Conserve les séquences / actions d'une éventuelle config incomplète
      // (cas d'une ancienne config sans commande de démarrage).
      await persist({
        projects_root: r,
        git_bash_path: b,
        start_command: cmd,
        command_overrides: partialConfig?.command_overrides ?? {},
        sequences: partialConfig?.sequences?.length ? partialConfig.sequences : DEFAULT_SEQUENCES,
        custom_actions: seedActions(partialConfig?.custom_actions ?? []),
        action_colors: partialConfig?.action_colors ?? {},
        actions_seeded: true,
      });
      setPartialConfig(null);
    },
    [persist, partialConfig],
  );

  // ----- Commande de démarrage (modal, ouverte par clic droit) -----
  // project = null : édition de la commande par défaut ; sinon, édition de
  // l'exception propre à ce projet.
  const [cmdModal, setCmdModal] = useState<{ project: Project | null } | null>(null);
  const openStartCommand = useCallback(() => setCmdModal({ project: null }), []);
  const openProjectCommand = useCallback((p: Project) => setCmdModal({ project: p }), []);
  const saveStartCommand = useCallback(
    async (cmd: string | null) => {
      const m = cmdModal;
      setCmdModal(null);
      if (!config || !m) return;
      // Le rescan (déclenché par le changement de config) applique la nouvelle
      // commande aux projets ; ceux déjà lancés la prendront au redémarrage.
      if (m.project) {
        const next = { ...(config.command_overrides ?? {}) };
        if (cmd == null) {
          if (!(m.project.id in next)) return;
          delete next[m.project.id];
        } else {
          if (next[m.project.id] === cmd) return;
          next[m.project.id] = cmd;
        }
        await persist({ ...config, command_overrides: next });
      } else {
        if (cmd == null || cmd === config.start_command) return;
        await persist({ ...config, start_command: cmd });
      }
    },
    [cmdModal, config, persist],
  );

  // ----- Onglets console (ordre personnalisable) -----
  const consoleTabs = useMemo(() => {
    const ids = new Set<string>([
      ...running,
      ...openTabs,
      ...Object.keys(logs).filter((k) => logs[k]?.length),
    ]);
    for (const c of closedTabs) ids.delete(c); // onglets masqués
    const projOrder = projects.map((p) => p.id);
    const arr = [...ids];
    arr.sort((a, b) => {
      const ia = tabOrder.indexOf(a);
      const ib = tabOrder.indexOf(b);
      if (ia !== -1 || ib !== -1) {
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      }
      return projOrder.indexOf(a) - projOrder.indexOf(b);
    });
    return arr.map((id) => ({
      id,
      name: projects.find((p) => p.id === id)?.name ?? id.split(":").pop() ?? id,
      running: running.has(id),
    }));
  }, [running, openTabs, closedTabs, logs, projects, tabOrder]);

  useEffect(() => {
    if (activeConsole && consoleTabs.find((t) => t.id === activeConsole)) return;
    setActiveConsole(consoleTabs[0]?.id ?? null);
  }, [consoleTabs, activeConsole]);

  const grouped = useMemo(() => {
    const g: Record<ProjectKind, Project[]> = { service: [], front: [], package: [] };
    for (const p of projects) g[p.kind].push(p);
    return g;
  }, [projects]);

  const serviceSequences = useMemo(() => sequences.filter((s) => !s.global), [sequences]);
  const globalSequences = useMemo(() => sequences.filter((s) => !!s.global), [sequences]);

  const runningCount = running.size;
  const startableCount = projects.filter((p) => p.start_command).length;
  const canStartAny = projects.some(
    (p) => p.start_command && !running.has(p.id) && !busy[p.id],
  );
  const canStopAny = runningCount > 0;
  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "pending").length;

  // ----- Rendu -----
  if (!ready) return <div className="boot"><span className="spinner" /> Chargement…</div>;
  if (!config)
    return (
      <Setup
        initialRoot={partialConfig?.projects_root ?? ""}
        initialBash={partialConfig?.git_bash_path || DEFAULT_GIT_BASH}
        initialCommand={partialConfig?.start_command ?? ""}
        onSubmit={onSetupSubmit}
      />
    );

  return (
    <div className="app">
      {update && !updateDismissed && (
        <div className="update-banner">
          <span>
            🎉 Une nouvelle version est disponible : <b>v{update.version}</b>
            <span className="update-cur"> (installée : v{update.current})</span>
          </span>
          <span className="update-actions">
            <button className="btn btn-primary btn-sm" onClick={() => api.openUrl(update.url)}>
              Télécharger
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setUpdateDismissed(true)}
              title="Masquer jusqu'au prochain démarrage"
            >
              Plus tard
            </button>
          </span>
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="brand-logo">⚡</span>
          <span className="brand-name">DevLauncher</span>
        </div>
        <div className="topbar-stats">
          <span className="stat">
            <b>{runningCount}</b>/{startableCount} actifs
          </span>
          <span className="stat muted">{projects.length} projets</span>
          {scanning && (
            <span className="stat scanning">
              <span className="spinner" /> analyse…
            </span>
          )}
        </div>
        <div className="topbar-actions">
          <button
            className="btn btn-start"
            onClick={startAll}
            onContextMenu={(e) => {
              e.preventDefault();
              openStartCommand();
            }}
            disabled={view === "settings" || !canStartAny}
            title={`Commande par défaut : ${startCmd || "non définie"} — clic droit pour la modifier`}
          >
            ▶ Tout démarrer
          </button>
          <button
            className="btn btn-stop"
            onClick={stopAll}
            disabled={view === "settings" || !canStopAny}
          >
            ■ Tout arrêter
          </button>
          <button
            className="btn btn-ghost"
            onClick={restartAll}
            disabled={view === "settings" || !canStopAny}
            title="Redémarrer tous les services actuellement allumés"
          >
            ⟳ Tout redémarrer
          </button>
          <button
            className="btn btn-warn"
            onClick={freeAllPorts}
            disabled={view === "settings" || orphanPorts.length === 0}
            title="Tuer les process externes qui occupent les ports de tes services"
          >
            ⚠ Libérer tout{orphanPorts.length > 0 ? ` (${orphanPorts.length})` : ""}
          </button>
          <div className="dropdown">
            <button
              className="btn btn-ghost"
              disabled={view === "settings"}
              onClick={() => setSeqMenuOpen((o) => !o)}
              title="Lancer une séquence sur plusieurs services"
            >
              ⛓ Séquences ▾
            </button>
            {seqMenuOpen && (
              <>
                <div className="dropdown-backdrop" onClick={() => setSeqMenuOpen(false)} />
                <div className="dropdown-menu">
                  <div className="menu-label">Séquences générales</div>
                  {globalSequences.length === 0 && (
                    <div className="menu-empty">
                      Aucune. Créez-en une dans ⚙ Réglages (case « Générale »).
                    </div>
                  )}
                  {globalSequences.map((s) => (
                    <button
                      key={s.id}
                      className="menu-item menu-seq"
                      style={s.color ? ({ "--item-color": s.color } as React.CSSProperties) : undefined}
                      onClick={() => {
                        setSeqMenuOpen(false);
                        setGeneralSeq(s);
                      }}
                    >
                      ⛓ {s.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            className="btn btn-ghost"
            onClick={rescan}
            disabled={scanning}
            title="Re-scanner les dossiers"
          >
            ↻ Scanner
          </button>
          <button
            className={"btn btn-ghost" + (jobsOpen ? " active" : "")}
            onClick={() => setJobsOpen((o) => !o)}
            title="File des actions / séquences en cours"
          >
            ≡ Tâches{activeJobs > 0 ? ` (${activeJobs})` : ""}
          </button>
          <button
            className={"btn btn-ghost" + (view === "settings" ? " active" : "")}
            onClick={() => setView((v) => (v === "settings" ? "dashboard" : "settings"))}
          >
            ⚙ Réglages
          </button>
        </div>
      </header>

      {view === "settings" ? (
        <SettingsView
          config={config}
          projects={projects}
          onPersist={persist}
          onClose={() => setView("dashboard")}
        />
      ) : (
        <div className="main" ref={mainRef}>
          <section className="projects" style={{ width: `${splitPct}%` }}>
            {scanError && <div className="banner-error">{scanError}</div>}

            {scanning && projects.length === 0 && (
              <div className="loading-block">
                <span className="spinner spinner-lg" />
                Analyse des projets…
              </div>
            )}

            {KIND_ORDER.map((kind) =>
              grouped[kind].length === 0 ? null : (
                <div className="group" key={kind}>
                  <div className="group-head">
                    <h2>{KIND_TITLE[kind]}</h2>
                    <span className="group-count">{grouped[kind].length}</span>
                  </div>
                  {grouped[kind].map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      git={gitMap[p.id]}
                      running={running.has(p.id)}
                      busy={busy[p.id]}
                      portInfo={portInfo[p.id]}
                      linkStatus={pkgLinks[p.id]}
                      testResult={testResults[p.id]}
                      actions={allActions}
                      sequences={serviceSequences}
                      onStart={onStartRow}
                      onStop={onStopRow}
                      onAction={runActionOn}
                      onSequence={runSequenceOn}
                      onOpenConsole={onOpenConsoleRow}
                      onCheckout={checkout}
                      onRefreshGit={refreshGitFor}
                      onLinkPackage={openPackageLinks}
                      onFreePort={onFreePort}
                      onRunTests={onRunTestsRow}
                      onEditEnv={openEnv}
                      onEditStartCommand={openProjectCommand}
                    />
                  ))}
                </div>
              ),
            )}
            {projects.length === 0 && !scanning && !scanError && (
              <div className="empty">
                Aucun projet détecté dans <code>{root}</code>.
              </div>
            )}
          </section>

          <div className="splitter" onMouseDown={startSplit} title="Glisser pour redimensionner" />

          <section className="console-pane">
            <Console
              tabs={consoleTabs}
              active={activeConsole}
              setActive={setActiveConsole}
              lines={activeConsole ? logs[activeConsole] ?? [] : []}
              onReorder={setTabOrder}
              onRunCommand={runCommandIn}
              onClear={() => {
                if (!activeConsole) return;
                api.clearLogs(activeConsole);
                setLogs((prev) => ({ ...prev, [activeConsole]: [] }));
              }}
              onClose={closeConsole}
            />
          </section>
        </div>
      )}

      {branchModal && (
        <BranchModal
          state={branchModal}
          onConfirm={(b) => closeBranch(b)}
          onCancel={() => closeBranch(null)}
        />
      )}

      {linkModal && (
        <PackageLinkModal
          state={linkModal}
          busyId={linkBusy}
          onApply={applyLink}
          onClose={() => setLinkModal(null)}
        />
      )}

      {envModal && (
        <EnvModal
          state={envModal}
          onSave={saveEnv}
          onCancel={() => setEnvModal(null)}
        />
      )}

      {cmdModal && (
        <StartCommandModal
          project={cmdModal.project}
          defaultCommand={startCmd}
          override={cmdModal.project ? cmdOverrides[cmdModal.project.id] ?? null : null}
          onSave={saveStartCommand}
          onCancel={() => setCmdModal(null)}
        />
      )}

      {generalSeq && (
        <GeneralSequenceModal
          sequence={generalSeq}
          projects={projects}
          colors={actionColors}
          onRun={(ids, branch) => {
            const seq = generalSeq;
            setGeneralSeq(null);
            runGeneralSequence(seq, ids, branch);
          }}
          onClose={() => setGeneralSeq(null)}
        />
      )}

      {jobsOpen && (
        <TaskQueue
          jobs={jobs}
          onCancelJob={cancelJob}
          onCancelStep={cancelStep}
          onClear={clearJobs}
          onClose={() => setJobsOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vue Réglages
// ---------------------------------------------------------------------------

type SettingsTab = "general" | "startup" | "actions" | "sequences";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "Général" },
  { id: "startup", label: "Démarrage" },
  { id: "actions", label: "Actions" },
  { id: "sequences", label: "Séquences" },
];

function SettingsView({
  config,
  projects,
  onPersist,
  onClose,
}: {
  config: Config;
  projects: Project[];
  onPersist: (c: Config) => Promise<void>;
  onClose: () => void;
}) {
  // Brouillon de travail : source de vérité pendant l'édition. La persistance est
  // automatique (immédiate sur ajout/suppression, différée sur la saisie de texte),
  // l'utilisateur n'a donc plus rien à « enregistrer ».
  const [draft, setDraft] = useState<Config>(config);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [seqTab, setSeqTab] = useState<"project" | "general">("project");
  const [autoStart, setAutoStart] = useState(false);
  const [pending, setPending] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const draftRef = useRef(draft);
  const pendingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settingsActions = [...BUILTIN_ACTIONS, ...draft.custom_actions].map((a) => ({
    ...a,
    color: draft.action_colors[a.id],
  }));
  const missingRequired = !draft.projects_root.trim() || !draft.git_bash_path.trim() || !draft.start_command.trim();

  useEffect(() => {
    autostart.isEnabled().then(setAutoStart).catch(() => {});
  }, []);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const d = draftRef.current;
    // On ne persiste jamais une config invalide (un champ requis vidé).
    if (!d.projects_root.trim() || !d.git_bash_path.trim() || !d.start_command.trim()) {
      return;
    }
    pendingRef.current = false;
    setPending(false);
    await onPersist({
      projects_root: d.projects_root.trim(),
      git_bash_path: d.git_bash_path.trim(),
      start_command: d.start_command.trim(),
      // Les exceptions vidées reviennent à la commande par défaut.
      command_overrides: Object.fromEntries(
        Object.entries(d.command_overrides)
          .map(([id, cmd]) => [id, cmd.trim()])
          .filter(([, cmd]) => cmd),
      ),
      sequences: d.sequences,
      custom_actions: d.custom_actions,
      action_colors: d.action_colors,
      actions_seeded: d.actions_seeded,
    });
    setSavedAt(Date.now());
  }, [onPersist]);

  // Flush du brouillon en attente à la fermeture de la vue (démontage).
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      if (pendingRef.current) flushRef.current();
    },
    [],
  );

  // Applique une modification au brouillon puis planifie sa sauvegarde.
  // `debounce` diffère l'écriture (saisie de texte) pour ne pas persister à chaque frappe.
  function patch(partial: Partial<Config>, debounce = false) {
    const next = { ...draftRef.current, ...partial };
    draftRef.current = next;
    setDraft(next);
    pendingRef.current = true;
    setPending(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (debounce) {
      saveTimer.current = setTimeout(() => void flush(), 500);
    } else {
      void flush();
    }
  }

  // Sauvegarde immédiate sur ajout/suppression (la taille change), différée sur édition.
  const commitActions = (next: ActionDef[]) =>
    patch({ custom_actions: next }, next.length === draftRef.current.custom_actions.length);
  const commitSequences = (next: Sequence[]) =>
    patch({ sequences: next }, next.length === draftRef.current.sequences.length);

  // Couleur d'affichage d'une action : "" = réinitialise (retire l'entrée).
  // Débouncé : le picker « Perso. » émet onChange en continu pendant le drag ;
  // l'aperçu (draft) se met à jour tout de suite, la sauvegarde après 500 ms.
  const setColor = (id: string, color: string) => {
    const next = { ...draftRef.current.action_colors };
    if (color) next[id] = color;
    else delete next[id];
    patch({ action_colors: next }, true);
  };

  const overrides = draft.command_overrides;

  async function toggleAutoStart(v: boolean) {
    try {
      if (v) await autostart.enable();
      else await autostart.disable();
      setAutoStart(v);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="settings">
      <div className="settings-inner">
        <div className="tabs settings-tabs">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              className={"tab" + (tab === t.id ? " on" : "")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "general" && (
          <>
            <h2>Chemins</h2>
            <label className="field">
              <span>Dossier racine des projets</span>
              <div className="field-row">
                <input
                  value={draft.projects_root}
                  onChange={(e) => patch({ projects_root: e.target.value }, true)}
                  onBlur={() => void flush()}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const p = await pickFolder("Choisir la racine des projets");
                    if (p) patch({ projects_root: p });
                  }}
                >
                  Parcourir…
                </button>
              </div>
              {!draft.projects_root.trim() && (
                <small className="field-error">Champ requis pour enregistrer.</small>
              )}
            </label>
            <label className="field">
              <span>Chemin de Git Bash</span>
              <div className="field-row">
                <input
                  value={draft.git_bash_path}
                  onChange={(e) => patch({ git_bash_path: e.target.value }, true)}
                  onBlur={() => void flush()}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const p = await pickBashExe();
                    if (p) patch({ git_bash_path: p });
                  }}
                >
                  Parcourir…
                </button>
              </div>
              {!draft.git_bash_path.trim() && (
                <small className="field-error">Champ requis pour enregistrer.</small>
              )}
            </label>

            <label className="autostart-row">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => toggleAutoStart(e.target.checked)}
              />
              <span>Lancer DevLauncher au démarrage de Windows</span>
            </label>
          </>
        )}

        {tab === "startup" && (
          <>
            <h2>Démarrage</h2>
            <label className="field">
              <span>Commande de démarrage par défaut</span>
              <small className="muted">
                Exécutée dans le dossier de chaque projet démarrable (via Git Bash), sauf exception
                ci-dessous. Aussi modifiable par clic droit sur « Tout démarrer ».
              </small>
              <div className="field-row">
                <input
                  value={draft.start_command}
                  onChange={(e) => patch({ start_command: e.target.value }, true)}
                  onBlur={() => void flush()}
                  placeholder={START_COMMAND_PLACEHOLDER}
                />
              </div>
              {!draft.start_command.trim() && (
                <small className="field-error">Champ requis pour enregistrer.</small>
              )}
            </label>

            <div className="field">
              <span>Exceptions par projet</span>
              <small className="muted">
                Ces projets démarrent avec leur propre commande au lieu de la commande par défaut.
                Aussi modifiable par clic droit sur le bouton « Démarrer » d'un projet.
              </small>
              {Object.entries(overrides).map(([id, cmd]) => (
                <div className="field-row override-row" key={id}>
                  <span className="override-name" title={id}>
                    {projects.find((p) => p.id === id)?.name ?? id.split(":").pop() ?? id}
                  </span>
                  <input
                    value={cmd}
                    onChange={(e) => patch({ command_overrides: { ...overrides, [id]: e.target.value } }, true)}
                    onBlur={() => void flush()}
                    placeholder={START_COMMAND_PLACEHOLDER}
                  />
                  <button
                    className="btn btn-ghost"
                    title="Supprimer l'exception (revient à la commande par défaut)"
                    onClick={() => {
                      const n = { ...overrides };
                      delete n[id];
                      patch({ command_overrides: n });
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="field-row override-row">
                <select
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id) patch({ command_overrides: { ...overrides, [id]: draft.start_command } });
                  }}
                >
                  <option value="">+ Ajouter une exception…</option>
                  {projects
                    .filter((p) => p.kind !== "package" && !(p.id in overrides))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </>
        )}

        {tab === "actions" && (
          <>
            <h2>Actions</h2>
            <p className="muted">
              Actions (nom + commande) disponibles dans le menu Actions des projets et dans les
              séquences. Les actions de base (npm, tests, nettoyage) sont modifiables et
              supprimables ici. La pastille attribue une couleur au libellé (menu + séquences).
            </p>
            <CustomActionManager
              actions={draft.custom_actions}
              colors={draft.action_colors}
              onChange={commitActions}
              onColor={setColor}
            />

            <h2>Actions fixes</h2>
            <p className="muted">
              Actions intégrées non modifiables (Démarrer, Git…) — vous pouvez tout de même leur
              attribuer une couleur.
            </p>
            <div className="fixed-actions">
              {CORE_ACTIONS.map((a) => (
                <div className="fixed-action-row" key={a.id}>
                  <ColorPicker
                    value={draft.action_colors[a.id]}
                    onChange={(c) => setColor(a.id, c)}
                  />
                  <span
                    className="fixed-action-label"
                    style={draft.action_colors[a.id] ? { color: draft.action_colors[a.id] } : undefined}
                  >
                    {a.label}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "sequences" && (
          <>
            <h2>Séquences d'actions</h2>
            <div className="tabs">
              <button
                className={"tab" + (seqTab === "project" ? " on" : "")}
                onClick={() => setSeqTab("project")}
              >
                Par projet
              </button>
              <button
                className={"tab" + (seqTab === "general" ? " on" : "")}
                onClick={() => setSeqTab("general")}
              >
                Générales
              </button>
            </div>
            <p className="muted">
              {seqTab === "project"
                ? "Jouées depuis le menu Actions d'un projet. Elles s'arrêtent si une action échoue."
                : "Jouées depuis le menu ⛓ Séquences. Choisissez ici les projets cibles."}
            </p>
            <SequenceManager
              sequences={draft.sequences}
              mode={seqTab}
              projects={projects}
              actions={settingsActions}
              onChange={commitSequences}
            />
          </>
        )}

        <div className="settings-footer">
          <span className={"settings-status" + (!pending && savedAt ? " saved" : "")}>
            {missingRequired ? (
              "⚠ Complétez les champs requis (onglet Général / Démarrage)"
            ) : pending ? (
              <>
                <span className="spinner" /> Enregistrement…
              </>
            ) : savedAt ? (
              "✓ Modifications enregistrées automatiquement"
            ) : (
              "Enregistrement automatique activé"
            )}
          </span>
          <button className="btn btn-primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
