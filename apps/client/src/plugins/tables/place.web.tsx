import React, { useCallback, useEffect, useState, useRef } from 'react';
import { Icon } from '../../ui/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { listBases, getBase, getSchema, queryRecords, createBase, archiveBase, archiveTable } from '../../api/tables';
import { get } from '../../api/client';
import { useResource } from '../../data/use-resource';
import { displayValue, liveFields, recordTitle, cellValue } from '../../data/table-fields';
import { useFieldWords } from '../../tables/use-field-words';
import { PlaceSecondary } from '../../shell/place-secondary.web';
import { useOpenObject } from '../../shell/open-object';
import { Place, PlaceRow, PlaceSidebar, PlaceEmpty, PlaceContext, type PlaceContextPoint } from '../../ui/place.web';
import { useT } from '../../lib/i18n';
import { captureIdentity } from '../../data/identity';
import { promptText, alertError, confirmAction } from '../../ui/dialogs';
import TableGrid from './grid';
import type { TableRecord, TableDef } from '../../shared/greenhouse-types';
export default function TablesPlace() {
  const t = useT(),
    router = useRouter(),
    open = useOpenObject();
  const params = useLocalSearchParams<{ base?: string; table?: string }>();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [context, setContext] = useState<PlaceContextPoint | null>(null);
  const inspect = (id: string) => {
    setSelected(id);
    if (tableId) open({ kind: 'record', id, tableId, baseId: baseId ?? null });
  };
  const bases = useResource(useCallback(() => listBases(), []));
  const [tables, setTables] = useState<Record<string, TableDef[]>>({});
  const baseId = params.base ?? bases.data?.bases[0]?.id;
  const base = useResource(
    useCallback(() => (baseId ? getBase(baseId) : Promise.resolve({ ok: true as const, data: null })), [baseId]),
  );
  useEffect(() => {
    if (baseId && base.data) setTables((v) => ({ ...v, [baseId]: base.data!.tables }));
  }, [baseId, base.data]);
  const tableId = params.table ?? base.data?.tables[0]?.id;
  const schema = useResource(
    useCallback(() => (tableId ? getSchema(tableId) : Promise.resolve({ ok: true as const, data: null })), [tableId]),
  );
  const [view, setView] = useState('default');
  const views = useResource(
    useCallback(
      () =>
        tableId
          ? get<{
              views: { id: string; name: string; config?: { fieldIds?: string[]; query?: Record<string, unknown> } }[];
            }>(`/api/tables/tables/${encodeURIComponent(tableId)}/views`)
          : Promise.resolve({ ok: true as const, data: { views: [] } }),
      [tableId],
    ),
  );
  const viewConfig = views.data?.views.find((v) => v.id === view)?.config ?? {};
  const viewQuery = JSON.stringify(viewConfig.query ?? {});
  const generation = useRef(0),
    paging = useRef(false);
  const [records, setRecords] = useState<TableRecord[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    generation.current++;
    paging.current = false;
    setRecords([]);
    setCursor(null);
    setError('');
    if (!tableId) return;
    let alive = true;
    const current = captureIdentity();
    setLoading(true);
    void queryRecords(tableId, null, 50, JSON.parse(viewQuery)).then((r) => {
      if (!alive || !current()) return;
      setLoading(false);
      if (r.ok) {
        setRecords(r.data.records);
        setCursor(r.data.nextCursor);
      } else setError(r.message);
    });
    return () => {
      alive = false;
    };
  }, [tableId, viewQuery]);
  const more = async () => {
    if (!tableId || !cursor || loading || paging.current) return;
    const attempt = generation.current;
    paging.current = true;
    const current = captureIdentity();
    setLoading(true);
    const r = await queryRecords(tableId, cursor, 50, JSON.parse(viewQuery));
    if (!current() || attempt !== generation.current) return;
    paging.current = false;
    setLoading(false);
    if (r.ok) {
      setRecords((v) => [...v, ...r.data.records.filter((n) => !v.some((o) => o.id === n.id))]);
      setCursor(r.data.nextCursor);
    } else setError(r.message);
  };
  const allFields = liveFields(schema.data?.fields ?? []);
  const fields = viewConfig.fieldIds
    ? viewConfig.fieldIds.flatMap((id) => allFields.filter((f) => f.id === id))
    : allFields;
  const words = useFieldWords(fields);
  const addBase = async () => {
    const name = await promptText({ title: t('tables.newBase') });
    if (!name) return;
    const current = captureIdentity();
    const r = await createBase(name);
    if (!current()) return;
    if (!r.ok) {
      alertError(t('library.failed'), r.message);
      return;
    }
    void bases.refresh();
    router.setParams({ base: r.data.base.id, table: undefined });
  };
  const remove = async (target: { kind: 'base' | 'table'; id: string; name: string; baseId: string }) => {
    const ok = await confirmAction({
      title: t('tables.deleteConfirm', { name: target.name }),
      message: t('tables.deleteHint'),
      confirmLabel: t('library.delete'),
      destructive: true,
    });
    if (!ok) return;
    const current = captureIdentity();
    const r = target.kind === 'base' ? await archiveBase(target.id) : await archiveTable(target.id);
    if (!current()) return;
    if (!r.ok) {
      alertError(t('tables.deleteFailed'), r.message);
      return;
    }
    if (target.kind === 'base') {
      void bases.refresh();
      if (target.id === baseId) router.setParams({ base: undefined, table: undefined });
    } else {
      setTables((v) => ({ ...v, [target.baseId]: (v[target.baseId] ?? []).filter((x) => x.id !== target.id) }));
      if (target.id === tableId) router.setParams({ base: target.baseId, table: undefined });
      if (target.baseId === baseId) void base.refresh();
    }
  };
  const deleteItem = (title: string) => [{ id: 'delete', title, icon: 'trash' as const, destructive: true }];
  return (
    <>
      <PlaceSecondary>
        <PlaceSidebar
          title={t('nav.tables')}
          query={query}
          onQuery={setQuery}
          action={
            <button aria-label={t('tables.newBase')} onClick={() => void addBase()}>
              <Icon name="plus" size={18} />
            </button>
          }
        >
          <div data-place-list>
            {bases.data?.bases
              .filter((b) => !b.archived_at && (!query || b.name.toLowerCase().includes(query.toLowerCase())))
              .map((b) => (
                <div key={b.id}>
                  <PlaceRow
                    title={b.name}
                    icon="table"
                    selected={b.id === baseId}
                    onOpen={() => router.setParams({ base: b.id, table: undefined })}
                    items={b.role === 'owner' ? deleteItem(t('tables.deleteBase')) : []}
                    onSelect={() => void remove({ kind: 'base', id: b.id, name: b.name, baseId: b.id })}
                  />
                  <div style={{ paddingLeft: 20 }}>
                    {(tables[b.id] ?? []).map((table) => (
                      <PlaceRow
                        key={table.id}
                        title={table.name}
                        icon="table"
                        selected={table.id === tableId}
                        onOpen={() => router.setParams({ base: b.id, table: table.id })}
                        items={b.role === 'owner' ? deleteItem(t('tables.deleteTable')) : []}
                        onSelect={() => void remove({ kind: 'table', id: table.id, name: table.name, baseId: b.id })}
                      />
                    ))}
                  </div>
                </div>
              ))}
            {!bases.data?.bases.length ? (
              <PlaceEmpty loading={bases.loading} error={bases.error?.message} retry={() => void bases.refresh()} />
            ) : null}
          </div>
        </PlaceSidebar>
      </PlaceSecondary>
      <Place
        title={[base.data?.base.name, schema.data?.table.name].filter(Boolean).join(' › ')}
        actions={
          tableId && base.data?.role !== 'viewer' ? (
            <button
              className="gh-primary"
              onClick={() => router.push({ pathname: '/tables/new-record', params: { base: baseId, table: tableId } })}
            >
              {t('places.newRecord')}
            </button>
          ) : null
        }
      >
        <div className="gh-place-tabs" role="tablist">
          <button role="tab" aria-selected={view === 'default'} onClick={() => setView('default')}>
            {t('places.all')}
          </button>
          {views.data?.views.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}>
              {v.name}
            </button>
          ))}
        </div>
        <div
          className="gh-place-scroll"
          data-testid="tables-grid"
          onScroll={(e) => {
            if (e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 150)
              void more();
          }}
        >
          <TableGrid
            onContext={(id, x, y) => setContext({ id, x, y })}
            columns={fields.map((f) => ({ id: f.id, name: f.name, kind: f.type }))}
            rows={records.map((r) => ({
              id: r.id,
              title: recordTitle(allFields, r, words),
              cells: fields.map((f) => displayValue(f, cellValue(f, r), words)),
            }))}
            selected={selected}
            onOpen={inspect}
          />
          {cursor ? (
            <button onClick={() => void more()} disabled={loading}>
              {t('places.loadMore')}
            </button>
          ) : null}
          {!records.length ? (
            <PlaceEmpty
              loading={loading || schema.loading}
              error={error || schema.error?.message}
              retry={() => void schema.refresh()}
            />
          ) : null}
        </div>
      </Place>
      <PlaceContext
        point={context}
        close={() => setContext(null)}
        items={[{ label: t('client.openInspector'), run: () => context && inspect(context.id) }]}
      />
    </>
  );
}
