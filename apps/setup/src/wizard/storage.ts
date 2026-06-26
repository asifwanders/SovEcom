/**
 * Persistence for the setup wizard.
 *
 * - PROGRESS ({ currentIndex, data }) → localStorage 'sovecom.setup.v1'. Survives a
 *   refresh so the operator doesn't lose their place.
 * - The SETUP TOKEN → sessionStorage 'sovecom.setup.token'. It's a short-lived secret,
 *   so it is deliberately NOT in localStorage; it's cleared on completion and dies with
 *   the tab. All reads/writes are wrapped — storage can throw (private mode, quota).
 */
export const PROGRESS_KEY = 'sovecom.setup.v1';
export const TOKEN_KEY = 'sovecom.setup.token';

export interface PersistedProgress {
  currentIndex: number;
  data: Record<string, unknown>;
}

export function loadProgress(): PersistedProgress | null {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as PersistedProgress).currentIndex === 'number' &&
      typeof (parsed as PersistedProgress).data === 'object' &&
      (parsed as PersistedProgress).data !== null
    ) {
      return parsed as PersistedProgress;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveProgress(progress: PersistedProgress): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Best-effort: a failed persist must never break navigation.
  }
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    /* noop */
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* noop */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}
