'use client';

/**
 * Root global error boundary. Next renders this only when the root layout itself throws;
 * locale-specific errors are handled by `[locale]/error.tsx`. Because this replaces the root
 * layout, it must render its own `<html>`/`<body>`. Kept minimal and dependency-free with no
 * sensitive data (no stack traces or error messages) — just a neutral notice and retry button.
 * Next still shows its full overlay in development; this is the production fallback UI.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          margin: 0,
          padding: '2rem',
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ marginTop: '0.5rem', color: '#666' }}>Please try again in a moment.</p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: '1.5rem',
              padding: '0.625rem 1.25rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
