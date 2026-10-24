/**
 * One record (`/tables/record?table=&id=`, or the detail pane on an iPad): every live field with its value as text (formula and
 * rollup results included). The last records opened are kept on the phone and read offline; a
 * record I cannot read any more (403 / 404) loses its copy. A masked record has no values.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { ApiResult } from '../api/client';
import { getRecord, getSchema, tableUsers } from '../api/tables';
import { noAccess, notFound } from '../data/access';
import { cellValue, displayValue, liveFields, recordTitle, recordUserNames } from '../data/table-fields';
import { parseSavedRecord, recordKind, type SavedRecord } from '../data/recent-items';
import { useOfflineResource } from '../data/use-offline-resource';
import { rememberRecord } from '../store/offline';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { useFieldWords } from '../tables/use-field-words';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { EmptyState, LoadingState } from '../ui/empty';
import { ListRow, ListSection } from '../ui/list';
import { ScreenChrome } from '../ui/split';

/** One record; `embedded` when it is the detail pane of the iPad split view (src/ui/split.tsx). */
export function RecordView({
  tableId,
  recordId,
  embedded,
}: {
  tableId: number | null;
  recordId: number | null;
  embedded?: boolean;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(async (): Promise<ApiResult<SavedRecord>> => {
    const [schema, record, users] = await Promise.all([
      getSchema(tableId ?? 0),
      getRecord(tableId ?? 0, recordId ?? 0),
      tableUsers(),
    ]);
    if (!schema.ok) return schema;
    if (!record.ok) return record;
    // the names of the people it names go with the offline copy, so they read offline too
    const names = users.ok ? recordUserNames(schema.data.fields, record.data.record, users.data.users) : {};
    return { ok: true, data: { schema: schema.data, record: record.data.record, users: names } };
  }, [tableId, recordId]);
  // the last records opened read offline too (src/data/recent-items.ts)
  const resource = useOfflineResource(
    tableId != null && recordId != null ? recordKind(tableId, recordId) : null,
    load,
    (saved) => (tableId != null && recordId != null ? parseSavedRecord(saved, tableId, recordId) : null),
  );
  const data = resource.data;
  useEffect(() => {
    if (tableId != null && recordId != null && data && !resource.offline) void rememberRecord(tableId, recordId);
  }, [tableId, recordId, data, resource.offline]);
  const fields = useMemo(() => (data ? liveFields(data.schema.fields) : []), [data]);
  const words = useFieldWords(fields, data?.users);

  if (tableId == null || recordId == null || (!data && !resource.loading && (notFound(resource.error) || noAccess(resource.error)))) {
    return (
      <View style={styles.root}>
        <ScreenChrome title={t('tables.record')} embedded={embedded} />
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          <EmptyState icon="table" title={t('tables.recordNotFound')} style={styles.state} />
        </ScrollView>
      </View>
    );
  }

  const masked = !!data && Object.keys(data.record.values ?? {}).length === 0;
  return (
    <View style={styles.root}>
      <ScreenChrome title={data?.schema.table.name ?? ''} embedded={embedded} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {!data ? (
          resource.loading ? (
            <LoadingState style={styles.state} />
          ) : (
            <EmptyState icon="alert" title={t('tables.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
          )
        ) : (
          <>
            <Text style={styles.title} accessibilityRole="header" selectable>
              {recordTitle(fields, data.record, words)}
            </Text>
            {resource.offline ? <Text style={styles.meta}>{t('common.savedCopy')}</Text> : null}
            <Text style={styles.meta}>{t('tables.updated', { when: relativeTimeNow(data.record.updated_at) })}</Text>
            <ListSection header={t('tables.fields')}>
              {fields.map((field) => {
                const text = masked ? t('tables.masked') : displayValue(field, cellValue(field, data.record), words);
                return <ListRow key={field.id} title={field.name} subtitle={text || '—'} subtitleLines={8} accessory="none" />;
              })}
            </ListSection>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  title: { ...typo.title2, fontWeight: weight.bold, color: c.label, marginHorizontal: space.margin + space.xs, marginTop: space.md },
  meta: { ...typo.footnote, color: c.secondaryLabel, marginHorizontal: space.margin + space.xs, marginBottom: space.sm },
}));
