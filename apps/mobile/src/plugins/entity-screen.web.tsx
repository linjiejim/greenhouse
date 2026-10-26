import React, { useState } from 'react';

import { useEntityList } from './entity-hooks';
import { entityColumns, fieldText } from './surface-model';
import { localize, type PluginEntitySchema, type PluginEntityListPage } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { useT } from '../lib/i18n';
import { useOpenObject } from '../shell/open-object';
import { Place, PlaceEmpty, PlaceContext, type PlaceContextPoint } from '../ui/place.web';
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
  const [filters, setFilters] = useState<Record<string, string>>({}),
    [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' }>();
  const view = entity.views.find((v) => v.id === (page.view ?? 'default')) ?? entity.views[0],
    fields = entityColumns(entity, view);
  const [context, setContext] = useState<PlaceContextPoint | null>(null);
  const list = useEntityList(entity, view, filters, sort);
  const inspect = (id: string) => open({ kind: 'plugin-entity', plugin, page: detailPage, id, entity: entity.id });
  return (
    <>
      <Place title={`${localize(page.title, lang)} · ${list.total}`}>
        <div className="gh-place-tabs">
          {(view?.filters ?? []).map((key) => {
            const f = entity.fields.find((f) => f.key === key && f.filterable);
            if (!f) return null;
            return (
              <label key={key}>
                {localize(f.title, lang)}{' '}
                {f.kind === 'enum' || f.kind === 'boolean' ? (
                  <select
                    aria-label={localize(f.title, lang)}
                    value={filters[key] ?? ''}
                    onChange={(e) => setFilters((v) => ({ ...v, [key]: e.target.value }))}
                  >
                    <option value="">{t('places.all')}</option>
                    {(f.kind === 'boolean' ? ['true', 'false'] : (f.values ?? [])).map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={localize(f.title, lang)}
                    value={filters[key] ?? ''}
                    onChange={(e) => setFilters((v) => ({ ...v, [key]: e.target.value }))}
                  />
                )}
              </label>
            );
          })}
          <label>
            {t('places.sort')}{' '}
            <select
              aria-label={t('places.sort')}
              value={sort ? `${sort.field}:${sort.dir}` : ''}
              onChange={(e) => {
                const [field, dir] = e.target.value.split(':');
                setSort(field ? { field, dir: dir as 'asc' | 'desc' } : undefined);
              }}
            >
              <option value="">—</option>
              {fields
                .filter((f) => f.sortable)
                .flatMap((f) =>
                  (['asc', 'desc'] as const).map((dir) => (
                    <option key={`${f.key}:${dir}`} value={`${f.key}:${dir}`}>
                      {localize(f.title, lang)} {dir === 'asc' ? '↑' : '↓'}
                    </option>
                  )),
                )}
            </select>
          </label>
        </div>
        <div
          className="gh-place-scroll"
          data-testid="plugin-entity-list"
          onScroll={(e) => {
            if (e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 120)
              list.more();
          }}
        >
          <table className="gh-data-grid">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.key}>{localize(f.title, lang)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.items.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  aria-label={String(row[entity.title_field] ?? row.id)}
                  onClick={() => inspect(String(row.id))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContext({ id: String(row.id), x: e.clientX, y: e.clientY });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') inspect(String(row.id));
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
                    <td key={f.key}>{fieldText(f, row[f.key], lang)}</td>
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
            <PlaceEmpty loading={list.loading} error={list.error} retry={() => void list.refresh()} />
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
