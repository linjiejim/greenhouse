/**
 * One evaluated card, whatever its kind: the host passes the card and its
 * server result (`TableCardResult`), this picks the renderer. Loading, failure
 * and "not available to you" are drawn here too, so every host (dashboard now,
 * app pages in Phase 1) shows them the same way.
 */

import type { TableCardPoint, TableCardResult } from '@greenhouse/types/table-cards';
import type { TableCardSpec } from '@greenhouse/types/tables';
import type { TableField, TableRecord, TableRecordPage } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { Lock } from '../../lib/icons';
import { Button, EmptyState, Skeleton } from '../ui';
import type { CardLabelContext } from './card-labels';
import { ChartCard } from './chart-card';
import { valueCaption } from './chart-model';
import { KpiCard } from './kpi-card';
import { PivotCard } from './pivot-card';
import { RecordsCard } from './records-card';
import { TextCard } from './text-card';

export interface TableCardViewProps {
  title: string;
  card: TableCardSpec | null;
  /** Undefined while loading. */
  result: TableCardResult<TableRecordPage> | undefined;
  error?: string | null;
  /** Fields of the card's table, as the viewer may read them. */
  fields: readonly TableField[];
  labels: CardLabelContext;
  onDrill?: (point: TableCardPoint, label: string) => void;
  onOpenRecord?: (record: TableRecord) => void;
  onRetry?: () => void;
}

export function TableCardView({
  title,
  card,
  result,
  error,
  fields,
  labels,
  onDrill,
  onOpenRecord,
  onRetry,
}: TableCardViewProps) {
  const t = useT();
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-danger">
        <p>{t('tables.dashboard.card.failed')}</p>
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    );
  }
  if (!result) return <Skeleton className="h-full min-h-16 w-full" />;
  if (result.kind === 'no_access' || !card) {
    return (
      <EmptyState
        icon={Lock}
        variant="compact"
        tone="neutral"
        title={t('tables.dashboard.card.noAccessTitle')}
        description={t('tables.dashboard.card.noAccess')}
      />
    );
  }
  switch (result.kind) {
    case 'text':
      return <TextCard markdown={result.markdown} />;
    case 'kpi':
      return (
        <KpiCard
          value={result.value}
          caption={valueCaption(card, labels)}
          onViewRecords={onDrill ? () => onDrill({ group: null }, title) : undefined}
        />
      );
    case 'chart':
      return <ChartCard card={card} rows={result.rows} labels={labels} title={title} onDrill={onDrill} />;
    case 'pivot':
      return <PivotCard card={card} rows={result.rows} labels={labels} onDrill={onDrill} />;
    case 'records':
      return (
        <RecordsCard
          records={result.page.records}
          fields={fields}
          fieldIds={card.fieldIds}
          systemFields={card.systemFields}
          usersById={labels.usersById}
          onOpenRecord={onOpenRecord}
        />
      );
  }
}
