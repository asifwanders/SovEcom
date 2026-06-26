import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { SetupApi } from '@/lib/api';
import { setupApi as defaultApi } from '@/lib/api';
import { useWizardMachine, type WizardMachine } from './useWizardMachine';
import { clearProgress, clearToken, getToken, setToken as persistToken } from './storage';

export interface WizardContextValue {
  machine: WizardMachine;
  /** The typed setup API client (token-injecting on gated calls). */
  api: SetupApi;
  /** The live setup token, or null. Mirrors sessionStorage. */
  token: string | null;
  /** Persist the token to sessionStorage (after a successful verify-token). */
  setToken: (token: string) => void;
  /** Clear BOTH the token and persisted progress (on completion). */
  finishAndClear: () => void;
}

const WizardContext = createContext<WizardContextValue | null>(null);

export interface WizardProviderProps {
  children: React.ReactNode;
  /** Inject a mock API in tests; defaults to the real token-injecting client. */
  api?: SetupApi;
}

export function WizardProvider({ children, api = defaultApi }: WizardProviderProps) {
  const machine = useWizardMachine();
  const [token, setTokenState] = useState<string | null>(() => getToken());

  const setToken = useCallback((value: string) => {
    persistToken(value);
    setTokenState(value);
  }, []);

  const finishAndClear = useCallback(() => {
    clearToken();
    clearProgress();
    setTokenState(null);
  }, []);

  const value = useMemo<WizardContextValue>(
    () => ({ machine, api, token, setToken, finishAndClear }),
    [machine, api, token, setToken, finishAndClear],
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardContext);
  if (!ctx) {
    throw new Error('useWizard must be used within a <WizardProvider>.');
  }
  return ctx;
}
