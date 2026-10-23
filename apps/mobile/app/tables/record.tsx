/**
 * One record (`/tables/record?table=&id=`): every live field with its value as text (formula and
 * rollup results included). A record I cannot read answers 404; a masked record has no values.
 */

import React, { useCallback, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { ApiResult } from '../../src/api/client';
import { getRecord, getSchema } from '../../src/api/tables';
import { noAccess, notFound } from '../../src/data/access';
import { cellValue, displayValue, liveFields, recordTitle } from '../../src/data/table-fields';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import type { TableRecord, TableSchema } from '../../src/shared/greenhouse-types';
import { useFieldWords } from '../../src/tables/use-field-words';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';

const num = (raw: string | undefined) => (raw && /^[0-9]+$/.test(raw) ? Number(raw) : null);

export default function RecordScreen() {
  const params = useLocalSearchParams<{ table?: string; id?: string }>();
  const tableId = num(params.table);
  const recordId = num(params.id);
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(async (): Promise<ApiResult<{ schema: TableSchema; record: TableRecord }>> => {
    const [schema, record] = await Promise.all([getSchema(tableId ?? 0), getRecord(tableId ?? 0, recordId ?? 0)]);
    if (!schema.ok) return schema;
    if (!record.ok) return record;
    return { ok: true, data: { schema: schema.data, record: record.data.record } };
  }, [tableId, recordId]);
  const resource = useResource(load);
  const data = resource.data;
  const fields = useMemo(() => (data ? liveFields(data.schema.fields) : []), [data]);
  const words = useFieldWords(fields);

  if (tableId == null || recordId == null || (!data && !resource.loading && (notFound(resource.error) || noAccess(resource.error)))) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('tables.record') }} />
        <EmptyState icon="table" title={t('tables.recordNotFound')} style={styles.state} />
      </View>
    );
  }

  const masked = !!data && Object.keys(data.record.values ?? {}).length === 0;
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: data?.schema.table.name ?? '' }} />
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
