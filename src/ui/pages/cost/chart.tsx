import { Bar, BarChart, BarStack, CartesianGrid, ResponsiveContainer, Tooltip, type TooltipContentProps, XAxis, YAxis } from 'recharts';
import { formatUsd } from '../../lib/utils';
import { OTHER, type SpendDay, type StackedSeries } from './series';

const SLOTS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

const colorOf = (key: string, index: number): string => (key === OTHER ? 'var(--chart-other)' : (SLOTS[index] ?? 'var(--chart-other)'));

const shortDay = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

const axisUsd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });

const AXIS_TICK = { fill: 'var(--muted-foreground)', fontSize: 12 };

const Swatch = ({ color }: { color: string }) => <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />;

const SpendTooltip = ({ active, payload, keys }: TooltipContentProps & { keys: string[] }) => {
  const datum = payload?.[0]?.payload as SpendDay | undefined;
  if (!active || !datum) return null;
  const rows = keys.map((key, index) => ({ key, color: colorOf(key, index), value: datum.values[key] ?? 0 })).filter((row) => row.value > 0);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <div className="min-w-44 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1.5 font-medium">{shortDay(datum.day)}</div>
      {keys.length > 1
        ? [...rows].reverse().map((row) => (
            <div key={row.key} className="flex items-center gap-2 py-0.5">
              <Swatch color={row.color} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.key}</span>
              <span className="tabular-nums">{formatUsd(row.value)}</span>
            </div>
          ))
        : null}
      <div className={keys.length > 1 ? 'mt-1.5 flex justify-between border-t pt-1.5 font-medium' : 'flex justify-between font-medium'}>
        <span>Total</span>
        <span className="tabular-nums">{formatUsd(total)}</span>
      </div>
    </div>
  );
};

/** Daily USD as stacked bars; the legend carries each series' total so colour is never the only label. */
export const SpendChart = ({ series }: { series: StackedSeries }) => {
  const totals = series.keys.map((key) => series.data.reduce((sum, day) => sum + (day.values[key] ?? 0), 0));
  return (
    <div>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={series.data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis tickFormatter={(value: number) => axisUsd.format(value)} tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} />
          <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.6 }} content={(props) => <SpendTooltip {...props} keys={series.keys} />} />
          <BarStack radius={[4, 4, 0, 0]}>
            {series.keys.map((key, index) => (
              <Bar
                key={key}
                name={key}
                dataKey={(day: SpendDay) => day.values[key] ?? 0}
                fill={colorOf(key, index)}
                stroke="var(--card)"
                strokeWidth={1}
                maxBarSize={40}
              />
            ))}
          </BarStack>
        </BarChart>
      </ResponsiveContainer>
      {series.keys.length > 1 ? (
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
          {series.keys.map((key, index) => (
            <li key={key} className="flex items-center gap-1.5">
              <Swatch color={colorOf(key, index)} />
              <span className="text-muted-foreground">{key}</span>
              <span className="tabular-nums">{formatUsd(totals[index])}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
