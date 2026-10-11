/**
 * KPI, chart and pivot cards: the embedded `TableCardSpec`, evaluated by the
 * gateway with the role's scope and the page's filters, drawn by the shared
 * `TableCardView` (the dashboard's renderer). Group keys that are people take
 * the names the page has seen; there is no drill-down for app viewers.
 */

import { useMemo } from 'react';
import { TableCardView, useCardLabels } from '../table-cards';
import { appTableFields, cardTitle, usersByIdOf, viewTable } from './model';
import type { AppCardRendererProps } from './types';

export function AppAggregateCard({ card, host, state }: AppCardRendererProps<'kpi' | 'chart' | 'pivot'>) {
  const table = viewTable(host.view, card.card.source?.tableId);
  const fields = useMemo(() => appTableFields(table), [table]);
  const usersById = useMemo(() => usersByIdOf(host.users), [host.users]);
  const labels = useCardLabels(fields, usersById);
  const result = state?.result;
  // Only aggregate answers (the frame draws `unavailable`; records pages and the external-data
  // answers belong to other cards).
  const answer =
    result &&
    (result.kind === 'kpi' || result.kind === 'chart' || result.kind === 'pivot' || result.kind === 'no_access')
      ? result
      : undefined;
  return (
    <TableCardView
      title={cardTitle(card, host.view)}
      card={card.card}
      result={answer}
      error={state?.error}
      fields={fields}
      labels={labels}
      onRetry={() => host.retry(card)}
    />
  );
}
