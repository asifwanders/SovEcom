import type { PeriodPreset, PeriodState } from './types';

/** localStorage key for the persisted dashboard period selection. */
export const PERIOD_STORAGE_KEY = 'sovecom.admin.dashboard.period';

/**
 * Restore the persisted period, falling back to a 30-day default. For non-custom
 * presets the range is recomputed (relative to "now") rather than trusting the
 * stored absolute dates, so "Last 30 days" always means the last 30 days today.
 */
export function loadPeriod(): PeriodState {
  try {
    const raw = localStorage.getItem(PERIOD_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PeriodState>;
      const preset = parsed.preset;
      if (preset === 'custom') {
        if (
          typeof parsed.from === 'string' &&
          typeof parsed.to === 'string' &&
          parsed.from <= parsed.to
        ) {
          return { preset: 'custom', from: parsed.from, to: parsed.to };
        }
      } else if (
        preset === 'today' ||
        preset === 'last7' ||
        preset === 'last30' ||
        preset === 'thisMonth'
      ) {
        return buildPeriod(preset);
      }
    }
  } catch {
    // malformed/unavailable storage — fall through to default
  }
  return buildPeriod('last30');
}

/** Persist the selected period (best-effort). */
export function savePeriod(period: PeriodState): void {
  try {
    localStorage.setItem(
      PERIOD_STORAGE_KEY,
      JSON.stringify({ preset: period.preset, from: period.from, to: period.to }),
    );
  } catch {
    // persistence is best-effort; ignore quota/availability errors
  }
}

/** Format a JS Date as YYYY-MM-DD (local time, not UTC) */
export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Return start-of-day for today in local time */
function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Return a Date offset by N calendar days from start-of-day today */
function daysAgo(n: number): Date {
  const d = today();
  d.setDate(d.getDate() - n);
  return d;
}

/** Build a PeriodState for a given preset. Custom preset falls back to last7. */
export function buildPeriod(preset: PeriodPreset): PeriodState {
  const now = today();
  switch (preset) {
    case 'today':
      return { preset, from: toDateStr(now), to: toDateStr(now) };
    case 'last7':
      return { preset, from: toDateStr(daysAgo(6)), to: toDateStr(now) };
    case 'last30':
      return { preset, from: toDateStr(daysAgo(29)), to: toDateStr(now) };
    case 'thisMonth': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { preset, from: toDateStr(first), to: toDateStr(now) };
    }
    case 'custom':
      // caller supplies explicit from/to; return last7 as fallback initial
      return { preset, from: toDateStr(daysAgo(6)), to: toDateStr(now) };
    default: {
      const _: never = preset;
      void _;
      return { preset: 'last7', from: toDateStr(daysAgo(6)), to: toDateStr(now) };
    }
  }
}

/** Format an ISO date string for display (e.g. "Jun 21, 2026") */
export function formatDate(iso: string): string {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/** Format a bucket label for the chart tooltip */
export function formatBucket(bucket: string, granularity: string): string {
  try {
    const d = new Date(bucket + 'T00:00:00');
    if (granularity === 'month') {
      return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    }
    if (granularity === 'week') {
      return `w/c ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return bucket;
  }
}
