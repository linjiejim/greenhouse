import React, { useEffect, useState } from 'react';

import { useEntityList } from './entity-hooks';
import { NativeMenu } from '../ui/menu.web';
import { FieldValue, FieldTypeIcon } from '../ui/field-value.web';
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
  useEffect(() => {
    const refresh = () => {
      void list.refresh();
    };
    window.addEventListener('greenhouse:refresh', refresh);
    return () => window.removeEventListener('greenhouse:refresh', refresh);
  });
  const [selected, setSelected] = useState<string>();
  const inspect = (id: string) => {
    setSelected(id);
    open({ kind: 'plugin-entity', plugin, page: detailPage, id, entity: entity.id });
  };
  return (
    <>
      <Place
        title={`${localize(page.title, lang)} · ${list.total}`}
        actions={
          <button onClick={() => void list.refresh()} disabled={list.loading}>
            {t('common.refresh')}
          </button>
        }
      >
        <div className="gh-place-tabs">
          {(view?.filters ?? []).map((key) => {
            const f = entity.fields.find((f) => f.key === key && f.filterable);
            if (!f) return null;
            return (
              <div className="gh-filter" key={key}>
                {localize(f.title, lang)}{' '}
                {f.kind === 'enum' || f.kind === 'boolean' ? (
                  <NativeMenu
                    title={localize(f.title, lang)}
                    items={[
                      { id: '', title: t('places.all'), checked: !filters[key] },
                      ...(f.kind === 'boolean' ? ['true', 'false'] : (f.values ?? [])).map((value) => ({
                        id: value,
                        title: fieldText(f, f.kind === 'boolean' ? value === 'true' : value, lang),
                        checked: filters[key] === value,
                      })),
                    ]}
                    onSelect={(value) => setFilters((v) => ({ ...v, [key]: value }))}
                  >
                    <button aria-label={localize(f.title, lang)}>
                      {filters[key]
                        ? fieldText(f, f.kind === 'boolean' ? filters[key] === 'true' : filters[key], lang)
                        : t('places.all')}{' '}
                      ▾
                    </button>
                  </NativeMenu>
                ) : (
                  <input
                    aria-label={localize(f.title, lang)}
                    value={filters[key] ?? ''}
                    onChange={(e) => setFilters((v) => ({ ...v, [key]: e.target.value }))}
                  />
                )}
              </div>
            );
          })}
          <div className="gh-filter">
            {t('places.sort')}{' '}
            <NativeMenu
              title={t('places.sort')}
              items={[
                { id: '', title: '—', checked: !sort },
                ...fields
                  .filter((f) => f.sortable)
                  .flatMap((f) =>
                    (['asc', 'desc'] as const).map((dir) => ({
                      id: `${f.key}:${dir}`,
                      title: `${localize(f.title, lang)} ${dir === 'asc' ? '↑' : '↓'}`,
                      checked: sort?.field === f.key && sort.dir === dir,
                    })),
                  ),
              ]}
              onSelect={(value) => {
                const [field, dir] = value.split(':');
                setSort(field ? { field, dir: dir as 'asc' | 'desc' } : undefined);
              }}
            >
              <button aria-label={t('places.sort')}>
                {sort
                  ? `${localize(fields.find((f) => f.key === sort.field)?.title ?? sort.field, lang)} ${sort.dir === 'asc' ? '↑' : '↓'}`
                  : '—'}{' '}
                ▾
              </button>
            </NativeMenu>
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
                      <FieldValue kind={f.kind} text={fieldText(f, row[f.key], lang)} />
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
