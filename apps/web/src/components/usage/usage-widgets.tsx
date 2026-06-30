/**
 * Shared presentational primitives + constants for the LLM usage dashboards.
 *
 * The settings "Usage" panel (pages/settings/usage-enhanced.tsx) renders the
 * KPI cards and distribution bars over the period selector defined here.
 */

import type { ReactNode } from 'react';

export const PERIODS = [
  { label: 'All Time', value: '' },
  { label: 'Last 30 Days', value: '30d' },
  { label: 'Last 7 Days', value: '7d' },
  { label: 'Last 24 Hours', value: '24h' },
] as const;

export function periodToSince(value: string): string | undefined {
  if (!value) return undefined;
  const now = new Date();
  switch (value) {
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    default:
      return undefined;
  }
}

export const CALLER_COLORS: Record<string, string> = {
  chat: 'bg-info',
  compiler: 'bg-primary-500',
  judge: 'bg-warning',
  api: 'bg-fg-muted',
};

export const PROFILE_COLORS = ['bg-primary-500', 'bg-info', 'bg-danger', 'bg-warning', 'bg-success', 'bg-fg-muted'];

export function KpiCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-surface-raised border border-edge rounded-xl p-4 shadow-sm">
      <div className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

export function DistributionBar({ items }: { items: Array<{ label: string; value: number; color: string }> }) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total === 0) return <div className="text-sm text-fg-faint">No data</div>;

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const pct = (item.value / total) * 100;
        return (
          <div key={item.label} className="flex items-center gap-2">
            <div className="w-24 text-xs text-fg-secondary font-medium truncate" title={item.label}>
              {item.label}
            </div>
            <div className="flex-1 bg-surface-muted rounded-full h-2.5 overflow-hidden">
              <div className={`h-full rounded-full ${item.color}`} style={{ width: `${Math.max(pct, 1)}%` }} />
            </div>
            <div className="w-16 text-right text-xs text-fg-muted">{item.value.toLocaleString()}</div>
            <div className="w-12 text-right text-[11px] text-fg-faint">{pct.toFixed(0)}%</div>
          </div>
        );
      })}
    </div>
  );
}
