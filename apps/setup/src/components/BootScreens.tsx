import { Loader2, AlertCircle, Store } from 'lucide-react';
import { Button } from './ui/button';

/** Brief full-screen loader while GET /setup/v1/status resolves on boot. */
export function BootLoading() {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Store className="h-6 w-6" aria-hidden="true" />
      </span>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking setup status…
      </div>
    </div>
  );
}

/** Boot couldn't reach the API (status check failed). Offer a retry. */
export function BootError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-5 text-center text-foreground">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
        <AlertCircle className="h-6 w-6" aria-hidden="true" />
      </span>
      <div className="space-y-1.5">
        <h1 className="text-xl font-bold tracking-tight">Can’t reach the server</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          We couldn’t check the setup status. Make sure the SovEcom API is running, then try again.
        </p>
      </div>
      <Button onClick={onRetry}>Retry</Button>
    </div>
  );
}
