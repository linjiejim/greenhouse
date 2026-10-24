/**
 * One table of 云盘 › 表格 (`/drive/table?base=&id=`): its records, newest first, a page at a time (cursor), each
 * titled by its primary field with the next two filled fields under it. Editors and up get + to
 * add a record (the quick-add sheet); the list reloads when the sheet closes. A record opens as a
 * sheet.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { ApiResult } from '../../../src/api/client';
import { getBase, getSchema, queryRecords } from '../../../src/api/tables';
import { noAccess, notFound } from '../../../src/data/access';
import { captureIdentity } from '../../../src/data/identity';
import { canAddRecords, cellValue, displayValue, liveFields, recordTitle } from '../../../src/data/table-fields';
import { useResource } from '../../../src/data/use-resource';
import { useT } from '../../../src/lib/i18n';
import type { TableRecord, TableRole, TableSchema } from '../../../src/shared/greenhouse-types';
import { useFieldWords } from '../../../src/tables/use-field-words';
import { makeStyles, space, useTheme } from '../../../src/theme';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { Row, SectionFooter, rowPosition } from '../../../src/ui/list';
import { useOpenObject } from '../../../src/shell/open-object';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';
import { objectId } from '../../../src/lib/object-id';

interface Head {
  schema: TableSchema;
  role: TableRole | null;
  records: TableRecord[];
  total: number;
  cursor: string | null;
}

export default function TableScreen() {
  const params = useLocalSearchParams<{ base?: string; id?: string }>();
  const baseId = objectId(params.base);
  const tableId = objectId(params.id);
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const openObject = useOpenObject();

  const load = useCallback(async (): Promise<ApiResult<Head>> => {
    const [schema, base, page] = await Promise.all([
      getSchema(tableId ?? '0'),
      baseId != null ? getBase(baseId) : Promise.resolve(null),
      queryRecords(tableId ?? '0', null),
    ]);
    if (!schema.ok) return schema;
    if (!page.ok) return page;
    return {
      ok: true,
      data: {
        schema: schema.data,
        role: base && base.ok ? base.data.role : null,
        records: page.data.records,
        total: page.data.total,
        cursor: page.data.nextCursor,
      },
    };
  }, [tableId, baseId]);
  const resource = useResource(load);
  const head = resource.data;

  // later pages, cleared whenever the first page is read again
  const [more, setMore] = useState<{ head: Head | null; records: TableRecord[]; cursor: string | null }>({
    head: null,
    records: [],
    cursor: null,
  });
  const extra = useMemo(
    () => (more.head === head ? more : { head, records: [] as TableRecord[], cursor: head?.cursor ?? null }),
    [more, head],
  );
  const loadingMore = useRef(false);
  const loadMore = useCallback(async () => {
    if (!head || tableId == null || !extra.cursor || loadingMore.current) return;
    loadingMore.current = true;
    const current = captureIdentity();
    const page = await queryRecords(tableId, extra.cursor);
    loadingMore.current = false;
    if (!current() || !page.ok) return;
    setMore({ head, records: [...extra.records, ...page.data.records], cursor: page.data.nextCursor });
  }, [head, tableId, extra]);

  const fields = useMemo(() => (head ? liveFields(head.schema.fields) : []), [head]);
  const words = useFieldWords(fields);
  const records = useMemo(() => {
    const seen = new Set<string>();
    return [...(head?.records ?? []), ...extra.records].filter((record) => !seen.has(record.id) && !!seen.add(record.id));
  }, [head, extra.records]);

  const subtitle = useCallback(
    (record: TableRecord) =>
      fields
        .filter((field) => !field.is_primary)
        .map((field) => {
          const text = displayValue(field, cellValue(field, record), words);
          return text ? `${field.name}: ${text}` : '';
        })
        .filter(Boolean)
        .slice(0, 2)
        .join(' · ') || undefined,
    [fields, words],
  );

  if (tableId == null || (!head && !resource.loading && (notFound(resource.error) || noAccess(resource.error)))) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('nav.tables') }} />
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          <EmptyState icon="table" title={noAccess(resource.error) ? t('tables.noAccess') : t('tables.notFound')} style={styles.state} />
        </ScrollView>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: head?.schema.table.name ?? '' }} />
      {head && canAddRecords(head.role) ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('plus')}
            accessibilityLabel={t('tables.addRecord')}
            onPress={() => router.push({ pathname: '/tables/new-record', params: { table: String(tableId) } })}
          />
        </Stack.Toolbar>
      ) : null}
      <FlatList<TableRecord>
        contentInsetAdjustmentBehavior="automatic"
        data={records}
        keyExtractor={(record) => String(record.id)}
        refreshing={resource.loading && !!head}
        onRefresh={() => void resource.refresh()}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        renderItem={({ item, index }) => (
          <Row
            title={recordTitle(fields, item, words)}
            subtitle={subtitle(item)}
            accessory="chevron"
            position={rowPosition(index, records.length)}
            onPress={() => openObject({ kind: 'record', baseId, tableId, id: item.id })}
          />
        )}
        ListHeaderComponent={
          head ? (
            <SectionFooter
              text={[t('tables.recordCount', { n: head.total }), canAddRecords(head.role) || !head.role ? '' : t('tables.viewerOnly')]
                .filter(Boolean)
                .join(' · ')}
            />
          ) : null
        }
        ListEmptyComponent={
          !head ? (
            resource.loading ? (
              <LoadingState style={styles.state} />
            ) : (
              <EmptyState icon="alert" title={t('tables.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
            )
          ) : (
            <EmptyState icon="table" title={t('tables.recordsEmpty')} style={styles.state} />
          )
        }
        style={styles.root}
        contentContainerStyle={styles.content}
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
}));
