/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Slug "owner/repo" injecté au build par la CI pour la vérification de mise à jour. */
  readonly VITE_GITHUB_REPO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
