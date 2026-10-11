/**
 * App card registry (spec 20261011-mobile-tables-apps §3): one native renderer
 * per card kind, `satisfies Record<AppCardKind, …>` so a new kind in the
 * vendored contract fails the type check until it is drawn here. Every card sits
 * in a `CardFrame` with an error boundary (a card that throws says so and leaves
 * the page standing); a kind this build does not know (an older OTA bundle
 * meeting a newer server) says "open this card on the web" instead of crashing.
 */

import React from 'react';
import type { AppCardKind } from '../../shared/apps';
import { useT } from '../../lib/i18n';
import { CardBoundary, CardFrame, CardNote } from '../../tables/cards/card-frame';
import { isMobileCard } from '../model';
import { CalendarCard, GalleryCard, KanbanCard, RecordsCard } from './records';
import { AggregateCard, ButtonsCard, FormCard, TextCard } from './simple';
import type { AppCardProps } from './types';

type CardRenderer = (props: AppCardProps) => React.ReactElement | null;

export const APP_CARD_RENDERERS = {
  records: RecordsCard,
  kanban: KanbanCard,
  calendar: CalendarCard,
  gallery: GalleryCard,
  form: FormCard,
  kpi: AggregateCard,
  chart: AggregateCard,
  pivot: AggregateCard,
  text: TextCard,
  buttons: ButtonsCard,
} satisfies Record<AppCardKind, CardRenderer>;

export function AppCardView(props: AppCardProps) {
  const t = useT();
  const kind: string = props.card.kind;
  if (!isMobileCard(kind)) {
    return (
      <CardFrame title={(props.card as { title?: string }).title}>
        <CardNote icon="open" text={t('apps.cardWebOnly')} hint={t('apps.cardWebOnlyHint')} />
      </CardFrame>
    );
  }
  const Renderer: CardRenderer = APP_CARD_RENDERERS[kind];
  return (
    <CardBoundary framed title={(props.card as { title?: string }).title}>
      <Renderer {...props} />
    </CardBoundary>
  );
}
