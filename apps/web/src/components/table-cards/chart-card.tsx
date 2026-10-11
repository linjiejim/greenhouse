/**
 * Chart card: bar / line / area / pie (stacked, horizontal, donut, value
 * labels) over a card's aggregate rows. Clicking a mark drills into the records
 * behind it; the same targets are offered as buttons for keyboard and screen
 * reader users, because a canvas mark is neither focusable nor announced.
 */

import { useMemo } from 'react';
import type { TableCardPoint } from '@greenhouse/types/table-cards';
import type { TableAggregateRow, TableCardSpec } from '@greenhouse/types/tables';
import { ChartBlock } from '../blocks/chart-block';
import { Button } from '../ui';
import { useT } from '../../lib/i18n';
import type { CardLabelContext } from './card-labels';
import { buildChartModel } from './chart-model';

export function ChartCard({
  card,
  rows,
  labels,
  title,
  onDrill,
}: {
  card: TableCardSpec;
  rows: TableAggregateRow[];
  labels: CardLabelContext;
  title: string;
  onDrill?: (point: TableCardPoint, label: string) => void;
}) {
  const t = useT();
  const model = useMemo(() => buildChartModel(card, rows, labels), [card, rows, labels]);

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-faint">
        {t('tables.dashboard.card.noData')}
      </div>
    );
  }

  const targets = onDrill
    ? model.points.flatMap((points, datasetIndex) =>
        points.flatMap((point, index) =>
          point ? [{ point, label: model.pointLabels[datasetIndex]![index]!, key: `${datasetIndex}:${index}` }] : [],
        ),
      )
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ChartBlock
          data={model.data}
          display={model.display}
          fill
          compact
          ariaLabel={title}
          onPointClick={
            onDrill
              ? ({ datasetIndex, index }) => {
                  const point = model.points[datasetIndex]?.[index];
                  if (point) onDrill(point, model.pointLabels[datasetIndex]![index]!);
                }
              : undefined
          }
        />
      </div>
      {targets.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('tables.dashboard.card.viewRecords')}>
          {targets.map((target) => (
            <Button
              key={target.key}
              variant="ghost"
              size="sm"
              className="sr-only focus:not-sr-only"
              onClick={() => onDrill?.(target.point, target.label)}
            >
              {t('tables.dashboard.card.showRecordsFor', { label: target.label })}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
