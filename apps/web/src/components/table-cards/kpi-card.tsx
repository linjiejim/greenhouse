/**
 * KPI card: one headline number (`formatKpi`, at most two decimals), its
 * caption, and — when the host can drill — a way to see the records behind it.
 */

import { formatKpi } from '@greenhouse/ui/lib/number-format';
import { Button } from '../ui';
import { ArrowRight } from '../../lib/icons';
import { useT } from '../../lib/i18n';

export function KpiCard({
  value,
  caption,
  onViewRecords,
}: {
  value: number;
  caption: string;
  onViewRecords?: () => void;
}) {
  const t = useT();
  const rounded = Math.round(value * 100) / 100;
  const formatted = formatKpi(rounded) ?? '—';
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-2">
      <div
        className="text-3xl leading-none font-semibold tracking-tight text-fg tabular-nums"
        data-testid="table-card-kpi"
      >
        {formatted}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-xs text-fg-muted" title={caption}>
          {caption}
        </span>
        {onViewRecords && (
          <Button variant="ghost" size="sm" onClick={onViewRecords} className="flex-shrink-0 gap-1">
            {t('tables.dashboard.card.viewRecords')}
            <ArrowRight size={12} />
          </Button>
        )}
      </div>
    </div>
  );
}
