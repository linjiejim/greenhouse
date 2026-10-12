/** Saved external cards use the app gateway and the viewer's own connection. */
import React from 'react';
import type { AppCard } from '../../shared/apps';
import { DataTableView } from '../../chat/markdown/blocks/datatable';
import { StatsView } from '../../chat/markdown/blocks/stats';
import { ConnectCard } from '../../connectors/connect-card';
import { useLocale, useT } from '../../lib/i18n';
import { ChartBody, useCardLabelContext } from '../../tables/cards/aggregate';
import { CardFrame, CardNote } from '../../tables/cards/card-frame';
import { formatCardNumber } from '../../tables/model/cards';
import { NativeButton } from '../../ui/button';
import { LoadingState } from '../../ui/empty';
import { space } from '../../theme';
import { useCardQuery } from '../use-card';
import { externalTableData } from '../model';
import type { AppCardProps } from './types';

const NO_PEOPLE = () => undefined;

export function ExternalCard(props: AppCardProps) {
  const t = useT();
  const locale = useLocale();
  const card = props.card as Extract<AppCard, { kind: 'external' }>;
  const data = useCardQuery(props.appId, props.page.id, card.id, props.filterValues, {
    previewRole: props.previewRole,
  });
  const ctx = useCardLabelContext([], NO_PEOPLE);
  const result = data.result;
  const retry = <NativeButton label={t('common.retry')} icon="refresh" onPress={() => void data.reload()} />;
  return (
    <CardFrame title={card.title}>
      {data.failed || result?.kind === 'source_error' ? (
        <>
          <CardNote
            text={t('apps.cardFailed')}
            hint={result?.kind === 'source_error' ? t(`apps.external.${result.reason}`) : undefined}
          />
          {retry}
        </>
      ) : result === null ? (
        <LoadingState style={{ flexGrow: 0, paddingVertical: space.md }} />
      ) : result.kind === 'needs_connection' ? (
        <ConnectCard
          data={result.connection}
          onReply={async () => {
            await data.reload();
            // Success replaces this card; if it still needs a connection, keep retry available.
            return false;
          }}
        />
      ) : result.kind === 'table' ? (
        <>
          <DataTableView data={externalTableData(result)} />
          {result.truncated ? <CardNote icon="table" text={t('apps.external.truncated')} /> : null}
        </>
      ) : result.kind === 'kpi' ? (
        <StatsView
          bare
          data={{
            items: [{ label: card.title || t('apps.external.value'), value: formatCardNumber(result.value, locale) }],
          }}
        />
      ) : result.kind === 'chart' ? (
        <ChartBody spec={{ kind: 'chart', chart: card.chart ?? { type: 'bar' } }} rows={result.rows} ctx={ctx} />
      ) : result.kind === 'no_access' ? (
        <CardNote icon="lock" text={t('apps.cardNoAccess')} />
      ) : (
        <CardNote text={t('apps.cardUnavailable')} />
      )}
    </CardFrame>
  );
}
