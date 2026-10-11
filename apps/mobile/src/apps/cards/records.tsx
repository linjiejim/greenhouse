/**
 * The records-like app cards (spec §3 "records（ListRow）、kanban（Lanes）、
 * calendar、gallery"), each reading its rows from the gateway for my role:
 *
 *  - records: rows titled by the primary field over the card's other fields,
 *    the first five, then "Show All (N)"; a card that may create shows "+";
 *  - kanban: the shared `Lanes` (one per option of the group field, + "no
 *    value"), cards with their actions on the face; a long-press moves the
 *    record to another lane when the card lets my role (`move`, `$move`) and
 *    my role may write the lane field;
 *  - calendar: the system date picker over the day's records (rows loaded so
 *    far, filtered by day on the phone — the gateway takes no date window);
 *  - gallery: two-up cover images through the gateway's file route.
 *
 * Every record row offers the actions the gateway says hold for it now
 * (`record.actionIds`), drawn like the chat blocks' buttons (`BlockActionsView`)
 * but run by the app's executor; a tap opens the record when the card has a
 * detail view.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { DatePicker, Host } from '@expo/ui/swift-ui';
import { datePickerStyle } from '@expo/ui/swift-ui/modifiers';
import { appFilePath } from '../../api/apps';
import type { AppCard, AppRecordAction, AppRecordRow } from '../../shared/apps';
import { BlockActionsView } from '../../chat/markdown/blocks/block-actions';
import { useLocale, useT } from '../../lib/i18n';
import { dateSubtitle, dateToStamp, stampToDate, todayStamp } from '../../projects/meta';
import { AuthImage } from '../../tables/auth-image';
import { CardFrame, CardNote } from '../../tables/cards/card-frame';
import { RecordLines, recordSummary } from '../../tables/field-value';
import { useValueLabels } from '../../tables/labels';
import { attachmentIds, primaryField, recordTitle, recordValue, type FieldLike } from '../../tables/model/fields';
import { groupRecords, laneValue, onDay } from '../../tables/model/views';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { NativeButton } from '../../ui/button';
import { LoadingState } from '../../ui/empty';
import { useFontScaleKey } from '../../ui/font-scale';
import { Lanes, useLaneCardStyle } from '../../ui/lanes';
import { ListRow } from '../../ui/list';
import { useLocaleEnv } from '../../ui/native-form';
import { NativeMenu, menuSections, type MenuItem } from '../../ui/menu';
import { canMove, forRole, recordActions, tableFields, type RecordsLikeCard } from '../model';
import { useCardQuery } from '../use-card';
import type { AppCardProps } from './types';

const FIRST_ROWS = 5;

/** A records-like card's rows, labels and fields. */
function useRows(props: AppCardProps & { card: RecordsLikeCard }) {
  const { appId, page, card, filterValues, previewRole, view } = props;
  const data = useCardQuery(appId, page.id, card.id, filterValues, { previewRole });
  const labels = useValueLabels({ refs: data.refs });
  const fields = tableFields(view, card.source.tableId) as FieldLike[];
  const byId = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const shown = useMemo(
    () => card.fieldIds.map((id) => byId.get(id)).filter((field): field is FieldLike => !!field),
    [card.fieldIds, byId],
  );
  const primary = primaryField(fields);
  const rest = shown.filter((field) => field.id !== primary?.id);
  return { data, labels, fields, byId, shown, primary, rest };
}

/** A row's actions as the chat blocks draw buttons; the app executor runs them. */
function RowActions({
  props,
  actions,
  record,
}: {
  props: AppCardProps;
  actions: AppRecordAction[];
  record: AppRecordRow;
}) {
  if (!actions.length) return null;
  return (
    <BlockActionsView
      actions={actions.map((action) => ({
        label: action.label,
        value: action.id,
        variant: action.do.type === 'delete' ? 'destructive' : 'secondary',
      }))}
      chosen={null}
      live
      choose={async (id) => {
        const action = actions.find((entry) => entry.id === id);
        if (action) await props.ui.actions.run({ pageId: props.page.id, card: props.card, action, record });
      }}
    />
  );
}

function stateNote(data: ReturnType<typeof useCardQuery>, t: ReturnType<typeof useT>): React.ReactElement | null {
  if (data.result === null && !data.failed) return <LoadingState style={{ flexGrow: 0, paddingVertical: space.md }} />;
  if (data.result === null) return <CardNote text={t('apps.cardFailed')} />;
  if (data.result.kind === 'unavailable')
    return <CardNote text={t('apps.cardUnavailable')} hint={data.result.message} />;
  if (data.result.kind === 'no_access') return <CardNote icon="lock" text={t('apps.cardNoAccess')} />;
  if (data.result.kind !== 'records') return <CardNote text={t('apps.cardUnavailable')} />;
  return null;
}

export function RecordsCard(props: AppCardProps) {
  const t = useT();
  const card = props.card as Extract<AppCard, { kind: 'records' }>;
  const { data, labels, fields, rest } = useRows({ ...props, card });
  const [expanded, setExpanded] = useState(false);
  const roleKey = props.view.role.key;
  const canCreate = !!card.create && forRole(card.create.roles, roleKey);
  const note = stateNote(data, t);
  const rows = expanded ? data.records : data.records.slice(0, FIRST_ROWS);
  const total = Math.max(data.total, data.records.length);
  return (
    <CardFrame
      title={card.title}
      action={
        canCreate ? (
          <NativeButton
            label={t('apps.newItem')}
            icon="plus"
            size="small"
            onPress={() => props.ui.openWrite(card, 'create')}
          />
        ) : undefined
      }
    >
      {note ??
        (rows.length === 0 ? (
          <CardNote icon="table" text={t('apps.noRecords')} />
        ) : (
          <View style={{ marginHorizontal: -space.md }}>
            {rows.map((record, index) => {
              const actions = recordActions(card.actions, record.actionIds);
              return (
                <ListRow
                  key={record.id}
                  title={recordTitle(record, fields, labels)}
                  subtitle={recordSummary(record, rest, labels) || undefined}
                  subtitleLines={1}
                  accessory={card.detail ? 'chevron' : 'none'}
                  last={index === rows.length - 1 && (expanded || total <= FIRST_ROWS)}
                  onPress={card.detail ? () => props.ui.openRecord(card, record) : undefined}
                  footer={actions.length ? <RowActions props={props} actions={actions} record={record} /> : undefined}
                />
              );
            })}
            {!expanded && total > FIRST_ROWS ? (
              <ListRow
                title={t('apps.more', { n: total })}
                last
                onPress={() => {
                  setExpanded(true);
                  if (data.hasMore) void data.more();
                }}
              />
            ) : expanded && data.hasMore ? (
              <ListRow title={t('tables.loadMore')} last onPress={() => void data.more()} />
            ) : null}
          </View>
        ))}
    </CardFrame>
  );
}

export function KanbanCard(props: AppCardProps) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const laneCard = useLaneCardStyle();
  const fontKey = useFontScaleKey();
  const card = props.card as Extract<AppCard, { kind: 'kanban' }>;
  const { data, labels, byId, rest } = useRows({ ...props, card });
  const group = byId.get(card.groupFieldId);
  const cover = card.coverFieldId ? byId.get(card.coverFieldId) : undefined;
  const movable = canMove(card, props.view);
  const note = stateNote(data, t);
  const lanes = useMemo(
    () =>
      group
        ? groupRecords(group, data.records, { userLabel: (id) => labels.user(id) ?? id, noValue: t('tables.noValue') })
        : [],
    [group, data.records, labels, t],
  );

  const menu = (record: AppRecordRow): MenuItem[] =>
    menuSections([
      card.detail ? [{ id: 'open', title: t('apps.open'), icon: 'open' }] : [],
      movable && group
        ? [
            {
              id: 'move',
              title: t('tables.moveTo'),
              icon: 'board',
              children: lanes.map((lane) => ({
                id: `move:${lane.key}`,
                title: lane.label,
                checked: (laneValue(lane.key) ?? null) === ((recordValue(record, group.id) as string | null) || null),
              })),
            },
          ]
        : [],
    ]);

  return (
    <CardFrame title={card.title}>
      {note ??
        (!group ? (
          <CardNote text={t('apps.cardUnavailable')} />
        ) : (
          <View style={{ height: 460, marginHorizontal: -space.md }}>
            <Lanes
              laneWidth={260}
              lanes={lanes.map((lane) => ({ key: lane.key, title: lane.label, items: lane.records }))}
              keyOf={(record) => String(record.id)}
              renderItem={(record) => {
                const actions = recordActions(card.actions, record.actionIds);
                const fileId = cover ? attachmentIds(recordValue(record, cover.id))[0] : undefined;
                const items = menu(record);
                const face = (
                  <Pressable
                    onPress={card.detail ? () => props.ui.openRecord(card, record) : undefined}
                    accessibilityRole={card.detail ? 'button' : undefined}
                    style={({ pressed }) => [laneCard, pressed && card.detail ? { opacity: 0.7 } : null]}
                  >
                    {fileId && cover ? (
                      <AuthImage
                        path={appFilePath(props.appId, fileId, {
                          pageId: props.page.id,
                          cardId: card.id,
                          recordId: record.id,
                          fieldId: cover.id,
                        })}
                        style={styles.cover}
                      />
                    ) : null}
                    <Text key={fontKey} numberOfLines={3} style={styles.title}>
                      {recordTitle(record, [...byId.values()], labels)}
                    </Text>
                    <RecordLines
                      record={record}
                      fields={rest.filter((field) => field.id !== group.id)}
                      labels={labels}
                      max={2}
                    />
                    <RowActions props={props} actions={actions} record={record} />
                  </Pressable>
                );
                return items.length ? (
                  <NativeMenu
                    trigger="longPress"
                    items={items}
                    onSelect={(id) => {
                      if (id === 'open') props.ui.openRecord(card, record);
                      else if (id.startsWith('move:')) {
                        void props.ui.actions.move({
                          pageId: props.page.id,
                          card,
                          record,
                          fieldId: group.id,
                          value: laneValue(id.slice('move:'.length)),
                        });
                      }
                    }}
                  >
                    {face}
                  </NativeMenu>
                ) : (
                  face
                );
              }}
            />
          </View>
        ))}
    </CardFrame>
  );
}

export function CalendarCard(props: AppCardProps) {
  const t = useT();
  const locale = useLocale();
  const localeEnv = useLocaleEnv();
  const { colors: c, isDark } = useTheme();
  const styles = useStyles(c);
  const card = props.card as Extract<AppCard, { kind: 'calendar' }>;
  const { data, labels, fields, byId, rest } = useRows({ ...props, card });
  const [day, setDay] = useState(todayStamp());
  const start = byId.get(card.startFieldId);
  const end = card.endFieldId ? byId.get(card.endFieldId) : undefined;
  const note = stateNote(data, t);
  const today = start ? data.records.filter((record) => onDay(record, start, end, day)) : [];
  return (
    <CardFrame title={card.title}>
      {note ??
        (!start ? (
          <CardNote text={t('apps.cardUnavailable')} />
        ) : (
          <>
            <Host matchContents={{ vertical: true }} colorScheme={isDark ? 'dark' : 'light'} modifiers={[localeEnv]}>
              <DatePicker
                selection={stampToDate(day)}
                displayedComponents={['date']}
                onDateChange={(date) => setDay(dateToStamp(date))}
                modifiers={[datePickerStyle('graphical')]}
              />
            </Host>
            <Text style={styles.day}>{dateSubtitle(day, locale, t('tables.today'))}</Text>
            {today.length === 0 ? (
              <CardNote icon="table" text={t('tables.agendaEmpty')} />
            ) : (
              <View style={{ marginHorizontal: -space.md }}>
                {today.map((record, index) => (
                  <ListRow
                    key={record.id}
                    title={recordTitle(record, fields, labels)}
                    subtitle={recordSummary(record, rest, labels) || undefined}
                    subtitleLines={1}
                    accessory={card.detail ? 'chevron' : 'none'}
                    last={index === today.length - 1}
                    onPress={card.detail ? () => props.ui.openRecord(card, record) : undefined}
                  />
                ))}
              </View>
            )}
            {data.hasMore ? (
              <NativeButton label={t('tables.loadMore')} size="small" onPress={() => void data.more()} />
            ) : null}
          </>
        ))}
    </CardFrame>
  );
}

export function GalleryCard(props: AppCardProps) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { width } = useWindowDimensions();
  const fontKey = useFontScaleKey();
  const card = props.card as Extract<AppCard, { kind: 'gallery' }>;
  const { data, labels, fields, byId, rest } = useRows({ ...props, card });
  const cover = card.coverFieldId ? byId.get(card.coverFieldId) : undefined;
  const note = stateNote(data, t);
  const tileW = Math.floor((width - space.margin * 2 - space.md * 2 - space.sm) / 2);
  return (
    <CardFrame title={card.title}>
      {note ??
        (data.records.length === 0 ? (
          <CardNote icon="table" text={t('apps.noRecords')} />
        ) : (
          <>
            <View style={styles.grid}>
              {data.records.map((record) => {
                const fileId = cover ? attachmentIds(recordValue(record, cover.id))[0] : undefined;
                const title = recordTitle(record, fields, labels);
                return (
                  <Pressable
                    key={record.id}
                    onPress={card.detail ? () => props.ui.openRecord(card, record) : undefined}
                    accessibilityRole={card.detail ? 'button' : undefined}
                    accessibilityLabel={title}
                    style={({ pressed }) => [
                      styles.tile,
                      { width: tileW },
                      pressed && card.detail ? { opacity: 0.7 } : null,
                    ]}
                  >
                    <AuthImage
                      path={
                        fileId && cover
                          ? appFilePath(props.appId, fileId, {
                              pageId: props.page.id,
                              cardId: card.id,
                              recordId: record.id,
                              fieldId: cover.id,
                            })
                          : null
                      }
                      style={{ height: Math.round(tileW * 0.75) }}
                    />
                    <View key={fontKey} style={styles.tileBody}>
                      <Text numberOfLines={2} style={styles.title}>
                        {title}
                      </Text>
                      <RecordLines record={record} fields={rest} labels={labels} max={1} />
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {data.hasMore ? (
              <NativeButton label={t('tables.loadMore')} size="small" onPress={() => void data.more()} />
            ) : null}
          </>
        ))}
    </CardFrame>
  );
}

const useStyles = makeStyles((c) => ({
  cover: { height: 88, borderRadius: radius.md, ...squircle, marginBottom: space.xs },
  title: { ...typo.subheadline, fontWeight: weight.medium, color: c.label },
  day: { ...typo.headline, color: c.label, paddingTop: space.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: { borderRadius: radius.lg, ...squircle, overflow: 'hidden', backgroundColor: c.tertiaryBackground },
  tileBody: { padding: space.sm, gap: 2 },
}));
