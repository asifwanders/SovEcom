'use client';

/**
 * Storefront route-segment error boundary — fail-closed safety net.
 *
 * Next renders this whenever a render under `[locale]` THROWS (a Server/Client Component error in the
 * subtree — including, defensively, a module slot widget). Without it an uncaught throw is a white-screen
 * 500; with it the segment degrades to this graceful, content-free fallback and the rest of the app
 * (chrome) stays intact. This makes "a module can never break the page" a STRUCTURAL guarantee, not just
 * a disciplinary one (every widget path already fails closed to null; this is the belt-and-braces net for
 * any future render that throws).
 *
 * Deliberately TINY + dependency-free: it does NOT use `useTranslations` (the boundary must survive even
 * if the i18n provider above it is what failed) and renders NO error stack / message / PII — only a
 * neutral, token-styled notice + a Retry that re-renders the segment and a same-origin link home. It does
 * NOT change dev behaviour: Next still shows its full error overlay in development; this is the production
 * fallback UI.
 */
import { useEffect } from 'react';

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the browser console for debugging without rendering anything sensitive to the page.
    // (No PII / stack is rendered into the DOM — only logged client-side.)
    // eslint-disable-next-line no-console
    console.error('A storefront segment failed to render.');
  }, []);

  return (
    <div className="mx-auto flex max-w-6xl flex-col items-center px-4 py-20 text-center">
      <h1 className="text-2xl font-semibold text-foreground">Something went wrong</h1>
      <p className="mt-2 max-w-md text-muted-foreground">
        This part of the page couldn’t be displayed. Please try again.
      </p>
      <div className="mt-8 flex gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Try again
        </button>
        <a
          href="/"
          className="inline-flex items-center rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          Go home
        </a>
      </div>
    </div>
  );
}
