/**
 * The kanban view: one lane per option of the view's single-select field (or
 * per person seen in its person field) plus "no value", on the shared `Lanes`
 * (src/ui/lanes.tsx). A card is the record's title, an optional cover and two
 * more fields; a tap opens it; a long-press menu moves it to another lane
 * ("Move To", the touch stand-in for the web's drag — a revision-checked
 * single-field update that replays over an automation's concurrent write), and
 * a lane's `+` creates a record already in that lane. Lanes the view hides stay
 * hidden; one page of at most 500 records (the server's cap) is shown, with a
 * note when there are more.
 */

import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { TableRecord } from '../../api/tables';
import type { TableViewConfig } from '../../shared/tables';
import { useT } from '../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { EmptyState, LoadingState } from '../../ui/empty';
import { useFontScaleKey } from '../../ui/font-scale';
import { Lanes, useLaneCardStyle, type LaneSpec } from '../../ui/lanes';
import { NativeMenu, menuSections, type MenuItem } from '../../ui/menu';
import { tablesFilePath } from '../../api/tables';
import { AuthImage } from '../auth-image';
import { RecordLines } from '../field-value';
import { attachmentIds, recordTitle, recordValue } from '../model/fields';
import { groupRecords, laneValue, VIEW_RECORD_LIMIT } from '../model/views';
import type { RecordsData, ViewContext } from './types';

export function KanbanView({
  ctx,
  data,
  config,
  onMove,
}: {
  ctx: ViewContext;
  data: RecordsData;
  config: NonNullable<TableViewConfig['kanban']> | undefined;
  /** Move a record to a lane (the group field's new value; null = no value). */
  onMove: (record: TableRecord, value: string | null) => void;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const groupField = config ? ctx.fields.find((field) => field.id === config.groupFieldId) : undefined;
  const coverField = config?.coverFieldId ? ctx.fields.find((field) => field.id === config.coverFieldId) : undefined;
  const canMove = !!groupField && ctx.abilities.editable.has(groupField.id);
  const rest = useMemo(
    () => ctx.shown.filter((field) => field.id !== ctx.primary?.id && field.id !== groupField?.id),
    [ctx.shown, ctx.primary, groupField],
  );

  const lanes = useMemo(() => {
    if (!groupField || !data.records) return [];
    return groupRecords(groupField, data.records, {
      userLabel: (id) => ctx.labels.user(id) ?? id,
      noValue: t('tables.noValue'),
      hidden: config?.hiddenGroups,
    });
  }, [groupField, data.records, ctx.labels, config?.hiddenGroups, t]);

  const specs = useMemo<LaneSpec<TableRecord>[]>(
    () =>
      lanes.map((lane) => ({
        key: lane.key,
        title: lane.label,
        color: lane.color && /^#[0-9a-f]{3,8}$/i.test(lane.color) ? lane.color : undefined,
        items: lane.records,
        ...(ctx.abilities.canCreate && canMove && groupField
          ? {
              onAdd: () => ctx.create(laneValue(lane.key) ? { [String(groupField.id)]: laneValue(lane.key) } : {}),
              addLabel: `${t('tables.newRecord')} · ${lane.label}`,
            }
          : {}),
      })),
    [lanes, ctx, canMove, groupField, t],
  );

  if (!groupField)
    return <EmptyState icon="board" title={t('tables.noKanbanField')} message={t('tables.openOnWebHint')} />;
  if (data.records === null) return <LoadingState />;
  if (data.failed && !data.records.length) {
    return <EmptyState icon="alert" title={t('tables.recordsFailed')} onRetry={() => void data.reload()} />;
  }

  const moveItems = (record: TableRecord): MenuItem[] => {
    const current = recordValue(record, groupField.id);
    const lanesItems: MenuItem[] = lanes.map((lane) => ({
      id: `move:${lane.key}`,
      title: lane.label,
      checked: (laneValue(lane.key) ?? null) === (typeof current === 'string' && current ? current : null),
    }));
    return menuSections([
      [{ id: 'open', title: t('apps.open'), icon: 'open' }],
      canMove ? [{ id: 'move', title: t('tables.moveTo'), icon: 'board', children: lanesItems }] : [],
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      {data.total > VIEW_RECORD_LIMIT ? (
        <Text style={styles.cap}>{t('tables.kanbanCap', { n: VIEW_RECORD_LIMIT })}</Text>
      ) : null}
      <Lanes
        lanes={specs}
        keyOf={(record) => String(record.id)}
        bottomInset={ctx.bottomInset}
        renderItem={(record) => (
          <KanbanCard
            record={record}
            ctx={ctx}
            rest={rest}
            coverPath={coverField ? coverPathOf(record, coverField.id) : null}
            items={moveItems(record)}
            onSelect={(id) => {
              if (id === 'open') ctx.open(record);
              else if (id.startsWith('move:')) onMove(record, laneValue(id.slice('move:'.length)));
            }}
          />
        )}
      />
    </View>
  );
}

function coverPathOf(record: TableRecord, fieldId: number): string | null {
  const id = attachmentIds(recordValue(record, fieldId))[0];
  return id ? tablesFilePath(id) : null;
}

function KanbanCard({
  record,
  ctx,
  rest,
  coverPath,
  items,
  onSelect,
}: {
  record: TableRecord;
  ctx: ViewContext;
  rest: ViewContext['fields'];
  coverPath: string | null;
  items: MenuItem[];
  onSelect: (id: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const cardStyle = useLaneCardStyle();
  const fontKey = useFontScaleKey();
  const title = recordTitle(record, ctx.fields, ctx.labels);
  return (
    <NativeMenu trigger="longPress" items={items} onSelect={onSelect}>
      <Pressable
        onPress={() => ctx.open(record)}
        accessibilityRole="button"
        accessibilityLabel={title}
        style={({ pressed }) => [cardStyle, pressed && { opacity: 0.7 }]}
      >
        {coverPath ? <AuthImage path={coverPath} style={styles.cover} /> : null}
        <Text key={fontKey} numberOfLines={3} style={styles.title}>
          {title}
        </Text>
        <RecordLines record={record} fields={rest} labels={ctx.labels} max={2} />
      </Pressable>
    </NativeMenu>
  );
}

const useStyles = makeStyles((c) => ({
  cap: {
    ...typo.footnote,
    color: c.secondaryLabel,
    paddingHorizontal: space.margin + space.xs,
    paddingBottom: space.sm,
  },
  cover: { height: 96, borderRadius: radius.md, ...squircle, marginBottom: space.xs },
  title: { ...typo.subheadline, fontWeight: weight.medium, color: c.label },
}));
