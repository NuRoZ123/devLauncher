import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface EnvModalState {
  projectId: string;
  projectName: string;
  path: string;
  /** Contenu tel que chargé depuis le disque (pour détecter les changements). */
  original: string;
  /** true = le service tourne : l'enregistrement déclenchera un redémarrage. */
  running: boolean;
  loading: boolean;
  saving: boolean;
  error?: string;
}

interface Props {
  state: EnvModalState;
  onSave: (content: string) => void;
  onCancel: () => void;
}

/** Une ligne est-elle commentée (« # » éventuellement précédé d'espaces) ? */
function isCommented(line: string): boolean {
  return /^\s*#/.test(line);
}

/**
 * Bascule le commentaire des lignes couvertes par `[selStart, selEnd]` : retire
 * le « # » si **toutes** les lignes non vides du bloc sont commentées, sinon en
 * ajoute un en tête de chacune (comportement habituel des éditeurs). Les lignes
 * vides sont laissées telles quelles.
 *
 * Renvoie le nouveau texte et la sélection à restaurer (le textarea étant
 * contrôlé, React la remettrait sinon en fin de contenu).
 */
function toggleComment(
  value: string,
  selStart: number,
  selEnd: number,
): { value: string; selStart: number; selEnd: number } | null {
  const NL = "\n";
  const blockStart = value.lastIndexOf(NL, selStart - 1) + 1;
  // Sélection s'arrêtant pile en début de ligne : cette ligne-là n'en fait pas
  // partie (sinon un simple « tout sélectionner » déborderait d'une ligne).
  const endProbe = selEnd > selStart && value[selEnd - 1] === NL ? selEnd - 1 : selEnd;
  const nlAfter = value.indexOf(NL, endProbe);
  const blockEnd = nlAfter === -1 ? value.length : nlAfter;

  const lines = value.slice(blockStart, blockEnd).split(NL);
  const filled = lines.filter((l) => l.trim() !== "");
  if (!filled.length) return null; // que des lignes vides : rien à commenter

  const uncomment = filled.every(isCommented);
  // On ajoute le « # » en colonne 0 et on ne retire que le « # » lui-même :
  // l'aller-retour redonne exactement la ligne d'origine.
  const next = lines.map((l) =>
    l.trim() === "" ? l : uncomment ? l.replace(/^(\s*)#/, "$1") : "#" + l,
  );

  const firstDelta = next[0].length - lines[0].length;
  const totalDelta = next.join(NL).length - lines.join(NL).length;
  return {
    value: value.slice(0, blockStart) + next.join(NL) + value.slice(blockEnd),
    // Une sélection qui commençait en début de ligne y reste (elle englobe alors
    // le « # » ajouté) ; sinon le curseur suit le décalage de sa propre ligne.
    selStart: selStart === blockStart ? blockStart : Math.max(blockStart, selStart + firstDelta),
    selEnd: Math.max(blockStart, selEnd + totalDelta),
  };
}

/** Partie de valeur : `${VAR}` / `$VAR` mis en évidence, le reste avec la classe `cls`. */
function valueParts(text: string, cls: string, interp: boolean): ReactNode[] {
  if (!interp) return [<span className={cls}>{text}</span>];
  const out: ReactNode[] = [];
  const re = /\$\{[^}]*\}?|\$[A-Za-z_][A-Za-z0-9_]*/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push(<span className={cls}>{text.slice(last, m.index)}</span>);
    out.push(<span className="env-tk-var">{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span className={cls}>{text.slice(last)}</span>);
  return out;
}

/** Valeur non entre guillemets : nombre, booléen/null ou texte brut. */
function bareClass(v: string): string {
  if (/^-?\d+(\.\d+)?$/.test(v)) return "env-tk-num";
  if (/^(true|false|null|yes|no|on|off)$/i.test(v)) return "env-tk-lit";
  return "env-tk-val";
}

/** Colore une ligne de .env : `[export] CLE = valeur  # commentaire`. */
function highlightLine(line: string): ReactNode[] {
  if (/^\s*#/.test(line)) return [<span className="env-tk-comment">{line}</span>];
  const m = /^(\s*)(export\s+)?([^=\s#]+)(\s*=\s*)(.*)$/.exec(line);
  if (!m) return line.trim() ? [<span className="env-tk-bad">{line}</span>] : [line];
  const [, indent, exp, key, eq, rest] = m;
  const out: ReactNode[] = [indent];
  if (exp) out.push(<span className="env-tk-kw">{exp}</span>);
  out.push(<span className="env-tk-key">{key}</span>, <span className="env-tk-eq">{eq}</span>);

  let value = rest;
  let tail = "";
  const q = rest[0];
  if (q === '"' || q === "'" || q === "`") {
    // Chaîne entre guillemets (non fermée : jusqu'au bout de la ligne).
    const end = rest.indexOf(q, 1);
    value = end === -1 ? rest : rest.slice(0, end + 1);
    tail = rest.slice(value.length);
    out.push(...valueParts(value, "env-tk-str", q !== "'"));
  } else {
    // Valeur brute : un « # » précédé d'un espace ouvre un commentaire.
    const hash = rest.search(/\s#/);
    if (hash !== -1) {
      value = rest.slice(0, hash);
      tail = rest.slice(hash);
    }
    const trimmed = value.trimEnd();
    out.push(...valueParts(trimmed, bareClass(trimmed), true), value.slice(trimmed.length));
  }
  if (tail) {
    const c = tail.indexOf("#");
    if (c === -1) out.push(tail);
    else out.push(tail.slice(0, c), <span className="env-tk-comment">{tail.slice(c)}</span>);
  }
  return out;
}

export function EnvModal({ state, onSave, onCancel }: Props) {
  const [content, setContent] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  // Couche colorée affichée sous le textarea (dont le texte est transparent).
  const highlighted = useMemo(
    () =>
      // Fins de ligne Windows : le textarea affiche CRLF comme un seul retour, et
      // un « \r » resté en fin de ligne ferait passer chaque ligne pour invalide.
      content.split(/\r?\n/).map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          {highlightLine(line).map((part, j) => (
            <Fragment key={j}>{part}</Fragment>
          ))}
        </Fragment>
      )),
    [content],
  );
  const syncScroll = () => {
    const ta = taRef.current;
    const hl = hlRef.current;
    if (!ta || !hl) return;
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  };
  // Une saisie peut faire défiler le textarea sans événement scroll exploitable
  // avant le rendu de la nouvelle couche : on réaligne après chaque changement.
  useLayoutEffect(syncScroll, [content]);
  // Sélection à réappliquer après un rendu déclenché par Ctrl+/ (voir plus bas).
  const pendingSel = useRef<{ start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    const sel = pendingSel.current;
    if (!sel || !taRef.current) return;
    pendingSel.current = null;
    taRef.current.setSelectionRange(sel.start, sel.end);
  });

  /**
   * Ctrl+/ : commente / décommente la ligne courante (ou toutes les lignes de la
   * sélection). On accepte aussi Ctrl+: — sur un clavier AZERTY, « / » est en
   * majuscule de cette touche, et c'est ce que les éditeurs y déclenchent.
   */
  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key !== "/" && e.key !== ":" && e.code !== "Slash" && e.code !== "NumpadDivide") return;
    e.preventDefault();
    const ta = e.currentTarget;
    const res = toggleComment(ta.value, ta.selectionStart, ta.selectionEnd);
    if (!res) return;
    pendingSel.current = { start: res.selStart, end: res.selEnd };
    setContent(res.value);
  };

  // Réinitialise le textarea quand le contenu du disque arrive (fin de chargement).
  useEffect(() => {
    if (!state.loading) setContent(state.original);
  }, [state.loading, state.original]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const dirty = content !== state.original;
  const busy = state.loading || state.saving;

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal modal-env" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Modifier le .env</h3>
          <button className="tab-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-sub">
          <span className="muted">{state.projectName}</span>
          <code className="env-path">.env</code>
          {dirty && !busy && <span className="chip chip-dirty">modifié</span>}
        </div>

        {state.error && <div className="banner-error">{state.error}</div>}

        <div className="env-editor-wrap">
          {state.loading ? (
            <div className="branch-loading">
              <span className="spinner" /> Chargement du fichier…
            </div>
          ) : (
            <div className={"env-editor-stack" + (state.saving ? " is-disabled" : "")}>
              <pre ref={hlRef} className="env-editor env-editor-hl" aria-hidden>
                {highlighted}
                {/* Ligne finale vide : garde la même hauteur de défilement que le textarea. */}
                {"\n"}
              </pre>
              <textarea
                ref={taRef}
                className="env-editor env-editor-input"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                value={content}
                disabled={state.saving}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={onEditorKeyDown}
                onScroll={syncScroll}
              />
            </div>
          )}
        </div>

        <div className="env-hint muted">
          <code>Ctrl</code> + <code>/</code> commente ou décommente la ligne.{" "}
          {state.running
            ? "L'enregistrement redémarrera le service si le contenu a changé."
            : "Le service n'est pas démarré : les changements s'appliqueront au prochain lancement."}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>
            Annuler
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !dirty}
            onClick={() => onSave(content)}
          >
            {state.saving ? (
              <span className="spinner spinner-xs" />
            ) : state.running ? (
              "Enregistrer & redémarrer"
            ) : (
              "Enregistrer"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
