import { useCallback, useEffect, useState } from 'react';
import { setupApi, type SetupApi } from '@/lib/api';
import { WizardProvider } from '@/wizard/WizardContext';
import { useSystemDarkMode } from '@/wizard/useDarkMode';
import { Wizard } from '@/components/Wizard';
import { AlreadyInstalled } from '@/components/AlreadyInstalled';
import { BootLoading, BootError } from '@/components/BootScreens';

type BootState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'installed' }
  | { phase: 'wizard' };

export interface AppProps {
  /** Inject a mock API in tests; defaults to the real token-injecting client. */
  api?: SetupApi;
}

/**
 * App boot: on mount, GET /setup/v1/status.
 *   installed:true → render the "already set up → go to admin" screen (never the wizard).
 *   otherwise      → render the wizard at the persisted step.
 * A failed status check shows a retryable error rather than guessing.
 */
function App({ api = setupApi }: AppProps) {
  useSystemDarkMode();
  const [boot, setBoot] = useState<BootState>({ phase: 'loading' });

  const checkStatus = useCallback(
    async (signal?: AbortSignal) => {
      setBoot({ phase: 'loading' });
      try {
        const status = await api.status(signal);
        if (signal?.aborted) return;
        setBoot({ phase: status.installed ? 'installed' : 'wizard' });
      } catch {
        if (signal?.aborted) return;
        setBoot({ phase: 'error' });
      }
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    void checkStatus(controller.signal);
    return () => controller.abort();
  }, [checkStatus]);

  if (boot.phase === 'loading') return <BootLoading />;
  if (boot.phase === 'error') return <BootError onRetry={() => void checkStatus()} />;
  if (boot.phase === 'installed') return <AlreadyInstalled />;

  return (
    <WizardProvider api={api}>
      <Wizard />
    </WizardProvider>
  );
}

export default App;
