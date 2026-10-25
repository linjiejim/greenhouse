/**
 * Spend tables and the budget bar shared by Administration › Services &
 * pricing and Settings › Usage. Amounts are USD micros.
 */

import type { ReactNode } from 'react';
import type { SpendRow } from '@greenhouse/types/metering';
import { Tag } from '../ui';
import { useT } from '../../lib/i18n';
import { formatUsd, usedFraction } from '../../lib/metering/format';

/** key → calls → cost, most expensive first, with unpriced calls flagged. */
export function SpendTable({
  rows,
  keyHeader,
  renderKey,
  emptyLabel,
}: {
  rows: SpendRow[];
  keyHeader: string;
  renderKey: (row: SpendRow) => ReactNode;
  emptyLabel: string;
}) {
  const t = useT();
  if (rows.length === 0) return <div className="text-sm text-fg-faint">{emptyLabel}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[360px] text-xs">
        <thead>
          <tr className="text-fg-faint">
            <th className="pb-2 text-left font-medium">{keyHeader}</th>
            <th className="pb-2 text-right font-medium">{t('metering.calls')}</th>
            <th className="pb-2 text-right font-medium">{t('metering.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key || '-'} className="border-b border-edge text-fg-secondary">
              <td className="py-1.5 pr-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {renderKey(row)}
                  {row.unpriced_calls > 0 && (
                    <Tag tone="warning">{t('metering.unpricedCount', { count: row.unpriced_calls })}</Tag>
                  )}
                </div>
              </td>
              <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{row.calls.toLocaleString()}</td>
              <td className="py-1.5 text-right font-mono tabular-nums text-fg">{formatUsd(row.cost_usd_micros)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Spent (solid) and reserved (light) against a limit. */
export function BudgetBar({ spent, reserved, limit }: { spent: number; reserved: number; limit: number }) {
  const spentPct = Math.min(100, usedFraction(spent, limit) * 100);
  const reservedPct = Math.min(100 - spentPct, usedFraction(reserved, limit) * 100);
  const tone = spentPct >= 100 ? 'bg-danger' : spentPct >= 80 ? 'bg-warning' : 'bg-accent';
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
      <div className={`h-full ${tone}`} style={{ width: `${spentPct}%` }} />
      <div className="h-full bg-primary-200" style={{ width: `${reservedPct}%` }} />
    </div>
  );
}
