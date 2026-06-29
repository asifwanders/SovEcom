import { Area, AreaChart, ResponsiveContainer } from 'recharts';

interface SparklineProps {
  /** Numeric series in bucket order. Empty/all-zero renders nothing. */
  data: number[];
  /** Accessible label describing the trend. */
  ariaLabel?: string;
  height?: number;
}

// Read the teal primary token at render time so the sparkline tracks light/dark theme.
function primaryColor(): string {
  if (typeof window === 'undefined') return '#00B9A0';
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#00B9A0'
  );
}

export function Sparkline({ data, ariaLabel, height = 32 }: SparklineProps) {
  // Nothing meaningful to draw (no points, or a flat zero line).
  if (!data.length || data.every((v) => v === 0)) {
    return <div style={{ height }} aria-hidden="true" />;
  }

  const color = primaryColor();
  const chartData = data.map((value, i) => ({ i, value }));
  // Unique gradient id per render is unnecessary; a stable id is fine since fill is the same teal.
  const gradId = 'sparkline-fill';

  return (
    <div style={{ height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
