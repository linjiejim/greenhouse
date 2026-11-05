import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Images, RotateCcw, SlidersHorizontal, Tags, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { useEmbed } from '../embed';
import { useT } from '../i18n';
import { go, listHash, readQuery, writeQuery } from '../router';
import { facetLabel, useLibrary, valueLabel } from '../state';
import type { AssetCard, FacetValues, ListFilters } from '../types';
import { useQueue } from '../upload/queue';
import { FacetPicker } from '../components/facets';
import { Tile } from '../components/tile';
import {
  Button,
  Chip,
  Dialog,
  IconButton,
  notify,
  SearchInput,
  Select,
  Skeleton,
  Spinner,
  StateView,
  TagInput,
  TextInput,
  useDelayedFlag,
  cx,
} from '../components/ui';

const PAGE = 60;

export const EMPTY_FILTERS: ListFilters = {
  q: '',
  kind: '',
  facets: {},
  uploaded_by: '',
  orientation: '',
  collection: '',
  ai: '',
  duplicates: false,
  sort: 'new',
  status: 'active',
};

/** Filters live in the address (`?q=…&kind=image&f.product=a,b`) so a view reloads and shares. */
function filtersFromQuery(base: ListFilters): ListFilters {
  const q = readQuery();
  const facets: FacetValues = {};
  for (const [key, value] of q) if (key.startsWith('f.') && value) facets[key.slice(2)] = value.split(',');
  const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T) =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    ...base,
    q: q.get('q') ?? '',
    kind: pick(q.get('kind'), ['', 'image', 'video'] as const, ''),
    uploaded_by: q.get('by') ?? '',
    orientation: pick(q.get('orientation'), ['', 'landscape', 'portrait', 'square'] as const, ''),
    ai: pick(q.get('ai'), ['', 'done', 'none'] as const, ''),
    duplicates: q.get('duplicates') === '1',
    sort: pick(q.get('sort'), ['new', 'old', 'relevance'] as const, 'new'),
    facets,
  };
}

function queryFromFilters(f: ListFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (f.q) q.set('q', f.q);
  if (f.kind) q.set('kind', f.kind);
  if (f.uploaded_by) q.set('by', f.uploaded_by);
  if (f.orientation) q.set('orientation', f.orientation);
  if (f.ai) q.set('ai', f.ai);
  if (f.duplicates) q.set('duplicates', '1');
  if (f.sort !== 'new') q.set('sort', f.sort);
  for (const [key, values] of Object.entries(f.facets)) if (values.length) q.set(`f.${key}`, values.join(','));
  return q;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function Library({
  base,
  collectionId,
  bin,
  header,
}: {
  /** Hash prefix for opening an asset (`#` or `#/collection/<id>`). */
  base: string;
  collectionId?: string;
  bin?: boolean;
  header?: React.ReactNode;
}) {
  const t = useT();
  const locale = useEmbed((s) => s.locale);
  const { config, people, collections } = useLibrary();
  const revision = useQueue((s) => s.revision);
  const [filters, setFilters] = useState<ListFilters>(() =>
    filtersFromQuery({ ...EMPTY_FILTERS, collection: collectionId ?? '', status: bin ? 'deleted' : 'active' }),
  );
  const query = useDebounced(filters, 250);
  const [items, setItems] = useState<AssetCard[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [batch, setBatch] = useState<null | 'tags' | 'facets' | 'collection'>(null);
  const generation = useRef(0);
  const showSkeleton = useDelayedFlag(loading && !items.length);

  useEffect(() => setFilters((f) => ({ ...f, collection: collectionId ?? '' })), [collectionId]);
  useEffect(() => writeQuery(queryFromFilters(query)), [query]);
  // A new query starts from the top with nothing selected.
  useEffect(() => setSelected(new Set()), [query]);

  const load = useCallback(
    async (offset: number) => {
      const gen = ++generation.current;
      setLoading(true);
      setFailed(false);
      try {
        const page = await api.list(query, offset, PAGE);
        if (gen !== generation.current) return;
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))]));
        setTotal(page.total);
      } catch {
        if (gen === generation.current) setFailed(true);
      } finally {
        if (gen === generation.current) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void load(0);
  }, [load, revision]);

  // A media grid scrolls on (DESIGN.md: feeds and media grids may load more as they scroll).
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading && !failed && items.length < total) void load(items.length);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [load, loading, failed, items.length, total]);

  const facets = config?.facets ?? [];
  const peopleOptions = useMemo(
    () => [{ value: 'me', label: t('me') }, ...[...people].map(([id, name]) => ({ value: id, label: name }))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, locale],
  );
  const clearFilters = () =>
    setFilters({ ...EMPTY_FILTERS, collection: filters.collection, status: filters.status, sort: filters.sort });
  // Every active condition shows as a chip with ✕, even with the panel closed.
  const active: Array<{ key: string; label: string; clear: () => void }> = [
    ...(filters.uploaded_by
      ? [
          {
            key: 'by',
            label: `${t('uploadedBy')}：${peopleOptions.find((o) => o.value === filters.uploaded_by)?.label ?? filters.uploaded_by}`,
            clear: () => setFilters({ ...filters, uploaded_by: '' }),
          },
        ]
      : []),
    ...(filters.orientation
      ? [{ key: 'o', label: `${t('orientation')}：${t(filters.orientation)}`, clear: () => setFilters({ ...filters, orientation: '' }) }]
      : []),
    ...(filters.ai
      ? [{ key: 'ai', label: `${t('ai')}：${t(filters.ai === 'done' ? 'aiDone' : 'aiNone')}`, clear: () => setFilters({ ...filters, ai: '' }) }]
      : []),
    ...(filters.duplicates ? [{ key: 'dup', label: t('duplicates'), clear: () => setFilters({ ...filters, duplicates: false }) }] : []),
    ...Object.entries(filters.facets).flatMap(([key, values]) => {
      const facet = facets.find((f) => f.key === key);
      return values.map((v) => ({
        key: `${key}:${v}`,
        label: facet ? `${facetLabel(facet, locale)}：${valueLabel(facet, v, locale)}` : v,
        clear: () => setFilters({ ...filters, facets: { ...filters.facets, [key]: values.filter((x) => x !== v) } }),
      }));
    }),
  ];
  const filtered = active.length > 0 || !!filters.q || !!filters.kind;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ids = useMemo(() => [...selected], [selected]);
  const reload = () => {
    setSelected(new Set());
    void load(0);
  };

  // The bin keeps them 30 days: move at once, offer Undo.
  const removeSelected = async () => {
    const moved: string[] = [];
    for (const id of ids) await api.remove(id).then(() => moved.push(id), () => {});
    reload();
    if (moved.length < ids.length) notify.error(t('skippedSome', { n: ids.length - moved.length }));
    if (moved.length)
      notify.undo(t('deletedMany', { n: moved.length }), async () => {
        for (const id of moved) await api.restore(id).catch(() => {});
        reload();
      });
  };
  const restoreSelected = async () => {
    let restored = 0;
    for (const id of ids) await api.restore(id).then(() => restored++, () => {});
    if (restored < ids.length) notify.error(t('skippedSome', { n: ids.length - restored }));
    reload();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
        <SearchInput
          className="min-w-48 flex-1"
          value={filters.q}
          onChange={(q) => setFilters({ ...filters, q })}
          placeholder={t('search')}
          label={t('search')}
        />
        <div className="flex h-8 overflow-hidden rounded-control border border-border pointer-coarse:h-11" role="group" aria-label={t('kind')}>
          {(['', 'image', 'video'] as const).map((kind) => (
            <button
              key={kind || 'all'}
              type="button"
              aria-pressed={filters.kind === kind}
              onClick={() => setFilters({ ...filters, kind })}
              className={cx(
                'px-3 text-body-sm font-medium',
                filters.kind === kind ? 'bg-selected text-primary-fg' : 'text-muted-foreground hover:bg-hover',
              )}
            >
              {kind === '' ? t('all') : kind === 'image' ? t('images') : t('videos')}
            </button>
          ))}
        </div>
        <Button aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>
          <SlidersHorizontal size={16} />
          {t('facets')}
          {active.length ? <span className="tabular-nums text-primary-fg">{active.length}</span> : null}
        </Button>
        <Select
          className="w-32"
          label={t('sort')}
          value={filters.sort}
          onChange={(sort) => setFilters({ ...filters, sort: (sort ?? 'new') as ListFilters['sort'] })}
          options={[
            { value: 'new', label: t('newest') },
            { value: 'old', label: t('oldest') },
            { value: 'relevance', label: t('relevance') },
          ]}
        />
      </div>

      {showFilters ? (
        <div className="flex flex-col gap-3 border-b border-border bg-sunken px-5 py-3">
          <div className="flex flex-wrap gap-2">
            <Select
              clearable
              className="w-auto min-w-36"
              label={t('uploadedBy')}
              value={filters.uploaded_by || undefined}
              onChange={(v) => setFilters({ ...filters, uploaded_by: v ?? '' })}
              options={peopleOptions}
            />
            <Select
              clearable
              className="w-auto min-w-28"
              label={t('orientation')}
              value={filters.orientation || undefined}
              onChange={(v) => setFilters({ ...filters, orientation: (v ?? '') as ListFilters['orientation'] })}
              options={[
                { value: 'landscape', label: t('landscape') },
                { value: 'portrait', label: t('portrait') },
                { value: 'square', label: t('square') },
              ]}
            />
            <Select
              clearable
              className="w-auto min-w-28"
              label={t('ai')}
              value={filters.ai || undefined}
              onChange={(v) => setFilters({ ...filters, ai: (v ?? '') as ListFilters['ai'] })}
              options={[
                { value: 'done', label: t('aiDone') },
                { value: 'none', label: t('aiNone') },
              ]}
            />
            <Chip selected={filters.duplicates} onClick={() => setFilters({ ...filters, duplicates: !filters.duplicates })}>
              {t('duplicates')}
            </Chip>
          </div>
          {facets.length ? (
            <FacetPicker facets={facets} value={filters.facets} onChange={(next) => setFilters({ ...filters, facets: next })} />
          ) : null}
        </div>
      ) : null}
      {active.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-2">
          {active.map((a) => (
            <Chip key={a.key} selected onRemove={a.clear}>
              {a.label}
            </Chip>
          ))}
          <Button variant="ghost" compact onClick={clearFilters}>
            <X size={14} />
            {t('clear')}
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {items.length || !loading ? (
          <div className={cx('mb-3 text-body-sm text-muted-foreground tabular-nums', loading && items.length > 0 && 'opacity-60')}>
            {t('count', { n: total })}
          </div>
        ) : null}
        {failed && !items.length ? (
          <StateView kind="error" onRetry={() => void load(0)} />
        ) : loading && !items.length ? (
          showSkeleton ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3" aria-busy="true">
              {Array.from({ length: 12 }, (_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <Skeleton className="aspect-square w-full rounded-card" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ))}
            </div>
          ) : null
        ) : !items.length ? (
          filtered ? (
            <StateView kind="no-match" onClearFilters={() => setFilters({ ...EMPTY_FILTERS, collection: filters.collection, status: filters.status })} />
          ) : (
            <StateView
              kind="empty"
              icon={<Images size={24} />}
              title={bin ? t('binEmpty') : t('empty')}
              hint={bin ? undefined : t('emptyHint')}
            />
          )
        ) : (
          <div
            className={cx('grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3', loading && 'opacity-60')}
            data-testid="assets-grid"
          >
            {items.map((asset) => (
              <Tile
                key={asset.id}
                asset={asset}
                selected={selected.has(asset.id)}
                selecting={selected.size > 0}
                onToggle={() => toggle(asset.id)}
                onOpen={() => go(listHash(`${base}/asset/${encodeURIComponent(asset.id)}`))}
              />
            ))}
          </div>
        )}
        <div ref={sentinel} className="flex h-12 items-center justify-center">
          {loading && items.length ? <Spinner /> : null}
          {failed && items.length ? (
            <Button compact onClick={() => void load(items.length)}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      </div>

      {selected.size ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-sunken px-5 py-2.5">
          <span className="mr-2 text-body-sm font-medium tabular-nums">{t('selected', { n: selected.size })}</span>
          {bin ? (
            <Button onClick={restoreSelected}>
              <RotateCcw size={16} />
              {t('restore')}
            </Button>
          ) : (
            <>
              <Button onClick={() => setBatch('collection')}>
                <FolderPlus size={16} />
                {t('addToCollection')}
              </Button>
              <Button onClick={() => setBatch('tags')}>
                <Tags size={16} />
                {t('editTags')}
              </Button>
              {facets.length ? (
                <Button onClick={() => setBatch('facets')}>
                  <SlidersHorizontal size={16} />
                  {t('setFacets')}
                </Button>
              ) : null}
              {config?.can_manage ? (
                <Button variant="ghost" className="text-destructive" onClick={removeSelected}>
                  <Trash2 size={16} />
                  {t('delete')}
                </Button>
              ) : null}
            </>
          )}
          <div className="flex-1" />
          <IconButton label={t('close')} onClick={() => setSelected(new Set())}>
            <X size={16} />
          </IconButton>
        </div>
      ) : null}

      {batch === 'collection' ? (
        <CollectionDialog
          ids={ids}
          collections={collections}
          onClose={() => setBatch(null)}
          onDone={() => {
            setBatch(null);
            void useLibrary.getState().loadCollections();
            reload();
          }}
        />
      ) : null}
      {batch === 'tags' ? <TagsDialog ids={ids} onClose={() => setBatch(null)} onDone={() => (setBatch(null), reload())} /> : null}
      {batch === 'facets' ? (
        <FacetsDialog ids={ids} onClose={() => setBatch(null)} onDone={() => (setBatch(null), reload())} />
      ) : null}
    </div>
  );
}

function CollectionDialog({
  ids,
  collections,
  onClose,
  onDone,
}: {
  ids: string[];
  collections: Array<{ id: string; name: string; count: number }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async (collectionId: string) => {
    setBusy(true);
    try {
      await api.addToCollection(collectionId, ids);
      onDone();
    } catch (error) {
      notify.error((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('addToCollection')} onClose={onClose}>
      <div className="flex flex-col gap-1">
        {collections.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={busy}
            onClick={() => add(c.id)}
            className="flex h-9 items-center justify-between rounded-control px-3 text-left text-body hover:bg-hover pointer-coarse:h-11"
          >
            <span className="truncate">{c.name}</span>
            <span className="text-caption text-muted-foreground tabular-nums">{c.count}</span>
          </button>
        ))}
        <div className="mt-3 flex gap-2">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} aria-label={t('collectionName')} placeholder={t('collectionName')} />
          <Button
            variant="primary"
            disabled={!name.trim()}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { collection } = await api.createCollection(name.trim());
                await add(collection.id);
              } catch (error) {
                notify.error((error as Error).message);
                setBusy(false);
              }
            }}
          >
            {t('newCollection')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TagsDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t('editTags')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!add.length && !remove.length}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.batch({ ids, add_tags: add, remove_tags: remove });
                if (result.skipped.length) notify.warning(t('skippedSome', { n: result.skipped.length }));
                onDone();
              } catch (error) {
                notify.error((error as Error).message);
                setBusy(false);
              }
            }}
          >
            {t('save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-foreground">{t('addTags')}</span>
          <TagInput value={add} onChange={setAdd} placeholder={t('tagsHint')} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-foreground">{t('removeTags')}</span>
          <TagInput value={remove} onChange={setRemove} placeholder={t('tagsHint')} />
        </label>
      </div>
    </Dialog>
  );
}

function FacetsDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const facets = useLibrary((s) => s.config?.facets ?? []);
  const [value, setValue] = useState<FacetValues>({});
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t('setFacets')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!Object.keys(value).length}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.batch({ ids, facets: value });
                if (result.skipped.length) notify.warning(t('skippedSome', { n: result.skipped.length }));
                onDone();
              } catch (error) {
                notify.error((error as Error).message);
                setBusy(false);
              }
            }}
          >
            {t('save')}
          </Button>
        </>
      }
    >
      <FacetPicker facets={facets} value={value} onChange={setValue} />
    </Dialog>
  );
}
