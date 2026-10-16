import { cellText } from '../tables/display';
import { useCallback, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { appCard } from '../api/apps';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { putHandoff } from '../lib/handoff';
import { openLink } from '../lib/links';
import { getApiBase } from '../store/stations';
import type { AppCard, AppRuntime, CardData, RecordPage, TableRecord } from '../shared/contract';
import { MAX_VIEW_RECORDS } from '../shared/contract';
import { groups } from '../tables/model';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { useFontScaleKey } from '../ui/font-scale';
import { NativeButton } from '../ui/button';
import { EmptyState, LoadingState } from '../ui/empty';
import { ListRow, ListSection } from '../ui/list';
import { alertError } from '../ui/dialogs';
import { Chart } from '../chat/markdown/blocks/chart';
import { appCardPath, cardFields, canAct, type AppCardContext } from './model';
import { useAppAction } from './use-action';

export function RuntimeCard({
  runtime,
  card,
  names,
}: {
  runtime: AppRuntime;
  card: AppCard;
  names: Record<string, string>;
}) {
  const t = useT();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles(colors);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const r = useResource(
    useCallback(
      () =>
        card.kind === 'custom' || card.kind === 'external' || card.kind === 'button' || card.kind === 'form'
          ? Promise.resolve({ ok: true as const, data: { kind: 'empty' as const } })
          : appCard(runtime.app.id, runtime.version, card.id),
      [runtime.app.id, runtime.version, card.id, card.kind],
    ),
    ['records.changed', 'base.updated'],
  );
  const action = useAppAction(
    runtime,
    'table_id' in card ? card : { id: card.id, table_id: '' },
    () => void r.refresh(),
  );
  const open = (record?: string) => {
    if (!('fields' in card)) return;
    const k = putHandoff<AppCardContext>('app-card', { runtime, card, record });
    router.push({ pathname: '/apps/card', params: { k } });
  };
  const more = async () => {
    if (r.data?.kind !== 'records' || !r.data.data.next_cursor || pending.current) return;
    const current = r.capture();
    pending.current = true;
    setBusy(true);
    const result = await appCard(runtime.app.id, runtime.version, card.id, r.data.data.next_cursor);
    pending.current = false;
    setBusy(false);
    if (!current()) return;
    if (result.ok && result.data.kind === 'records') {
      const page = result.data.data;
      r.setData((old) =>
        old?.kind === 'records'
          ? {
              kind: 'records',
              data: {
                ...page,
                items: [
                  ...old.data.items,
                  ...page.items.filter((i) => !old.data.items.some((j) => j.id === i.id)),
                ].slice(0, MAX_VIEW_RECORDS),
                linked: { ...old.data.linked, ...page.linked },
                files: { ...old.data.files, ...page.files },
              },
            }
          : old,
      );
    } else if (!result.ok)
      alertError(
        t(result.code === 'stale_version' ? 'integration.appChanged' : 'work.loadFailed'),
        undefined,
        result.message,
      );
  };
  if (card.kind === 'custom' || card.kind === 'external')
    return (
      <ListSection header={card.title}>
        <ListRow
          title={t('integration.customWeb')}
          icon="open"
          accessory="chevron"
          onPress={() => void openLink(`${getApiBase()}${appCardPath(runtime, card.id)}`)}
        />
      </ListSection>
    );
  if (card.kind === 'button')
    return (
      <ListSection header={card.title}>
        <View style={styles.action}>
          <NativeButton
            label={card.action.name}
            disabled={!canAct(runtime, card.table_id)}
            loading={action.busy}
            onPress={() => void action.execute(card.action)}
          />
        </View>
      </ListSection>
    );
  if (card.kind === 'form')
    return (
      <ListSection header={card.title}>
        <ListRow
          title={t('work.form')}
          icon="form"
          accessory="chevron"
          disabled={!canAct(runtime, card.table_id)}
          onPress={() => open()}
        />
      </ListSection>
    );
  if (r.error)
    return (
      <ListSection header={card.title}>
        <EmptyState
          icon="alert"
          title={t(r.error.code === 'stale_version' ? 'integration.appChanged' : 'work.loadFailed')}
          onRetry={() => void r.refresh()}
        />
      </ListSection>
    );
  if (!r.data)
    return (
      <ListSection header={card.title}>
        <LoadingState />
      </ListSection>
    );
  if (r.data.kind === 'chart') return <CardFigures runtime={runtime} card={card} data={r.data.data} />;
  if (r.data.kind !== 'records' || !('fields' in card)) return null;
  const page = r.data.data;
  const fields = cardFields(runtime, card);
  const primary = fields.find((f) => f.is_primary);
  const row = (record: TableRecord) => (
    <ListRow
      key={record.id}
      title={(primary && cellText(primary, record.values[primary.id], page, names)) || t('work.record')}
      subtitle={fields
        .filter((f) => !f.is_primary)
        .map((f) => `${f.name}: ${cellText(f, record.values[f.id], page, names) || '—'}`)
        .join(' · ')}
      accessory="chevron"
      onPress={() => open(record.id)}
    />
  );
  const groupField = runtime.base.tables
    .find((table) => table.id === card.table_id)
    ?.fields.find((f) => f.id === card.group_field);
  return (
    <>
      {card.kind === 'kanban' && page.items.length ? (
        groups(page.items, card.group_field).map((g) => (
          <ListSection
            key={g.key}
            header={`${card.title} · ${(groupField && cellText(groupField, g.key, page, names)) || t('work.emptyValue')}`}
          >
            {g.items.map(row)}
          </ListSection>
        ))
      ) : (
        <ListSection header={card.title}>
          {page.items.length ? page.items.map(row) : <EmptyState icon="table" title={t('integration.noData')} />}
        </ListSection>
      )}
      {page.next_cursor && page.items.length < MAX_VIEW_RECORDS ? (
        <NativeButton label={t('work.more')} loading={busy} onPress={() => void more()} />
      ) : null}
    </>
  );
}

function CardFigures({ runtime, card, data }: { runtime: AppRuntime; card: AppCard; data: CardData }) {
  const t = useT();
  const fontKey = useFontScaleKey();
  const { colors } = useTheme();
  const styles = useStyles(colors);
  if (data.kind === 'number')
    return (
      <ListSection header={card.title}>
        <Text key={fontKey} style={styles.figure} accessibilityLabel={`${card.title}: ${data.value ?? '—'}`}>
          {data.value?.toLocaleString() ?? '—'}
        </Text>
      </ListSection>
    );
  if (data.kind === 'error')
    return (
      <ListSection header={card.title}>
        <EmptyState icon="alert" title={t('work.loadFailed')} />
      </ListSection>
    );
  if (data.kind === 'list') {
    const fields =
      runtime.base.tables.find((table) => table.id === ('table_id' in card ? card.table_id : ''))?.fields ?? [];
    const primary = fields.find((f) => f.id === data.title_field);
    return (
      <ListSection header={card.title}>
        {data.items.length ? (
          data.items.map((record) => (
            <ListRow
              key={record.id}
              title={
                (primary &&
                  cellText(primary, record.values[primary.id], data as Pick<RecordPage, 'files' | 'linked'>)) ||
                t('work.record')
              }
              subtitle={data.fields
                .flatMap((id) => {
                  const f = fields.find((f) => f.id === id);
                  return f ? `${f.name}: ${cellText(f, record.values[id], data)}` : [];
                })
                .join(' · ')}
            />
          ))
        ) : (
          <EmptyState icon="table" title={t('integration.noData')} />
        )}
      </ListSection>
    );
  }
  const values = [
    ...data.groups.map((g) => ({
      label:
        g.label ||
        (data.key_type === 'checkbox'
          ? t(g.key === 'true' ? 'common.yes' : 'common.no')
          : g.key || t('work.emptyValue')),
      value: g.value,
    })),
    ...(data.other ? [{ label: t('common.more'), value: data.other.value }] : []),
  ];
  return (
    <View style={styles.chart}>
      {values.length ? (
        <Chart
          spec={JSON.stringify({
            type: card.kind === 'line' ? 'line' : card.kind === 'pie' ? 'pie' : 'bar',
            title: card.title,
            labels: values.map((g) => g.label),
            datasets: [{ label: card.title, data: values.map((g) => g.value ?? 0) }],
          })}
        />
      ) : (
        <EmptyState icon="bar" title={t('integration.noData')} />
      )}
    </View>
  );
}
const useStyles = makeStyles((c) => ({
  action: { padding: space.md },
  figure: { ...typo.largeTitle, fontWeight: weight.semibold, color: c.label, padding: space.margin },
  chart: { marginHorizontal: space.margin },
}));
