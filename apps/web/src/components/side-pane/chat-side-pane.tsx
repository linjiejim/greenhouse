/**
 * The right-hand column itself.
 *
 * Unlike `<Drawer>` — which is a `fixed inset-0` overlay and therefore cannot
 * be a split — this lives in the document flow next to the conversation, so
 * both columns are usable at once. That is the entire reason it exists.
 *
 * Below `lg` it degrades to a full-screen overlay: a 375px phone has no second
 * column to give, and half of one is worse than either whole thing.
 */

import React, { Suspense, useEffect, useState } from 'react';
import { entityUrl, type EntityKind } from '@greenhouse/types/entity-links';
import { onEntityChanged, type EntityDomain } from '../../lib/entity-sync';
import { ErrorBoundary, IconButton, ResizeHandle, Spinner } from '../ui';
import { ArrowLeft, ExternalLink, Maximize2, Minimize2, PanelRightOpen, X } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { EntityPeekScope } from '../entity-peek/context';
import {
  maxSidePaneWidth,
  SIDE_PANE_MIN_WIDTH,
  useSidePaneStore,
  type SidePaneEntry,
} from '../../stores/side-pane-store';
import { renderSidePaneBody, sidePaneChrome } from './registry';
import { SidePaneHeaderSlotProvider } from './header-slot';

/** Tailwind's `lg` breakpoint, as a number for the matchMedia query. */
const SPLIT_MIN_VIEWPORT = 1024;

/** Which mutation domain would make the open entry stale. */
const KIND_DOMAIN: Record<EntityKind, EntityDomain> = {
  project: 'project',
  kb_doc: 'knowledge',
  tables_record: 'tables',
};

/**
 * Re-read the open record after a chat turn writes to its domain.
 *
 * Implemented as a remount key rather than a refetch call: the pane reuses the
 * full detail screens, which own their own loading. Changing their key is the
 * only handle the pane has on them, and it costs one fetch on a panel the user
 * is looking at.
 */
function useEntityRefresh(entry: SidePaneEntry | undefined): number {
  const [revision, setRevision] = useState(0);
  const domain = entry?.kind === 'entity' ? KIND_DOMAIN[entry.ref.kind] : null;
  useEffect(() => {
    if (!domain) return;
    return onEntityChanged((changed) => {
      if (changed === domain) setRevision((value) => value + 1);
    });
  }, [domain]);
  return revision;
}

function useIsSplitCapable(): boolean {
  const [capable, setCapable] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= SPLIT_MIN_VIEWPORT,
  );
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${SPLIT_MIN_VIEWPORT}px)`);
    const sync = () => setCapable(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return capable;
}

/**
 * Declares to the Markdown click delegate that a pane exists on this screen.
 *
 * Without this the delegate cannot tell Chat from the Assistant overlay, and an
 * entity link in the overlay would open a pane nobody is rendering.
 */
export function useSidePaneHost(resetKey: string): void {
  const setHostMounted = useSidePaneStore((s) => s.setHostMounted);
  const close = useSidePaneStore((s) => s.close);
  useEffect(() => {
    // A preview belongs to the conversation that opened it. A newly selected
    // session starts with the full-width chat the user asked for.
    close();
    setHostMounted(true);
    return () => setHostMounted(false);
  }, [close, resetKey, setHostMounted]);
}

export function ChatSidePane() {
  const t = useT();
  const stack = useSidePaneStore((s) => s.stack);
  const isOpen = useSidePaneStore((s) => s.isOpen);
  const width = useSidePaneStore((s) => s.width);
  const setWidth = useSidePaneStore((s) => s.setWidth);
  const back = useSidePaneStore((s) => s.back);
  const collapse = useSidePaneStore((s) => s.collapse);
  const close = useSidePaneStore((s) => s.close);
  const isFullscreen = useSidePaneStore((s) => s.isFullscreen);
  const setFullscreen = useSidePaneStore((s) => s.setFullscreen);
  const splitCapable = useIsSplitCapable();
  const entry = stack[stack.length - 1];
  // Hooks must run unconditionally, so these sit above the early return.
  const refreshRevision = useEntityRefresh(entry);
  // State, not a ref: the body renders into this element through a portal and
  // has to re-render once it exists.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  // Escape leaves full screen rather than closing: the pane covers the whole
  // window there, so the reflex is "get me back", not "throw this away".
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen, setFullscreen]);

  if (!isOpen) return null;

  // Below `lg` the pane is already an overlay, so the toggle would be a button
  // that changes nothing.
  const overlay = !splitCapable || isFullscreen;

  if (!entry) {
    const emptyHeader = (
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
        <PanelRightOpen size={14} className="flex-shrink-0 text-fg-muted" />
        <span className="flex-1 truncate text-sm font-medium text-fg">{t('sidePane.title')}</span>
        <IconButton label={t('sidePane.collapse')} onClick={collapse} size="compact">
          <X size={16} />
        </IconButton>
      </div>
    );
    const emptyContent = (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <PanelRightOpen size={24} className="text-fg-faint" />
        <p className="text-sm font-medium text-fg">{t('sidePane.emptyTitle')}</p>
        <p className="max-w-72 text-xs leading-relaxed text-fg-muted">{t('sidePane.emptyDescription')}</p>
      </div>
    );

    if (overlay) {
      return (
        <div className="fixed inset-0 z-40 flex flex-col bg-surface-canvas safe-area-panel">
          {emptyHeader}
          {emptyContent}
        </div>
      );
    }

    return (
      <>
        <ResizeHandle
          orientation="vertical"
          value={width}
          min={SIDE_PANE_MIN_WIDTH}
          max={maxSidePaneWidth(window.innerWidth)}
          direction={-1}
          onChange={setWidth}
          label={t('sidePane.resize')}
        />
        <aside
          className="flex h-full min-h-0 flex-shrink-0 flex-col border-l border-edge bg-surface-raised"
          style={{ width }}
          aria-label={t('sidePane.title')}
        >
          {emptyHeader}
          {emptyContent}
        </aside>
      </>
    );
  }

  const chrome = sidePaneChrome(entry);
  const Icon = chrome.icon;
  const body = renderSidePaneBody(entry);
  // Only records have a permanent address; a preview is not a page.
  const fullPageUrl = entry.kind === 'entity' ? entityUrl(entry.ref) : null;
  // Identity for the boundary/Suspense reset: a new subject must not inherit
  // the previous one's error state. The revision suffix is what makes a
  // conversational edit show up here without a page refresh.
  const bodyKey = `${fullPageUrl ?? `${entry.kind}:${stack.length}`}#${refreshRevision}`;

  const header = (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
      {stack.length > 1 && (
        <IconButton label={t('common.back')} onClick={back} size="compact">
          <ArrowLeft size={14} />
        </IconButton>
      )}
      <Icon size={14} className="flex-shrink-0 text-fg-muted" />
      <span className="flex-1 truncate text-sm font-medium text-fg" title={chrome.title || undefined}>
        {chrome.title || t(chrome.fallbackTitleKey)}
      </span>
      {fullPageUrl && (
        <IconButton
          label={t('entityPeek.openFullPage')}
          onClick={() => {
            close();
            window.location.hash = fullPageUrl;
          }}
          size="compact"
        >
          <ExternalLink size={14} />
        </IconButton>
      )}
      {/* The body's own controls land here — see ./header-slot. */}
      <div ref={setHeaderSlot} className="flex flex-shrink-0 items-center gap-0.5" />
      {splitCapable && (
        <IconButton
          label={isFullscreen ? t('sidePane.exitFullscreen') : t('sidePane.fullscreen')}
          onClick={() => setFullscreen(!isFullscreen)}
          size="compact"
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
      )}
      <IconButton label={t('sidePane.collapse')} onClick={collapse} size="compact">
        <X size={16} />
      </IconButton>
    </div>
  );

  const content = (
    <div className="min-h-0 flex-1 overflow-hidden">
      {/* A detail screen that throws must not take the conversation with it —
          the record may be gone, or the model may have invented it. */}
      <ErrorBoundary key={bodyKey}>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner className="h-5 w-5 text-fg-faint" />
            </div>
          }
        >
          {/* Detail components check this to hide "back to list" and to push
              drill-downs onto the stack instead of navigating the page away. */}
          <EntityPeekScope>
            <SidePaneHeaderSlotProvider value={headerSlot}>
              {body ?? <div className="p-6 text-sm text-fg-muted">{t('entityPeek.noPreview')}</div>}
            </SidePaneHeaderSlotProvider>
          </EntityPeekScope>
        </Suspense>
      </ErrorBoundary>
    </div>
  );

  if (overlay) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-surface-canvas safe-area-panel">
        {header}
        {content}
      </div>
    );
  }

  return (
    <>
      <ResizeHandle
        orientation="vertical"
        value={width}
        min={SIDE_PANE_MIN_WIDTH}
        max={maxSidePaneWidth(window.innerWidth)}
        // The pane is on the right, so it grows as the pointer moves left.
        direction={-1}
        onChange={setWidth}
        label={t('sidePane.resize')}
      />
      <aside
        className="flex h-full min-h-0 flex-shrink-0 flex-col border-l border-edge bg-surface-raised"
        style={{ width }}
        aria-label={t('sidePane.title')}
      >
        {header}
        {content}
      </aside>
    </>
  );
}
