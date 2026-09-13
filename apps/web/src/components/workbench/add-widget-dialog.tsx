/**
 * Card composer: pick a recipe, bind a Tables view, pin a destination, or write a note.
 *
 * The Tables lane is what fulfils "filter bases/tables from the home page": it
 * reuses a saved view's `TableQuery` rather than growing a second filter
 * builder. Filters the user already assembled in Tables come across intact, and
 * the bounded filter AST stays the one in `@greenhouse/types/tables`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityKind } from '@greenhouse/types/entity-links';
import type { EntitySearchHit } from '@greenhouse/types/search';
import type { TableViewConfig } from '@greenhouse/types/tables';
import {
  PINNABLE_ENTITY_KINDS,
  WORKBENCH_LIMITS,
  isDataWidget,
  isTextWidget,
  type DataWidget,
  type NavTarget,
  type WorkbenchWidget,
} from '@greenhouse/types/workbench';
import { Button, Dialog, Input, SearchInput, Select, Spinner, Textarea } from '../ui';
import { LayoutGrid, Table2 } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { globalSearch } from '../../lib/api/search';
import { getTableBase, getTableSchema, listTableBases } from '../../lib/api/tables';
import type { TableDefinition, TableField, TableView } from '../../lib/api/tables';
import { availableRecipes, recipeLabels, type WidgetRecipe } from '../../lib/workbench/recipes';
import { safeParse } from '../../lib/utils';
import type { PlatformApplication } from '../../platform/catalog';
import { platformApplicationHref } from '../../platform/catalog';

type Mode = 'recipe' | 'tables' | 'nav' | 'text';

interface AddWidgetDialogProps {
  open: boolean;
  /** Non-null when editing an existing card rather than adding one. */
  editing: WorkbenchWidget | null;
  applications: readonly PlatformApplication[];
  readableToolIds: ReadonlySet<string>;
  onClose: () => void;
  onSave: (widget: WorkbenchWidget) => void;
  makeId: () => string;
  nextPosition: (width: number, height: number) => { x: number; y: number };
  tabId: string;
}

export function AddWidgetDialog({
  open,
  editing,
  applications,
  readableToolIds,
  onClose,
  onSave,
  makeId,
  nextPosition,
  tabId,
}: AddWidgetDialogProps) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('recipe');
  const [title, setTitle] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setTitle(editing.title);
      setTitleEdited(false);
      setMode(
        isTextWidget(editing)
          ? 'text'
          : editing.kind === 'nav'
            ? 'nav'
            : editing.source.toolId === 'tables_query'
              ? 'tables'
              : 'recipe',
      );
    } else {
      setTitle('');
      setTitleEdited(false);
      setMode('recipe');
    }
  }, [editing, open]);

  const layoutFor = useCallback(
    (w: number, h: number) => (editing ? editing.layout : { tabId, ...nextPosition(w, h), w, h }),
    [editing, nextPosition, tabId],
  );

  const recipes = useMemo(() => availableRecipes(readableToolIds), [readableToolIds]);
  const canUseTables = readableToolIds.has('tables_query');

  const handleRecipe = (recipe: WidgetRecipe) => {
    const defaultTitle = t(recipeLabels(recipe).labelKey);
    const changedRecipe = editing && isDataWidget(editing) && editing.recipeId !== recipe.id;
    onSave({
      kind: 'data',
      id: editing?.id ?? makeId(),
      title: titleEdited || !changedRecipe ? title.trim() || defaultTitle : defaultTitle,
      layout: layoutFor(recipe.size.w, recipe.size.h),
      display: recipe.display,
      ...(recipe.chartType ? { chartType: recipe.chartType } : {}),
      source: recipe.source,
      ...(recipe.map ? { map: recipe.map } : {}),
      recipeId: recipe.id,
    });
  };

  return (
    <Dialog open={open} onClose={onClose} title={editing ? t('home.editCard') : t('home.addCard')} size="lg">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-fg-muted">{t('home.cardTitle')}</label>
          <Input
            size="sm"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setTitleEdited(true);
            }}
            maxLength={WORKBENCH_LIMITS.maxTitleLength}
            placeholder={t('home.cardTitlePlaceholder')}
          />
        </div>

        <div className="flex gap-1 rounded-lg border border-edge bg-surface-muted p-1">
          {(
            [
              ['recipe', t('home.modeRecipe')],
              ['tables', t('home.modeTables')],
              ['nav', t('home.modeNav')],
              ['text', t('home.modeText')],
            ] as Array<[Mode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                mode === value
                  ? 'bg-surface-raised font-semibold text-fg shadow-sm'
                  : 'text-fg-muted hover:text-fg-secondary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'recipe' && <RecipeList recipes={recipes} onPick={handleRecipe} />}

        {mode === 'tables' &&
          (canUseTables ? (
            <TablesBuilder
              initial={
                editing && isDataWidget(editing) && editing.source.toolId === 'tables_query' ? editing : undefined
              }
              onSave={(source, map, display, defaultTitle) =>
                onSave({
                  kind: 'data',
                  id: editing?.id ?? makeId(),
                  title: title.trim() || defaultTitle,
                  layout: layoutFor(display === 'kpi' ? 3 : 6, display === 'kpi' ? 2 : 5),
                  display,
                  source,
                  map,
                })
              }
            />
          ) : (
            <p className="py-6 text-center text-xs text-fg-faint">{t('home.tablesUnavailable')}</p>
          ))}

        {mode === 'nav' && (
          <NavPicker
            applications={applications}
            onPick={(target, defaultTitle) =>
              onSave({
                kind: 'nav',
                id: editing?.id ?? makeId(),
                title: title.trim() || defaultTitle,
                layout: layoutFor(3, 2),
                target,
              })
            }
          />
        )}

        {mode === 'text' && (
          <TextBuilder
            initial={editing && isTextWidget(editing) ? editing.markdown : ''}
            onSave={(markdown) =>
              onSave({
                kind: 'text',
                id: editing?.id ?? makeId(),
                title: title.trim() || t('home.modeText'),
                layout: layoutFor(4, 3),
                markdown,
              })
            }
          />
        )}

        {editing && isDataWidget(editing) && mode === 'recipe' && (
          <p className="text-xs text-fg-faint">{t('home.editDataHint')}</p>
        )}

        {editing && (
          <div className="flex justify-end border-t border-edge pt-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onSave({ ...editing, title: title.trim() || editing.title })}
            >
              {t('home.saveTitle')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function RecipeList({ recipes, onPick }: { recipes: WidgetRecipe[]; onPick: (recipe: WidgetRecipe) => void }) {
  const t = useT();
  if (recipes.length === 0) {
    return <p className="py-6 text-center text-xs text-fg-faint">{t('home.noRecipes')}</p>;
  }
  return (
    <div className="grid max-h-80 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
      {recipes.map((recipe) => (
        <button
          key={recipe.id}
          type="button"
          onClick={() => onPick(recipe)}
          className="rounded-lg border border-edge bg-surface-card p-3 text-left transition-colors hover:border-primary-400 hover:bg-surface-muted"
        >
          <span className="block text-sm font-medium text-fg">{t(recipeLabels(recipe).labelKey)}</span>
          <span className="mt-0.5 block text-xs text-fg-faint">{t(recipeLabels(recipe).descriptionKey)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Base → table → (saved view) → display.
 *
 * Picking a view copies its stored `query` into the card, so the card shows the
 * same rows the view does — including its filters and sort — without this
 * dialog having to understand the filter AST.
 */
function TablesBuilder({
  initial,
  onSave,
}: {
  initial?: DataWidget;
  onSave: (
    source: { toolId: string; input: Record<string, unknown> },
    map: { rows?: string; value?: string; columns?: Array<{ key: string; label: string }> },
    display: 'table' | 'kpi',
    defaultTitle: string,
  ) => void;
}) {
  const t = useT();
  const [bases, setBases] = useState<Array<{ id: number; name: string }>>([]);
  const [baseId, setBaseId] = useState<number | null>(null);
  const [tables, setTables] = useState<TableDefinition[]>([]);
  const initialTableId =
    typeof initial?.source.input.table_id === 'number' && Number.isFinite(initial.source.input.table_id)
      ? initial.source.input.table_id
      : null;
  const [tableId, setTableId] = useState<number | null>(initialTableId);
  const [views, setViews] = useState<TableView[]>([]);
  const [fields, setFields] = useState<TableField[]>([]);
  const [viewId, setViewId] = useState<number | null>(null);
  const [display, setDisplay] = useState<'table' | 'kpi'>(initial?.display === 'kpi' ? 'kpi' : 'table');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void listTableBases().then((rows) => setBases(rows.map((row) => ({ id: row.id, name: row.name }))));
  }, []);

  useEffect(() => {
    if (initialTableId === null) return;
    setLoading(true);
    void getTableSchema(initialTableId)
      .then((schema) => {
        setBaseId(schema.table.base_id);
        setFields(schema.fields);
        setViews(schema.views);
        const savedQuery = initial?.source.input.query;
        const matching = schema.views.find((view) => {
          const config = safeParse<TableViewConfig>(view.config, {} as TableViewConfig);
          return JSON.stringify(config.query) === JSON.stringify(savedQuery);
        });
        setViewId(matching?.id ?? null);
      })
      .finally(() => setLoading(false));
  }, [initial, initialTableId]);

  useEffect(() => {
    if (baseId === null) return;
    setLoading(true);
    void getTableBase(baseId)
      .then((workspace) => {
        setTables(workspace.tables);
        setTableId((current) =>
          current !== null && workspace.tables.some((table) => table.id === current)
            ? current
            : (workspace.tables[0]?.id ?? null),
        );
      })
      .finally(() => setLoading(false));
  }, [baseId]);

  useEffect(() => {
    if (tableId === null) return;
    setLoading(true);
    void getTableSchema(tableId)
      .then((schema) => {
        setFields(schema.fields);
        setViews(schema.views);
        setViewId(schema.views[0]?.id ?? null);
      })
      .finally(() => setLoading(false));
  }, [tableId]);

  const handleSave = () => {
    if (tableId === null) return;
    const table = tables.find((candidate) => candidate.id === tableId);
    const view = views.find((candidate) => candidate.id === viewId);
    const config = view ? safeParse<TableViewConfig>(view.config, {} as TableViewConfig) : undefined;
    const query = config?.query;
    const defaultTitle = view ? `${table?.name ?? ''} · ${view.name}` : (table?.name ?? 'Table');

    if (display === 'kpi') {
      onSave(
        {
          toolId: 'tables_query',
          input: { action: 'records.aggregate', table_id: tableId, operation: 'count', ...(query ? { query } : {}) },
        },
        { value: 'rows.0.value' },
        'kpi',
        defaultTitle,
      );
      return;
    }

    // Records come back as rows with a `values` map keyed by field id, so a
    // column path is `values.<fieldId>`.
    const visible: number[] = (config?.fieldIds ?? fields.map((field) => field.id)).slice(0, 6);
    onSave(
      {
        toolId: 'tables_query',
        input: { action: 'records.query', table_id: tableId, ...(query ? { query } : {}) },
      },
      {
        rows: 'records',
        columns: visible.map((fieldId) => ({
          key: `values.${fieldId}`,
          label: fields.find((field) => field.id === fieldId)?.name ?? String(fieldId),
        })),
      },
      'table',
      defaultTitle,
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-fg-muted">{t('home.tablesBase')}</span>
          <Select
            size="sm"
            value={baseId ?? ''}
            onChange={(event) => setBaseId(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">{t('common.select')}</option>
            {bases.map((base) => (
              <option key={base.id} value={base.id}>
                {base.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-fg-muted">{t('home.tablesTable')}</span>
          <Select
            size="sm"
            value={tableId ?? ''}
            onChange={(event) => setTableId(event.target.value ? Number(event.target.value) : null)}
            disabled={tables.length === 0}
          >
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-fg-muted">{t('home.tablesView')}</span>
          <Select
            size="sm"
            value={viewId ?? ''}
            onChange={(event) => setViewId(event.target.value ? Number(event.target.value) : null)}
            disabled={views.length === 0}
          >
            <option value="">{t('home.tablesNoView')}</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-fg-muted">{t('home.cardDisplay')}</span>
          <Select size="sm" value={display} onChange={(event) => setDisplay(event.target.value as 'table' | 'kpi')}>
            <option value="table">{t('home.displayTable')}</option>
            <option value="kpi">{t('home.displayCount')}</option>
          </Select>
        </label>
      </div>
      <p className="text-xs text-fg-faint">{t('home.tablesViewHint')}</p>
      <div className="flex items-center justify-end gap-2">
        {loading && <Spinner className="h-4 w-4 text-fg-faint" />}
        <Button size="sm" onClick={handleSave} disabled={tableId === null}>
          <Table2 size={14} />
          {t('home.addCard')}
        </Button>
      </div>
    </div>
  );
}

/** Pin an application home or any record the global search can find. */
function NavPicker({
  applications,
  onPick,
}: {
  applications: readonly PlatformApplication[];
  onPick: (target: NavTarget, defaultTitle: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<EntitySearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void globalSearch(trimmed, null)
        .then((response) => {
          if (cancelled) return;
          const pinnable = new Set<EntityKind>(PINNABLE_ENTITY_KINDS);
          setHits(
            response.groups
              .filter((group) => group.kind !== 'session' && pinnable.has(group.kind))
              .flatMap((group) => group.items)
              .filter((hit): hit is EntitySearchHit => 'ref' in hit),
          );
        })
        .finally(() => !cancelled && setSearching(false));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const linkableApps = applications.filter((application) => platformApplicationHref(application));

  return (
    <div className="space-y-3">
      <div>
        <span className="mb-1 block text-xs font-medium text-fg-muted">{t('home.navApps')}</span>
        <div className="flex flex-wrap gap-1.5">
          {linkableApps.map((application) => (
            <button
              key={application.id}
              type="button"
              onClick={() => onPick({ type: 'app', appId: application.id }, application.title)}
              className="flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-xs text-fg-secondary transition-colors hover:border-primary-400 hover:bg-surface-muted"
            >
              <LayoutGrid size={12} />
              {application.title}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="mb-1 block text-xs font-medium text-fg-muted">{t('home.navRecords')}</span>
        <SearchInput size="sm" value={query} onChange={setQuery} placeholder={t('home.navSearchPlaceholder')} />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {searching && <Spinner className="h-4 w-4 text-fg-faint" />}
          {hits.map((hit) => (
            <button
              key={`entity-${hit.ref.kind}-${hit.ref.id}`}
              type="button"
              onClick={() => onPick({ type: 'entity', ref: hit.ref }, hit.title)}
              className="block w-full rounded-md border border-edge px-2.5 py-1.5 text-left transition-colors hover:border-primary-400 hover:bg-surface-muted"
            >
              <span className="block truncate text-sm text-fg">{hit.title}</span>
              {hit.subtitle && <span className="block truncate text-xs text-fg-faint">{hit.subtitle}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TextBuilder({ initial, onSave }: { initial: string; onSave: (markdown: string) => void }) {
  const t = useT();
  const [markdown, setMarkdown] = useState(initial);
  useEffect(() => setMarkdown(initial), [initial]);
  return (
    <div className="space-y-2">
      <Textarea
        rows={6}
        value={markdown}
        maxLength={WORKBENCH_LIMITS.maxTextLength}
        onChange={(event) => setMarkdown(event.target.value)}
        placeholder={t('home.textPlaceholder')}
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={() => onSave(markdown)} disabled={!markdown.trim()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
