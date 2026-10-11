/**
 * Tables record peek — the record drawer's own content (Fields + Activity
 * tabs, `RecordDetailContent`) in the peek frame, so a record link in Chat or
 * a notification opens the same view as the Tables page, without leaving.
 *
 * Read-only by design, like the knowledge peek: editing the record happens on
 * the full page ("open full page"), while commenting works here because the
 * Activity tab carries its own composer. Access is the server's: the schema,
 * the record and the activity all come through the governed routes, and a
 * record the viewer cannot read is "not found".
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getTableRecord, getTableSchema, listTableUsers } from '../../lib/api/tables';
import type { TableRecord, TableSchema, TableUserOption } from '../../lib/api/tables';
import { RecordDetailContent } from '../../pages/tables/record-drawer/record-detail-drawer';
import { Spinner } from '../ui';
import { useT } from '../../lib/i18n';

interface Loaded {
  schema: TableSchema;
  record: TableRecord;
  users: TableUserOption[];
}

export function TablesRecordPeek({ tableId, id }: { tableId: number; id: number }) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [schema, record, users] = await Promise.all([
      getTableSchema(tableId),
      getTableRecord(tableId, id),
      listTableUsers(),
    ]);
    return { schema, record, users: users.map(({ id: userId, nickname, email }) => ({ id: userId, nickname, email })) };
  }, [tableId, id]);

  useEffect(() => {
    let active = true;
    setLoaded(null);
    setFailed(false);
    load()
      .then((next) => {
        if (active) setLoaded(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const reloadRecord = useCallback(() => {
    void getTableRecord(tableId, id)
      .then((record) => setLoaded((current) => (current ? { ...current, record } : current)))
      .catch(() => setFailed(true));
  }, [tableId, id]);

  const usersById = useMemo(
    () => new Map((loaded?.users ?? []).map((user) => [user.id, user] as const)),
    [loaded?.users],
  );

  if (failed) return <div className="p-6 text-sm text-fg-muted">{t('entityPeek.notFound')}</div>;
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5 text-fg-faint" />
      </div>
    );
  }
  return (
    <RecordDetailContent
      table={loaded.schema.table}
      record={loaded.record}
      fields={loaded.schema.fields}
      users={loaded.users}
      usersById={usersById}
      canEdit={false}
      onEdit={() => undefined}
      onRecordChanged={reloadRecord}
    />
  );
}
