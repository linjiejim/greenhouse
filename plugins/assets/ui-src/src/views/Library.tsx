import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Images, RotateCcw, Search, SlidersHorizontal, Tags, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { useEmbed } from '../embed';
import { useT } from '../i18n';
import { go } from '../router';
import { facetLabel, useLibrary, valueLabel } from '../state';
import type { AssetCard, FacetValues, ListFilters } from '../types';
import { useQueue } from '../upload/queue';
import { FacetPicker } from '../components/facets';
import { Tile } from '../components/tile';
import {
  Button,
  Chip,
  confirmAction,
  Dialog,
  EmptyState,
  IconButton,
  Select,
  Spinner,
  TagInput,
  TextInput,
  toast,
  toastError,
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
  const [filters, setFilters] = useState<ListFilters>({
    ...EMPTY_FILTERS,
    collection: collectionId ?? '',
    status: bin ? 'deleted' : 'active',
  });
  const query = useDebounced(filters, 250);
  const [items, setItems] = useState<AssetCard[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [batch, setBatch] = useState<null | 'tags' | 'facets' | 'collection'>(null);
  const generation = useRef(0);

  useEffect(() => setFilters((f) => ({ ...f, collection: collectionId ?? '' })), [collectionId]);

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

  // Infinite scroll: the sentinel below the grid loads the next page.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading && items.length < total) void load(items.length);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [load, loading, items.length, total]);

  const facets = config?.facets ?? [];
  const activeFilters =
    filters.kind ||
    filters.uploaded_by ||
    filters.orientation ||
    filters.ai ||
    filters.duplicates ||
    Object.values(filters.facets).some((v) => v.length);
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

  const removeSelected = async () => {
    if (!(await confirmAction(t('deleteConfirm'), t('delete')))) return;
    for (const id of ids) await api.remove(id).catch(() => toastError(t('failed')));
    toast(t('deleted'));
    reload();
  };
  const restoreSelected = async () => {
    for (const id of ids) await api.restore(id).catch(() => toastError(t('failed')));
    reload();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-5 py-2.5">
        <div className="relative min-w-48 flex-1">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-muted" />
          <TextInput
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder={t('search')}
            className="pl-8"
            aria-label={t('search')}
          />
        </div>
        <div className="flex h-8 overflow-hidden rounded-lg border border-edge" role="group">
          {(['', 'image', 'video'] as const).map((kind) => (
            <button
              key={kind || 'all'}
              type="button"
              aria-pressed={filters.kind === kind}
              onClick={() => setFilters({ ...filters, kind })}
              className={`px-3 text-[13px] font-semibold ${filters.kind === kind ? 'bg-primary-subtle text-primary-fg' : 'text-fg-secondary hover:bg-surface-muted'}`}
            >
              {kind === '' ? t('all') : kind === 'image' ? t('images') : t('videos')}
            </button>
          ))}
        </div>
        <Button variant={showFilters || activeFilters ? 'primary' : 'secondary'} onClick={() => setShowFilters(!showFilters)}>
          <SlidersHorizontal size={16} />
          {t('facets')}
        </Button>
        <Select
          value={filters.sort}
          onChange={(e) => setFilters({ ...filters, sort: e.target.value as ListFilters['sort'] })}
          className="w-auto"
          aria-label="sort"
        >
          <option value="new">{t('newest')}</option>
          <option value="old">{t('oldest')}</option>
          <option value="relevance">{t('relevance')}</option>
        </Select>
      </div>

      {showFilters ? (
        <div className="flex flex-col gap-3 border-b border-edge bg-surface-chrome px-5 py-3">
          <div className="flex flex-wrap gap-2">
            <Select
              value={filters.uploaded_by}
              onChange={(e) => setFilters({ ...filters, uploaded_by: e.target.value })}
              className="w-auto"
              aria-label={t('uploadedBy')}
            >
              <option value="">{t('anyone')}</option>
              <option value="me">{t('me')}</option>
              {[...people].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
            <Select
              value={filters.orientation}
              onChange={(e) => setFilters({ ...filters, orientation: e.target.value as ListFilters['orientation'] })}
              className="w-auto"
              aria-label={t('orientation')}
            >
              <option value="">{t('orientation')}</option>
              <option value="landscape">{t('landscape')}</option>
              <option value="portrait">{t('portrait')}</option>
              <option value="square">{t('square')}</option>
            </Select>
            <Select
              value={filters.ai}
              onChange={(e) => setFilters({ ...filters, ai: e.target.value as ListFilters['ai'] })}
              className="w-auto"
              aria-label={t('ai')}
            >
              <option value="">{t('ai')}</option>
              <option value="done">{t('aiDone')}</option>
              <option value="none">{t('aiNone')}</option>
            </Select>
            <Chip selected={filters.duplicates} onClick={() => setFilters({ ...filters, duplicates: !filters.duplicates })}>
              {t('duplicates')}
            </Chip>
            {activeFilters ? (
              <Button variant="ghost" onClick={() => setFilters({ ...EMPTY_FILTERS, q: filters.q, collection: filters.collection, status: filters.status })}>
                <X size={14} />
                {t('clear')}
              </Button>
            ) : null}
          </div>
          {facets.length ? (
            <FacetPicker facets={facets} value={filters.facets} onChange={(next) => setFilters({ ...filters, facets: next })} />
          ) : null}
        </div>
      ) : activeFilters ? (
        <div className="flex flex-wrap gap-1.5 border-b border-edge px-5 py-2">
          {Object.entries(filters.facets).flatMap(([key, values]) => {
            const facet = facets.find((f) => f.key === key);
            return values.map((v) => (
              <Chip
                key={`${key}:${v}`}
                selected
                onRemove={() => setFilters({ ...filters, facets: { ...filters.facets, [key]: values.filter((x) => x !== v) } })}
              >
                {facet ? `${facetLabel(facet, locale)}: ${valueLabel(facet, v, locale)}` : v}
              </Chip>
            ));
          })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-3 text-[13px] text-fg-muted">{t('count', { n: total })}</div>
        {failed && !items.length ? (
          <EmptyState
            icon={<Images size={28} />}
            title={t('loadFailed')}
            action={<Button onClick={() => void load(0)}>{t('retry')}</Button>}
          />
        ) : !loading && !items.length ? (
          <EmptyState
            icon={<Images size={28} />}
            title={activeFilters || filters.q ? t('noMatch') : bin ? t('binEmpty') : t('empty')}
            hint={activeFilters || filters.q || bin ? undefined : t('emptyHint')}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3">
            {items.map((asset) => (
              <Tile
                key={asset.id}
                asset={asset}
                selected={selected.has(asset.id)}
                selecting={selected.size > 0}
                onToggle={() => toggle(asset.id)}
                onOpen={() => go(`${base}/asset/${encodeURIComponent(asset.id)}`)}
              />
            ))}
          </div>
        )}
        <div ref={sentinel} className="flex h-12 items-center justify-center">
          {loading ? <Spinner /> : null}
        </div>
      </div>

      {selected.size ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-edge bg-surface-chrome px-5 py-2.5">
          <span className="mr-2 text-[13px] font-semibold">{t('selected', { n: selected.size })}</span>
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
                <Button variant="ghost" className="text-danger" onClick={removeSelected}>
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
      toast(t('saved'));
      onDone();
    } catch (error) {
      toastError((error as Error).message);
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
            className="flex h-9 items-center justify-between rounded-lg px-3 text-left text-[14px] hover:bg-surface-muted"
          >
            <span className="truncate">{c.name}</span>
            <span className="text-[12px] text-fg-muted">{c.count}</span>
          </button>
        ))}
        <div className="mt-3 flex gap-2">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={t('collectionName')} />
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
                toastError((error as Error).message);
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
                toast(t('saved'));
                if (result.skipped.length) toastError(t('readOnly'));
                onDone();
              } catch (error) {
                toastError((error as Error).message);
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
          <span className="text-[13px] font-semibold text-fg-secondary">{t('addTags')}</span>
          <TagInput value={add} onChange={setAdd} placeholder={t('tagsHint')} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold text-fg-secondary">{t('removeTags')}</span>
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
                toast(t('saved'));
                if (result.skipped.length) toastError(t('readOnly'));
                onDone();
              } catch (error) {
                toastError((error as Error).message);
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
