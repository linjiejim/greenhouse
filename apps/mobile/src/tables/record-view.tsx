/**
 * One record (the `sheet/record` object sheet): every live field with its value as text (formula and
 * rollup results included). The last records opened are kept on the phone and read offline; a
 * record I cannot read any more (403 / 404) loses its copy. A masked record has no values.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Text } from 'react-native';
import type { ApiResult } from '../api/client';
import { getRecord, getSchema, tableUsers } from '../api/tables';
import { noAccess, notFound } from '../data/access';
import { captureIdentity } from '../data/identity';
import {
  cellValue,
  displayValue,
  keptUserNames,
  liveFields,
  recordTitle,
  recordUserIds,
  recordUserNames,
} from '../data/table-fields';
import { parseSavedRecord, recordKind, type SavedRecord } from '../data/recent-items';
import { useOfflineResource } from '../data/use-offline-resource';
import { readOffline, rememberRecord } from '../store/offline';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { withTimeout } from '../lib/timeout';
import { useFieldWords } from '../tables/use-field-words';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { EmptyState, LoadingState } from '../ui/empty';
import { DetailField, DetailFields, DetailScroll } from '../ui/detail-fields';
import { SheetScreen } from '../ui/screen';

/** How long the member lookup for people's names may take before the record keeps the names it has. */
const NAMES_TIMEOUT_MS = 8000;

/** One record, as an object sheet (app/sheet/record.tsx). */
export function RecordView({ tableId, recordId }: { tableId: string | null; recordId: string | null }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const kind = tableId != null && recordId != null ? recordKind(tableId, recordId) : null;
  const load = useCallback(async (): Promise<ApiResult<SavedRecord>> => {
    const [schema, record] = await Promise.all([getSchema(tableId ?? '0'), getRecord(tableId ?? '0', recordId ?? '0')]);
    if (!schema.ok) return schema;
    if (!record.ok) return record;
    // names are not waited for (looked up below); the copy's names carry over so a new copy keeps them
    const saved =
      kind && tableId != null && recordId != null ? parseSavedRecord(await readOffline(kind), tableId, recordId) : null;
    const users = keptUserNames(recordUserIds(schema.data.fields, record.data.record), saved?.users ?? {});
    return { ok: true, data: { schema: schema.data, record: record.data.record, users } };
  }, [kind, tableId, recordId]);
  // the last records opened read offline too (src/data/recent-items.ts)
  const resource = useOfflineResource(kind, load, (saved) =>
    tableId != null && recordId != null ? parseSavedRecord(saved, tableId, recordId) : null,
  );
  const data = resource.data;
  useEffect(() => {
    if (tableId != null && recordId != null && data && !resource.offline) void rememberRecord(tableId, recordId);
  }, [tableId, recordId, data, resource.offline]);

  // The people's names are extra: the record shows at once and its user fields read as names when
  // the member lookup answers (within NAMES_TIMEOUT_MS); the names then go into the offline copy.
  const fresh = !resource.loading && !resource.error ? data : null;
  const lookedUp = useRef<SavedRecord['record'] | null>(null);
  const { setData } = resource;
  useEffect(() => {
    if (!fresh || lookedUp.current === fresh.record) return;
    if (recordUserIds(fresh.schema.fields, fresh.record).length === 0) return;
    lookedUp.current = fresh.record;
    let alive = true;
    const current = captureIdentity();
    void withTimeout(tableUsers(), NAMES_TIMEOUT_MS)
      .then((result) => {
        // no answer in time, or a miss: the names carried over stay
        if (!alive || !current() || !result?.ok) return;
        const users = { ...fresh.users, ...recordUserNames(fresh.schema.fields, fresh.record, result.data.users) };
        setData({ ...fresh, users });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fresh, setData]);
  const fields = useMemo(() => (data ? liveFields(data.schema.fields) : []), [data]);
  const words = useFieldWords(fields, data?.users);

  if (
    tableId == null ||
    recordId == null ||
    (!data && !resource.loading && (notFound(resource.error) || noAccess(resource.error)))
  ) {
    return (
      <>
        <SheetScreen title={t('tables.record')} />
        <DetailScroll style={styles.root} contentInsetAdjustmentBehavior="automatic">
          <EmptyState icon="table" title={t('tables.recordNotFound')} style={styles.state} />
        </DetailScroll>
      </>
    );
  }

  const masked = !!data && Object.keys(data.record.values ?? {}).length === 0;
  return (
    <>
      <SheetScreen title={data?.schema.table.name ?? ''} />
      <DetailScroll
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        {!data ? (
          resource.loading ? (
            <LoadingState style={styles.state} />
          ) : (
            <EmptyState
              icon="alert"
              title={t('tables.loadFailed')}
              onRetry={() => void resource.refresh()}
              style={styles.state}
            />
          )
        ) : (
          <>
            <Text style={styles.title} accessibilityRole="header" selectable>
              {recordTitle(fields, data.record, words)}
            </Text>
            {resource.offline ? <Text style={styles.meta}>{t('common.savedCopy')}</Text> : null}
            <Text style={styles.meta}>{t('tables.updated', { when: relativeTimeNow(data.record.updated_at) })}</Text>
            <DetailFields header={t('tables.fields')}>
              {fields.map((field) => {
                const text = masked ? t('tables.masked') : displayValue(field, cellValue(field, data.record), words);
                return <DetailField key={field.id} label={field.name} value={text || '—'} kind={field.type} />;
              })}
            </DetailFields>
          </>
        )}
      </DetailScroll>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  title: {
    ...typo.title2,
    fontWeight: weight.bold,
    color: c.label,
    marginHorizontal: space.margin + space.xs,
    marginTop: space.md,
  },
  meta: {
    ...typo.footnote,
    color: c.secondaryLabel,
    marginHorizontal: space.margin + space.xs,
    marginBottom: space.sm,
  },
}));
