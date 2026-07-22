/// <reference types="vite/client" />

/** Version de l'application, injectée au build depuis package.json. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Slug "owner/repo" injecté au build par la CI pour la vérification de mise à jour. */
  readonly VITE_GITHUB_REPO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
