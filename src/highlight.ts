import hljs from "highlight.js";

/**
 * Coloration syntaxique (highlight.js, ~190 langages). Le langage est déduit du
 * nom de fichier : alias highlight.js de l'extension (ts, tsx, py, cs, yml…),
 * complétés par quelques cas qu'il ne connaît pas (vue, svelte, Dockerfile…).
 */
const EXT_MAP: Record<string, string> = {
  vue: "xml",
  svelte: "xml",
  astro: "xml",
  htm: "xml",
  xhtml: "xml",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  csproj: "xml",
  props: "xml",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  jsonc: "json",
  json5: "json",
  lock: "json",
  env: "ini",
  properties: "properties",
  cfg: "ini",
  conf: "ini",
  editorconfig: "ini",
  gitignore: "bash",
  dockerignore: "bash",
  bat: "dos",
  cmd: "dos",
  psm1: "powershell",
  psd1: "powershell",
  sass: "scss",
  pcss: "css",
  postcss: "css",
  prisma: "graphql",
  gql: "graphql",
  tf: "ini",
  hbs: "handlebars",
  ejs: "xml",
  razor: "cshtml",
  txt: "plaintext",
  log: "plaintext",
};

const NAME_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  jenkinsfile: "groovy",
  vagrantfile: "ruby",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  cmakelists: "cmake",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".npmrc": "ini",
  ".gitconfig": "ini",
};

/** Langage highlight.js pour ce chemin, ou null (texte brut). */
export function langForFile(path: string): string | null {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  const base = name.replace(/\.txt$/, "");
  if (NAME_MAP[base]) return NAME_MAP[base];
  if (name.startsWith("dockerfile")) return "dockerfile";
  if (name.startsWith(".env")) return "ini";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1);
  const mapped = EXT_MAP[ext] ?? ext;
  if (mapped === "plaintext") return null;
  return hljs.getLanguage(mapped) ? mapped : null;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML coloré (spans hljs-*) ; texte échappé si le langage est inconnu. */
export function highlightCode(code: string, lang: string | null): string {
  if (!lang) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
