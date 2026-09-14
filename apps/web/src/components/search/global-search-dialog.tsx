/**
 * Global search palette (⌘P).
 *
 * One input, one flat keyboard path, and results that open the same detail peek
 * an entity link in an agent's answer opens — search and chat resolve a record
 * the same way, so there is one thing to learn rather than two.
 *
 * Two view modes over the same response: "All" shows every kind as a short
 * section (breadth — what exists anywhere), and a kind pill shows that one
 * domain in depth. The pill row is rendered in full at all times even when a
 * kind has no hits; pills that appear and vanish as you type make the row jump
 * under the cursor, which is the same reason the palette is anchored near the
 * top instead of centred.
 */

import type { EntityKind } from '@greenhouse/types/entity-links';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { entityUrl } from '@greenhouse/types/entity-links';
import { SEARCHABLE_KINDS, type SearchHit, type SearchKind } from '@greenhouse/types/search';
import { OverlayFrame } from '../overlay-frame';
import { FilterPills, Spinner } from '../ui';
import { MessageSquare, Search as SearchIcon } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { globalSearch } from '../../lib/api/search';
import { toSearchSummary } from '../../lib/search-summary';
import { useGlobalSearchStore } from '../../stores/global-search-store';
import { openEntityPeek } from '../../stores/entity-peek-store';
import { entityPeekMeta } from '../entity-peek/registry';

const DEBOUNCE_MS = 200;

const KIND_LABEL_KEYS: Record<string, TranslationKey> = {
  session: 'search.session',
  project: 'search.project',
  kb_doc: 'search.doc',
  tables_record: 'entityPeek.record',
};

/** Group heading for a kind — core from the table, extension kinds from their registration. */
function kindLabelKey(kind: SearchKind): TranslationKey {
  if (KIND_LABEL_KEYS[kind]) return KIND_LABEL_KEYS[kind];
  return entityPeekMeta(kind as EntityKind).fallbackTitleKey as TranslationKey;
}

/** Subtitles carry authored prose, so strip any Markdown before showing one inline. */
function subtitleText(hit: SearchHit): string {
  return toSearchSummary(hit.subtitle);
}

/** One rendered section plus the flat keyboard index its rows occupy. */
interface Section {
  kind: SearchKind;
  items: SearchHit[];
  hasMore: boolean;
  offset: number;
}

export function GlobalSearchDialog() {
  const t = useT();
  const isOpen = useGlobalSearchStore((s) => s.isOpen);
  const close = useGlobalSearchStore((s) => s.close);
  const initialQuery = useGlobalSearchStore((s) => s.initialQuery);
  const initialKind = useGlobalSearchStore((s) => s.initialKind);

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<SearchKind | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Guards against an earlier, slower request overwriting a later one's results.
  const requestId = useRef(0);

  // Every invocation starts clean: a palette that remembers last week's query is
  // showing stale answers to a question nobody just asked.
  useEffect(() => {
    if (!isOpen) return;
    setQuery(initialQuery);
    setKind(initialKind);
    setSections([]);
    setFailed(false);
    setActive(0);
    const focus = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(focus);
  }, [initialKind, initialQuery, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setSections([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    setLoading(true);
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      globalSearch(trimmed, kind)
        .then((response) => {
          if (id !== requestId.current) return;
          let offset = 0;
          const next: Section[] = [];
          for (const group of response.groups) {
            if (group.items.length === 0) continue;
            next.push({ kind: group.kind, items: group.items, hasMore: group.hasMore, offset });
            offset += group.items.length;
          }
          setSections(next);
          setFailed(false);
          setActive(0);
          setLoading(false);
        })
        .catch(() => {
          if (id !== requestId.current) return;
          setSections([]);
          setFailed(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isOpen, query, kind]);

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  const openHit = useCallback(
    (hit: SearchHit, fullPage: boolean) => {
      close();
      if ('sessionId' in hit) {
        window.location.hash = `#/chat?session=${encodeURIComponent(hit.sessionId)}`;
      } else if (fullPage) window.location.hash = entityUrl(hit.ref);
      else openEntityPeek({ ref: hit.ref, label: hit.title });
    },
    [close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((prev) => (prev + delta + flat.length) % flat.length);
      return;
    }
    if (e.key === 'Enter') {
      const hit = flat[active];
      if (!hit) return;
      e.preventDefault();
      openHit(hit, e.metaKey || e.ctrlKey);
    }
  };

  // Keep the highlighted row in view while arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pills = useMemo(() => SEARCHABLE_KINDS.map((k) => ({ key: k, label: t(KIND_LABEL_KEYS[k]) })), [t]);

  const trimmed = query.trim();
  return (
    <OverlayFrame
      open={isOpen}
      onClose={close}
      variant="palette"
      ariaLabel={t('search.title')}
      closeDelayMs={150}
      surfaceClassName="max-w-2xl"
    >
      <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-4 py-3">
          <SearchIcon size={16} className="flex-shrink-0 text-fg-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
            aria-label={t('search.title')}
          />
          {loading && <Spinner className="h-4 w-4 flex-shrink-0 text-fg-faint" />}
        </div>

        <div className="flex-shrink-0 border-b border-edge px-4 py-2">
          <FilterPills
            items={pills}
            activeKey={kind}
            onChange={(key) => setKind(key as SearchKind | null)}
            allLabel={t('search.all')}
            toggle
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {!trimmed && <p className="px-4 py-8 text-center text-sm text-fg-faint">{t('search.hint')}</p>}
          {trimmed && failed && <p className="px-4 py-8 text-center text-sm text-danger">{t('search.failed')}</p>}
          {trimmed && !failed && !loading && sections.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-fg-faint">{t('search.noResults', { query: trimmed })}</p>
          )}
          {sections.map((section) => {
            const Icon = section.kind === 'session' ? MessageSquare : entityPeekMeta(section.kind as EntityKind).icon;
            return (
              <section key={section.kind}>
                <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
                  <span>{t(kindLabelKey(section.kind))}</span>
                  {section.hasMore && kind === null && (
                    <button
                      onClick={() => setKind(section.kind)}
                      className="normal-case text-primary-fg hover:text-primary-fg-strong hover:underline"
                    >
                      {t('search.more', { count: section.items.length })}
                    </button>
                  )}
                </div>
                {section.items.map((hit, index) => {
                  const flatIndex = section.offset + index;
                  const isActive = flatIndex === active;
                  return (
                    <button
                      key={
                        'sessionId' in hit
                          ? `${section.kind}-${hit.sessionId}`
                          : `${section.kind}-${entityUrl(hit.ref)}`
                      }
                      data-active={isActive}
                      onMouseEnter={() => setActive(flatIndex)}
                      onClick={(e) => openHit(hit, e.metaKey || e.ctrlKey)}
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                        isActive ? 'bg-surface-muted' : ''
                      }`}
                    >
                      <Icon size={15} className="flex-shrink-0 text-fg-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">{hit.title}</span>
                        {subtitleText(hit) && (
                          <span className="block truncate text-xs text-fg-faint">{subtitleText(hit)}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge px-4 py-2 text-[11px] text-fg-faint">
          <span>↑↓ {t('search.navigate')}</span>
          <span>↵ {t('search.openPeek')}</span>
          <span>⌘↵ {t('search.openPage')}</span>
          <span>esc {t('common.close')}</span>
        </div>
      </div>
    </OverlayFrame>
  );
}
