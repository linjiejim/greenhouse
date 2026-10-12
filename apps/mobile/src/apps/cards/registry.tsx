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
import { ExternalCard } from './external';
import type { AppCardProps } from './types';

type CardRenderer = (props: AppCardProps) => React.ReactElement | null;

/** A kind this build does not draw: "open this card on the web". */
function WebOnlyCard(props: AppCardProps) {
  const t = useT();
  return (
    <CardFrame title={(props.card as { title?: string }).title}>
      <CardNote icon="open" text={t('apps.cardWebOnly')} hint={t('apps.cardWebOnlyHint')} />
    </CardFrame>
  );
}

/** Custom HTML stays disabled on every client until isolation is verified. */
function CustomUnavailableCard(props: AppCardProps) {
  const t = useT();
  return (
    <CardFrame title={(props.card as { title?: string }).title}>
      <CardNote icon="lock" text={t('apps.customUnavailable')} />
    </CardFrame>
  );
}

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
  custom: CustomUnavailableCard,
  external: ExternalCard,
} satisfies Record<AppCardKind, CardRenderer>;

export function AppCardView(props: AppCardProps) {
  const kind: string = props.card.kind;
  if (kind === 'custom') return <CustomUnavailableCard {...props} />;
  if (!isMobileCard(kind)) return <WebOnlyCard {...props} />;
  const Renderer: CardRenderer = APP_CARD_RENDERERS[kind];
  return (
    <CardBoundary framed title={(props.card as { title?: string }).title}>
      <Renderer {...props} />
    </CardBoundary>
  );
}
