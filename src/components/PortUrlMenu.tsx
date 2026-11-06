import { useEffect, useRef, useState } from "react";
import { isDefaultServiceUrl, serviceUrlFor } from "../serviceUrl";
import type { Project, ServiceUrl } from "../types";

interface Props {
  project: Project;
  /** Position du clic droit (coordonnées fenêtre). */
  at: { x: number; y: number };
  value?: ServiceUrl;
  onSave: (p: Project, v: ServiceUrl | null) => void;
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}

const W = 280;
const H = 190;
const MG = 8;

/** Menu du clic droit sur la puce port : http/https + suite de l'URL, puis ouvrir. */
export function PortUrlMenu({ project, at, value, onSave, onOpenUrl, onClose }: Props) {
  const [https, setHttps] = useState(!!value?.https);
  const [path, setPath] = useState(value?.path ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const draft: ServiceUrl = { https, path: path.trim() };
  const url = serviceUrlFor(project, draft) ?? "";

  // Enregistre le réglage s'il a changé (fermeture, ouverture…).
  const latest = useRef({ draft, value });
  latest.current = { draft, value };
  const save = () => {
    const { draft: d, value: v } = latest.current;
    if (!!d.https === !!v?.https && (d.path ?? "") === (v?.path ?? "")) return;
    onSave(project, isDefaultServiceUrl(d) ? null : d);
  };

  useEffect(() => {
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element && e.target.closest(".port-url-menu"))) {
        save();
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose(); // Échap = annuler
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = () => {
    save();
    onClose();
    if (url) onOpenUrl(url);
  };

  return (
    <div
      className="context-menu port-url-menu"
      style={{
        left: Math.max(MG, Math.min(at.x, window.innerWidth - W - MG)),
        top: Math.max(MG, Math.min(at.y, window.innerHeight - H - MG)),
        width: W,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="menu-title">URL — {project.name}</div>
      <div className="port-url-body">
        <div className="port-url-scheme">
          <button
            className={"btn btn-sm" + (!https ? " btn-primary" : "")}
            onClick={() => setHttps(false)}
          >
            http
          </button>
          <button
            className={"btn btn-sm" + (https ? " btn-primary" : "")}
            onClick={() => setHttps(true)}
          >
            https
          </button>
        </div>
        <label className="port-url-path">
          <span className="muted">localhost:{project.port}</span>
          <input
            ref={inputRef}
            value={path}
            placeholder="/api"
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                open();
              }
            }}
          />
        </label>
        <div className="port-url-preview" title={url}>
          {url}
        </div>
        <div className="port-url-actions">
          <button
            className="btn btn-sm"
            onClick={() => {
              save();
              onClose();
            }}
          >
            Enregistrer
          </button>
          <button className="btn btn-sm btn-primary" onClick={open}>
            Ouvrir ↗
          </button>
        </div>
      </div>
    </div>
  );
}
