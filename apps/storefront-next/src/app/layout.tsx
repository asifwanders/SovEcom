/**
 * Top-level passthrough layout. With sub-path locale routing the
 * real `<html>`/`<body>` shell lives in `app/[locale]/layout.tsx` (it needs the active locale for
 * `lang`/`dir` + the localized chrome). Next still requires a root layout, so this one is a thin
 * passthrough that returns its children unchanged — every real request is rewritten under `/<locale>`
 * by the middleware, so this only wraps the locale layout's output.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
