/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin override; mirrors apps/admin. Defaults to the `/api` dev proxy. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
