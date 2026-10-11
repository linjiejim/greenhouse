/**
 * One app card in its frame — the dashboard's `TableCardFrame` — whatever its
 * kind: the registry picks the renderer (`satisfies AppCardRenderers`, so a
 * new kind without one does not compile), every card has its own error
 * boundary, and the states every kind shares are drawn here once: broken by
 * a schema change (D6, `unavailable`), not readable by this role
 * (`no_access`), failed, loading. Labels the gateway resolved for ids
 * (relations, files) reach every `FieldValue` inside through
 * `FieldValueRefsProvider`.
 */

import { useMemo, type ComponentType } from 'react';
import type { AppCard } from '@greenhouse/types/apps';
import { TableCardFrame } from '../table-cards';
import { FieldValueRefsProvider, type FieldValueRefs } from '../tables/field-value';
import { Button, EmptyState, ErrorBoundary, Skeleton } from '../ui';
import { useT } from '../../lib/i18n';
import { AlertTriangle, Clock, Lock, Plus } from '../../lib/icons';
import { AppAggregateCard } from './aggregate-card';
import { AppButtonsCard } from './buttons-card';
import { AppFormCard } from './form-card';
import { cardIssue, cardTitle, isRecordsLikeCard } from './model';
import { AppRecordsCard } from './records-card';
import { recordsResult } from './records-data';
import { TextCard } from '../table-cards/text-card';
import type { AppCardRendererProps, AppCardRenderers } from './types';
import { AppViewCard } from './view-card';

function AppTextCard({ card }: AppCardRendererProps<'text'>) {
  return <TextCard markdown={card.markdown} />;
}

/**
 * Kinds this build does not draw yet — Phase 2's `custom` (slice S) and
 * `external` (slice SRC) until their renderers land. Never runs the card's
 * code or queries it (`isQueriedCard` leaves them out).
 */
function AppPendingCard() {
  const t = useT();
  return (
    <EmptyState
      icon={Clock}
      variant="compact"
      tone="neutral"
      title={t('apps.runtime.cards.pendingTitle')}
      description={t('apps.runtime.cards.pendingDescription')}
    />
  );
}

export const APP_CARD_RENDERERS = {
  records: AppRecordsCard,
  kanban: AppViewCard,
  calendar: AppViewCard,
  gallery: AppViewCard,
  form: AppFormCard,
  kpi: AppAggregateCard,
  chart: AppAggregateCard,
  pivot: AppAggregateCard,
  text: AppTextCard,
  buttons: AppButtonsCard,
  custom: AppPendingCard,
  external: AppPendingCard,
} satisfies AppCardRenderers;

function CardState({ card, host, state }: AppCardRendererProps) {
  const t = useT();
  const issue = cardIssue(host.view.issues, host.pageId, card.id);
  const result = state?.result;
  const manager = host.view.app.canManage;
  if (issue || result?.kind === 'unavailable') {
    const detail = issue?.message ?? (result?.kind === 'unavailable' ? result.message : undefined);
    return (
      <EmptyState
        icon={AlertTriangle}
        variant="compact"
        tone="neutral"
        title={t('apps.runtime.cards.unavailableTitle')}
        // The reason names fields and tables: it is for the people who can fix it.
        description={manager && detail ? detail : t('apps.runtime.cards.unavailableDescription')}
      />
    );
  }
  if (isRecordsLikeCard(card)) {
    if (result?.kind === 'no_access') {
      return (
        <EmptyState
          icon={Lock}
          variant="compact"
          tone="neutral"
          title={t('apps.runtime.cards.noAccessTitle')}
          description={t('apps.runtime.cards.noAccessDescription')}
        />
      );
    }
    if (state?.error && !result) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-danger">
          <p>{t('apps.runtime.cards.failed')}</p>
          <Button variant="ghost" size="sm" onClick={() => host.retry(card)}>
            {t('common.retry')}
          </Button>
        </div>
      );
    }
    if (!result) return <Skeleton className="h-full min-h-16 w-full" />;
  }
  const Renderer = APP_CARD_RENDERERS[card.kind] as ComponentType<AppCardRendererProps>;
  return <Renderer card={card} host={host} state={state} />;
}

export function AppCardView({ card, host, state }: AppCardRendererProps<AppCard['kind']>) {
  const t = useT();
  const title = cardTitle(card, host.view);
  const refs = recordsResult(state)?.refs;
  const labels = useMemo<FieldValueRefs>(
    () => ({ records: refs?.records, files: refs?.files, restrictedLabel: t('apps.runtime.cards.restricted') }),
    [refs, t],
  );
  const canCreate =
    card.kind === 'records' && card.create !== undefined && !cardIssue(host.view.issues, host.pageId, card.id);
  return (
    <TableCardFrame
      title={title}
      testId={`app-card-${card.id}`}
      actions={
        canCreate ? (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 gap-1 md:min-h-0"
            onClick={() => host.openCreate(card)}
            aria-label={t('apps.runtime.cards.newRecordIn', { title: title || t('apps.runtime.cards.untitledCard') })}
            data-testid={`app-card-${card.id}-new`}
          >
            <Plus size={13} aria-hidden="true" />
            {t('apps.runtime.cards.newRecord')}
          </Button>
        ) : undefined
      }
    >
      <ErrorBoundary
        fallback={
          <EmptyState
            icon={AlertTriangle}
            variant="compact"
            tone="danger"
            title={t('apps.runtime.cards.renderFailed')}
          />
        }
      >
        <FieldValueRefsProvider value={labels}>
          <CardState card={card} host={host} state={state} />
        </FieldValueRefsProvider>
      </ErrorBoundary>
    </TableCardFrame>
  );
}
