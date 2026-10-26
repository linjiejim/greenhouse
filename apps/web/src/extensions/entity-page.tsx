import React, { useEffect, useMemo, useState } from 'react';
import { localize, type PluginEntitySchema, type PluginManifestEntry } from '@greenhouse/types/plugins';
import {
  CrudPage,
  CrudDetail,
  CrudForm,
  defineCrud,
  type FieldDef,
  type ColumnDef,
  type CrudDataSource,
} from '../pages/settings/crud';
import { authFetch } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Spinner } from '../components/ui';

type Row = Record<string, unknown>;

export function entityDataSource(entity: PluginEntitySchema): CrudDataSource<Row> {
  const request = async (suffix: string, method = 'GET', body?: unknown) => {
    const response = await authFetch(`${entity.endpoint}${suffix}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  };
  const writable = new Set(entity.fields.filter((f) => f.writable).map((f) => f.key));
  const project = (data: Row) => Object.fromEntries(Object.entries(data).filter(([key]) => writable.has(key)));
  return {
    list: (params) =>
      request(
        `?${new URLSearchParams(
          Object.entries(params)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]),
        )}`,
      ),
    get: (id) => request(`/${encodeURIComponent(id)}`),
    ...(entity.actions.includes('create') ? { create: (data: Row) => request('', 'POST', project(data)) } : {}),
    ...(entity.actions.includes('update')
      ? { update: (id: string, data: Row) => request(`/${encodeURIComponent(id)}`, 'PATCH', project(data)) }
      : {}),
    ...(entity.actions.includes('delete')
      ? { remove: (id: string) => request(`/${encodeURIComponent(id)}`, 'DELETE') }
      : {}),
  };
}

export function EntityPage({
  plugin,
  entity,
  viewId,
  recordId,
}: {
  plugin: PluginManifestEntry;
  entity: PluginEntitySchema;
  viewId?: string;
  recordId?: string;
}) {
  const { locale, t } = useI18n();
  const [row, setRow] = useState<Row | null>(null),
    [editing, setEditing] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const schema = useMemo(() => {
    const view = entity.views.find((v) => v.id === viewId) ?? entity.views[0];
    const detail = plugin.pages.find((p) => p.kind === 'entity-detail' && p.entity === entity.id);
    const formFields: FieldDef<Row>[] = entity.fields
      .filter((f) => f.writable)
      .map<FieldDef<Row>>((f) => ({
        key: f.key,
        label: localize(f.title, locale),
        required: f.required,
        ...(f.kind === 'enum'
          ? { type: 'select' as const, options: (f.values ?? []).map((v) => ({ value: v, label: v })) }
          : {
              type:
                f.kind === 'boolean'
                  ? 'switch'
                  : ['number', 'integer', 'money'].includes(f.kind)
                    ? 'number'
                    : f.kind === 'longText'
                      ? 'textarea'
                      : f.kind === 'dateTime'
                        ? 'datetime'
                        : f.kind === 'date'
                          ? 'date'
                          : f.kind === 'json'
                            ? 'json'
                            : 'text',
            }),
      }));
    const columns: ColumnDef<Row>[] = entity.fields.map<ColumnDef<Row>>((f) => ({
      key: f.key,
      label: localize(f.title, locale),
      sortable: f.sortable,
      hidden: !view?.columns.includes(f.key),
      ...(f.key === entity.title_field && detail
        ? {
            type: 'custom' as const,
            render: (record: Row) => (
              <a
                className="text-primary-fg underline"
                href={`#/ext/${plugin.id}/${detail.id}/${encodeURIComponent(String(record.id))}`}
              >
                {String(record[f.key] ?? '')}
              </a>
            ),
          }
        : {
            type:
              f.kind === 'boolean'
                ? 'boolean'
                : ['integer', 'number', 'money'].includes(f.kind)
                  ? 'number'
                  : f.kind === 'dateTime'
                    ? 'datetime'
                    : f.kind === 'date'
                      ? 'date'
                      : 'text',
          }),
    }));
    return defineCrud<Row>({
      name: localize(entity.title, locale),
      testId: `ext-${plugin.id}-${entity.id}`,
      storageKey: `ext:${entity.id}`,
      dataSource: entityDataSource(entity),
      columns,
      formFields,
      defaultSort: view?.sort ? { key: view.sort.field, order: view.sort.dir } : undefined,
      filters: entity.fields
        .filter((f) => f.filterable && (!view?.filters || view.filters.includes(f.key)))
        .map((f) => ({
          key: f.key,
          label: localize(f.title, locale),
          kind: f.kind === 'enum' ? 'select' : f.kind === 'boolean' ? 'boolean' : 'text',
          options: f.values?.map((v) => ({ value: v, label: v })),
        })),
      access: {
        canView: true,
        canAdd: entity.actions.includes('create'),
        canEdit: entity.actions.includes('update'),
        canDelete: entity.actions.includes('delete'),
      },
    });
  }, [plugin, entity, viewId, locale]);
  useEffect(() => {
    let active = true;
    setRow(null);
    setError('');
    setEditing(false);
    if (recordId)
      schema.dataSource.get!(recordId)
        .then((value) => {
          if (active) setRow(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [recordId, schema, revision]);
  const close = () => {
    window.location.hash = `#/ext/${plugin.id}/${plugin.pages.find((p) => p.kind === 'entity-list' && p.entity === entity.id)?.id ?? ''}`;
  };
  return (
    <>
      <CrudPage key={revision} schema={schema} />
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {recordId && !row && !error && <Spinner />}
      {row && recordId && (
        <CrudDetail
          schema={schema}
          row={row}
          onClose={close}
          onEdit={schema.access.canEdit ? () => setEditing(true) : undefined}
        />
      )}
      {editing && row && (
        <CrudForm
          schema={schema}
          mode="edit"
          initial={row}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setRevision((n) => n + 1);
          }}
        />
      )}
      {recordId && !row && error && (
        <a
          href={`#/ext/${plugin.id}/${plugin.pages.find((p) => p.kind === 'entity-list' && p.entity === entity.id)?.id ?? ''}`}
        >
          {t('common.back')}
        </a>
      )}
    </>
  );
}
