/**
 * The other app cards: a form (its title and a "Fill In" button — the form
 * itself is the write sheet, with photos for attachment fields), the aggregates
 * (KPI / chart / pivot through the dashboards' card bodies — the chat `stats`
 * and chart views), Markdown text, and buttons (open a page, open a link in the
 * in-app browser, start a new record). A form or button limited to other roles
 * is not shown to mine.
 */

import React from 'react';
import { View } from 'react-native';
import type { AppCard } from '../../shared/apps';
import { useT } from '../../lib/i18n';
import { ChartBody, KpiBody, PivotBody, TextBody, useCardLabelContext } from '../../tables/cards/aggregate';
import { CardFrame, CardNote } from '../../tables/cards/card-frame';
import type { FieldLike } from '../../tables/model/fields';
import { space } from '../../theme';
import { NativeButton } from '../../ui/button';
import { LoadingState } from '../../ui/empty';
import { cardTableId, forRole, tableFields } from '../model';
import { useCardQuery } from '../use-card';
import type { AppCardProps } from './types';

/** Aggregate rows carry raw keys only; an app viewer has no user directory to name people with. */
const NO_PEOPLE = () => undefined;

export function FormCard(props: AppCardProps) {
  const t = useT();
  const card = props.card as Extract<AppCard, { kind: 'form' }>;
  if (!forRole(card.roles, props.view.role.key)) return null;
  return (
    <CardFrame title={card.title}>
      <NativeButton
        label={card.submitLabel || t('apps.fillForm')}
        icon="form"
        variant="prominent"
        fullWidth
        onPress={() => props.ui.openWrite(card, 'submit')}
      />
    </CardFrame>
  );
}

export function AggregateCard(props: AppCardProps) {
  const t = useT();
  const card = props.card as Extract<AppCard, { kind: 'kpi' | 'chart' | 'pivot' }>;
  const data = useCardQuery(props.appId, props.page.id, card.id, props.filterValues, {
    previewRole: props.previewRole,
  });
  const fields = tableFields(props.view, cardTableId(card)) as FieldLike[];
  const ctx = useCardLabelContext(fields, NO_PEOPLE);
  const result = data.result;
  return (
    <CardFrame title={card.title}>
      {result === null ? (
        data.failed ? (
          <CardNote text={t('apps.cardFailed')} />
        ) : (
          <LoadingState style={{ flexGrow: 0, paddingVertical: space.md }} />
        )
      ) : result.kind === 'unavailable' ? (
        <CardNote text={t('apps.cardUnavailable')} hint={result.message} />
      ) : result.kind === 'no_access' ? (
        <CardNote icon="lock" text={t('apps.cardNoAccess')} />
      ) : result.kind === 'kpi' ? (
        <KpiBody spec={card.card} value={result.value} ctx={ctx} />
      ) : result.kind === 'chart' || result.kind === 'pivot' ? (
        card.kind === 'pivot' ? (
          <PivotBody spec={card.card} rows={result.rows} ctx={ctx} />
        ) : (
          <ChartBody spec={card.card} rows={result.rows} ctx={ctx} />
        )
      ) : result.kind === 'text' ? (
        <TextBody markdown={result.markdown} />
      ) : (
        <CardNote text={t('apps.cardUnavailable')} />
      )}
    </CardFrame>
  );
}

export function TextCard(props: AppCardProps) {
  const card = props.card as Extract<AppCard, { kind: 'text' }>;
  return (
    <CardFrame title={card.title}>
      <TextBody markdown={card.markdown} />
    </CardFrame>
  );
}

export function ButtonsCard(props: AppCardProps) {
  const card = props.card as Extract<AppCard, { kind: 'buttons' }>;
  const buttons = card.buttons.filter((button) => forRole(button.roles, props.view.role.key));
  if (!buttons.length) return null;
  return (
    <CardFrame title={card.title}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {buttons.map((button) => (
          <NativeButton
            key={button.id}
            label={button.label}
            icon={button.type === 'open_url' ? 'open' : button.type === 'create_record' ? 'plus' : 'chevR'}
            onPress={() => {
              if (button.type === 'open_page') props.ui.openPage(button.pageId);
              else if (button.type === 'open_url') props.ui.openUrl(button.url);
              else props.ui.openWrite(card, 'button', { buttonId: button.id });
            }}
          />
        ))}
      </View>
    </CardFrame>
  );
}
