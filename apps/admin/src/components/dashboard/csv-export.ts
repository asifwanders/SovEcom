import type { SummaryResponse, TimeseriesResponse } from './types';

/** Escape a single CSV field per RFC 4180 (quote when it contains , " or newline). */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(fields: (string | number)[]): string {
  return fields.map(csvField).join(',');
}

/**
 * Serialize the current dashboard view (summary KPIs + timeseries points) to a
 * single CSV string. Money stays in integer minor units (no float conversion);
 * the currency is included so the figures are unambiguous.
 */
export function buildDashboardCsv(
  summary: SummaryResponse | undefined,
  timeseries: TimeseriesResponse | undefined,
): string {
  const lines: string[] = [];

  // --- KPI summary block ---
  lines.push(row(['Metric', 'Value', 'Previous', 'Delta %', 'Currency']));
  if (summary) {
    const cur = summary.currency;
    const m = summary.metrics;
    const moneyKeys = new Set(['netRevenue', 'averageOrderValue', 'refunds']);
    (Object.keys(m) as (keyof typeof m)[]).forEach((key) => {
      const metric = m[key];
      const isMoney = moneyKeys.has(key);
      lines.push(
        row([
          key,
          metric.value,
          metric.previous,
          metric.deltaPct === null ? '' : metric.deltaPct,
          isMoney ? cur : '',
        ]),
      );
    });
  }

  // Blank separator line between the two blocks.
  lines.push('');

  // --- Timeseries block ---
  lines.push(row(['Bucket', 'Revenue', 'Orders', 'New customers', 'Refund amount', 'Currency']));
  if (timeseries) {
    const cur = timeseries.currency;
    timeseries.points.forEach((p) => {
      lines.push(row([p.bucket, p.revenue, p.orders, p.newCustomers, p.refundAmount, cur]));
    });
  }

  return lines.join('\r\n');
}

/**
 * Trigger a client-side CSV download via a Blob + object URL anchor, mirroring
 * the audit-log download mechanics. Filename embeds the date range.
 */
export function downloadCsv(csv: string, from: string, to: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `dashboard-${from}_to_${to}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
