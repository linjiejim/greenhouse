/**
 * What one card shows, from what the server worked out for it: loading, why it shows nothing
 * (with 编辑卡片 for whoever may change it), no matching records, or its figure, chart or list.
 */

import { CircleAlert } from 'lucide-react';
import { Button, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { BaseTable, Card, CardData } from '@greenhouse/contract';
import { useI18n } from '../../../lib/i18n';
import { BarList, LineChart, NumberFigure, PieChart, RecordList } from './charts';
import { dataKindOf, precisionOf } from './model';

export function CardBody({
  card,
  data,
  baseId,
  table,
  label,
  onEdit,
}: {
  card: Card;
  /** Undefined while it loads. */
  data: CardData | undefined;
  baseId: string;
  table: BaseTable | undefined;
  /** The card's title: names its chart or list. */
  label: string;
  /** For whoever may change the card: a way to finish it. */
  onEdit?: () => void;
}) {
  const { t } = useI18n();
  // Figures of another kind are those of the card before a change; its own are on their way.
  if (!data || (data.kind !== 'error' && data.kind !== dataKindOf(card.kind))) return <Skeleton lines={3} />;
  if (data.kind === 'error') {
    return (
      <div className="app-tb-dash-problem" role="status">
        <CircleAlert size={icon.md} strokeWidth={icon.stroke} aria-hidden />
        <p>{t(`tables.dashboards.error.${data.code}`)}</p>
        {onEdit && data.code !== 'failed' && (
          <Button size="sm" onClick={onEdit}>
            {t('tables.dashboards.editCard')}
          </Button>
        )}
      </div>
    );
  }
  const precision = precisionOf(card, table);
  switch (data.kind) {
    case 'number':
      return (
        <NumberFigure
          data={data}
          precision={precision}
          caption={
            (card.measure?.aggregate ?? 'count') === 'count'
              ? undefined
              : t('tables.grid.count', { count: data.records.toLocaleString() })
          }
        />
      );
    case 'groups':
      if (!data.groups.length && !data.other)
        return <p className="app-tb-dash-empty">{t('tables.dashboards.noData')}</p>;
      if (card.kind === 'line') return <LineChart data={data} label={label} precision={precision} />;
      if (card.kind === 'pie') return <PieChart data={data} label={label} precision={precision} />;
      return <BarList data={data} label={label} precision={precision} />;
    case 'list':
      if (!data.items.length) return <p className="app-tb-dash-empty">{t('tables.dashboards.noData')}</p>;
      return <RecordList data={data} card={card} baseId={baseId} table={table} label={label} />;
  }
}
