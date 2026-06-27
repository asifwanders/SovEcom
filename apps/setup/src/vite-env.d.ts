/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin override; mirrors apps/admin. Defaults to the `/api` dev proxy. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Runtime config injected by the container entrypoint into public/config.js. */
interface SovEcomRuntimeConfig {
  /** Public API base URL — injected at container start via API_BASE_URL env var. */
  apiBaseUrl?: string;
}

declare interface Window {
  __SOVECOM__?: SovEcomRuntimeConfig;
}
