import React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n-context';
import type { PeriodPreset, PeriodState } from './types';
import { buildPeriod, formatDate, toDateStr } from './period-utils';

interface PeriodSelectorProps {
  period: PeriodState;
  onChange: (p: PeriodState) => void;
}

const PRESETS: PeriodPreset[] = ['today', 'last7', 'last30', 'thisMonth', 'custom'];

function presetLabel(preset: PeriodPreset, t: (s: 'dashboard', k: string) => string): string {
  const map: Record<PeriodPreset, string> = {
    today: t('dashboard', 'periodToday'),
    last7: t('dashboard', 'periodLast7'),
    last30: t('dashboard', 'periodLast30'),
    thisMonth: t('dashboard', 'periodThisMonth'),
    custom: t('dashboard', 'periodCustom'),
  };
  return map[preset];
}

export function PeriodSelector({ period, onChange }: PeriodSelectorProps) {
  const { t } = useT();

  const [customFrom, setCustomFrom] = React.useState(period.from);
  const [customTo, setCustomTo] = React.useState(period.to);
  const [showCustom, setShowCustom] = React.useState(period.preset === 'custom');

  function handlePreset(preset: PeriodPreset) {
    if (preset === 'custom') {
      setShowCustom(true);
      // Don't close — let the user pick dates and hit Apply
      return;
    }
    setShowCustom(false);
    onChange(buildPeriod(preset));
  }

  function handleApplyCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!customFrom || !customTo || customFrom > customTo) return;
    onChange({ preset: 'custom', from: customFrom, to: customTo });
  }

  const rangeLabel =
    period.from === period.to
      ? formatDate(period.from)
      : `${formatDate(period.from)} – ${formatDate(period.to)}`;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
      {/* Segmented control */}
      <div
        role="group"
        aria-label="Select time period"
        className="inline-flex rounded-lg border border-border bg-muted p-1 gap-1"
      >
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => handlePreset(preset)}
            aria-pressed={period.preset === preset}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              period.preset === preset
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-background',
            )}
          >
            {presetLabel(preset, t as Parameters<typeof presetLabel>[1])}
          </button>
        ))}
      </div>

      {/* Active range display */}
      <span className="text-sm text-muted-foreground" aria-live="polite">
        {rangeLabel}
      </span>

      {/* Custom date picker */}
      {showCustom && (
        <form
          onSubmit={handleApplyCustom}
          className="flex items-center gap-2 flex-wrap"
          aria-label="Custom date range"
        >
          <label className="sr-only" htmlFor="dash-from">
            {t('dashboard', 'fromDate')}
          </label>
          <input
            id="dash-from"
            type="date"
            value={customFrom}
            max={toDateStr(new Date())}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            required
          />
          <span className="text-muted-foreground text-sm">–</span>
          <label className="sr-only" htmlFor="dash-to">
            {t('dashboard', 'toDate')}
          </label>
          <input
            id="dash-to"
            type="date"
            value={customTo}
            min={customFrom}
            max={toDateStr(new Date())}
            onChange={(e) => setCustomTo(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            required
          />
          <Button type="submit" size="sm" variant="outline">
            {t('dashboard', 'apply')}
          </Button>
        </form>
      )}
    </div>
  );
}
