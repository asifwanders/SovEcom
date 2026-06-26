import { Store, CheckCircle2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

/**
 * Shown when GET /setup/v1/status returns installed:true. The wizard
 * must NEVER re-run on an installed system — this is the only thing the app renders in
 * that case. A single CTA to the admin.
 */
export function AlreadyInstalled() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5 text-foreground">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-5 px-8 py-10 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Store className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="space-y-1.5">
            <div className="flex items-center justify-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
              <h1 className="text-xl font-bold tracking-tight">Already set up</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              This SovEcom store has already finished setup. There’s nothing more to do here.
            </p>
          </div>
          <Button onClick={() => window.location.assign('/admin')} className="w-full">
            Go to admin
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
