import React, { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useEntityList } from './entity-hooks';
import { Select } from '../ui/select.web';
import { FieldValue, FieldTypeIcon } from '../ui/field-value.web';
import { entityColumns, fieldText } from './surface-model';
import { localize, type PluginEntitySchema, type PluginEntityListPage } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { useAuth } from '../store/auth';
import { usePeopleNames } from '../store/people';
import { peopleIds } from '../data/people';
import { useT } from '../lib/i18n';
import { useOpenObject } from '../shell/open-object';
import { Place, PlaceEmpty, PlaceContext, type PlaceContextPoint } from '../ui/place.web';
import { Icon } from '../ui/core';
import { EntityCreate } from './entity-create.web';
export { EntityDetail } from './entity-components';
export function EntityList({
  entity,
  page,
  plugin,
  detailPage,
}: {
  entity: PluginEntitySchema;
  page: PluginEntityListPage;
  plugin: string;
  detailPage: string;
}) {
  const t = useT(),
    lang = usePrefs((s) => s.lang),
    open = useOpenObject();
  // Filters and sort live in the address (`?f.status=open&sort=amount:desc`): a filtered view
  // reloads, shares and comes back with the browser's Back.
  const params = useLocalSearchParams<Record<string, string>>(),
    router = useRouter();
  const filters = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(params)
          .filter(([key, value]) => key.startsWith('f.') && typeof value === 'string' && value)
          .map(([key, value]) => [key.slice(2), value]),
      ) as Record<string, string>,
    [params],
  );
  const sort = useMemo(() => {
    const [field, dir] = (typeof params.sort === 'string' ? params.sort : '').split(':');
    return field && (dir === 'asc' || dir === 'desc') ? { field, dir: dir as 'asc' | 'desc' } : undefined;
  }, [params.sort]);
  const setFilter = (key: string, value: string) => router.setParams({ [`f.${key}`]: value || undefined });
  const setSort = (next: { field: string; dir: 'asc' | 'desc' } | undefined) =>
    router.setParams({ sort: next ? `${next.field}:${next.dir}` : undefined });
  const view = entity.views.find((v) => v.id === (page.view ?? 'default')) ?? entity.views[0],
    fields = entityColumns(entity, view);
  const [context, setContext] = useState<PlaceContextPoint | null>(null);
  const list = useEntityList(entity, view, filters, sort);
  const me = useAuth((s) => s.user);
  const names = usePeopleNames(peopleIds(entity.fields, list.items));
  useEffect(() => {
    const refresh = () => {
      void list.refresh();
    };
    window.addEventListener('greenhouse:refresh', refresh);
    return () => window.removeEventListener('greenhouse:refresh', refresh);
  });
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const canCreate = entity.actions.includes('create') && entity.fields.some((f) => f.writable === true);
  const filtered = Object.values(filters).some(Boolean);
  const inspect = (id: string) => {
    setSelected(id);
    open({ kind: 'plugin-entity', plugin, page: detailPage, id, entity: entity.id });
  };
  return (
    <>
      <Place
        title={`${localize(page.title, lang)} · ${list.total}`}
        actions={
          <>
            <button onClick={() => void list.refresh()} disabled={list.loading} aria-label={t('common.refresh')}>
              <Icon name="refresh" size={16} />
            </button>
            {canCreate ? (
              <button className="gh-primary" onClick={() => setCreating(true)} data-testid="entity-new">
                {t('places.newRecord')}
              </button>
            ) : null}
          </>
        }
      >
        <div className="gh-place-tabs">
          {(view?.filters ?? []).map((key) => {
            const f = entity.fields.find((f) => f.key === key && f.filterable);
            if (!f) return null;
            const label = localize(f.title, lang);
            return (
              <div className="gh-filter" key={key}>
                {f.kind === 'enum' || f.kind === 'boolean' || f.kind === 'user' ? (
                  <Select clearable aria-label={label} value={filters[key] ?? ''} onChange={(e) => setFilter(key, e.target.value)}>
                    <option value="">{label}</option>
                    {(f.kind === 'boolean'
                      ? ['true', 'false']
                      : f.kind === 'user'
                        ? memberChoices(me?.id, peopleIds([f], list.items), filters[key])
                        : (f.values ?? [])
                    ).map((value) => (
                      <option key={value} value={value}>
                        {f.kind === 'user' && value === me?.id
                          ? t('places.me')
                          : fieldText(f, f.kind === 'boolean' ? value === 'true' : value, lang, names)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <input
                    className="gh-input"
                    aria-label={label}
                    placeholder={label}
                    value={filters[key] ?? ''}
                    onChange={(e) => setFilter(key, e.target.value)}
                  />
                )}
              </div>
            );
          })}
          <div className="gh-filter">
            <Select
              clearable
              aria-label={t('places.sort')}
              value={sort ? `${sort.field}:${sort.dir}` : ''}
              onChange={(e) => {
                const [field, dir] = e.target.value.split(':');
                setSort(field ? { field, dir: dir as 'asc' | 'desc' } : undefined);
              }}
            >
              <option value="">{t('places.sort')}</option>
              {fields
                .filter((f) => f.sortable)
                .flatMap((f) =>
                  (['asc', 'desc'] as const).map((dir) => (
                    <option key={`${f.key}:${dir}`} value={`${f.key}:${dir}`}>
                      {`${localize(f.title, lang)} ${dir === 'asc' ? '↑' : '↓'}`}
                    </option>
                  )),
                )}
            </Select>
          </div>
        </div>
        <div
          className="gh-place-scroll"
          data-testid="plugin-entity-list"
          onScroll={(e) => {
            if (e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 120)
              list.more();
          }}
        >
          <table className="gh-data-grid gh-entity-grid">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.key} className={['integer', 'number', 'money'].includes(f.kind) ? 'gh-number' : undefined}>
                    <span className="gh-field-heading">
                      <FieldTypeIcon kind={f.kind} />
                      {localize(f.title, lang)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.items.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  aria-selected={selected === String(row.id)}
                  aria-label={String(row[entity.title_field] ?? row.id)}
                  onClick={() => inspect(String(row.id))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContext({ id: String(row.id), x: e.clientX, y: e.clientY });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      inspect(String(row.id));
                    }
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const next =
                        e.key === 'ArrowDown'
                          ? e.currentTarget.nextElementSibling
                          : e.currentTarget.previousElementSibling;
                      (next as HTMLElement)?.focus();
                    }
                  }}
                >
                  {fields.map((f) => (
                    <td
                      key={f.key}
                      className={['integer', 'number', 'money'].includes(f.kind) ? 'gh-number' : undefined}
                    >
                      <FieldValue kind={f.kind} text={fieldText(f, row[f.key], lang, names)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {list.items.length < list.total ? (
            <button disabled={list.loading} onClick={list.more}>
              {t('places.loadMore')}
            </button>
          ) : null}
          {!list.items.length ? (
            <PlaceEmpty
              loading={list.loading}
              error={list.error}
              retry={() => void list.refresh()}
              {...(!filtered
                ? {
                    icon: 'apps' as const,
                    title: t('client.noItems'),
                    action: canCreate ? (
                      <button className="gh-primary" onClick={() => setCreating(true)}>
                        {t('places.newRecord')}
                      </button>
                    ) : undefined,
                  }
                : {})}
            />
          ) : null}
        </div>
      </Place>
      {creating ? (
        <EntityCreate
          entity={entity}
          close={() => setCreating(false)}
          created={(id) => {
            void list.refresh();
            if (id) inspect(id);
          }}
        />
      ) : null}
      <PlaceContext
        point={context}
        close={() => setContext(null)}
        items={[{ label: t('client.openInspector'), run: () => context && inspect(context.id) }]}
      />
    </>
  );
}

/** A member filter offers the signed-in member first, then the people on screen (and the one picked). */
function memberChoices(me: string | undefined, onScreen: string[], picked: string | undefined): string[] {
  return [...new Set([...(me ? [me] : []), ...onScreen, ...(picked ? [picked] : [])])];
}
