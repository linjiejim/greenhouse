/**
 * The Pages tab: the page list, the selected page's canvas, and the
 * properties of the selected card (or of the page, when no card is
 * selected). The columns are chosen from the tab's own measured width (the
 * app sidebar takes a varying share of the window) so the canvas keeps room
 * to drag and resize (`CANVAS_SINGLE_COLUMN_BELOW`): three columns when the
 * list, the canvas and the properties all fit; then the list as a strip above
 * the canvas with the properties beside it; then the properties in a dialog,
 * so the builder works on a phone too.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { AppCardKind, AppSpec, AppSpecError } from '@greenhouse/types/apps';
import { Button, Dialog, IconButton, toast } from '../../../components/ui';
import { useT } from '../../../lib/i18n';
import { Settings, X } from '../../../lib/icons';
import { CANVAS_SINGLE_COLUMN_BELOW, PageCanvas } from './canvas';
import { CardCatalog, CARD_KIND_ICONS } from './card-catalog';
import { PageList } from './page-list';
import { PageProperties } from './page-properties';
import { CardProperties } from './properties/card-properties';
import {
  addCard,
  addPage,
  cardTableId,
  defaultCard,
  deletePage,
  movePage,
  newCardId,
  nextCardLayout,
  removeCard,
  setCardLayouts,
  setHome,
  updateCard,
} from './spec-model';
import type { BuilderBase } from './use-builder-schema';

/** The page list column (13rem), the properties column (24rem) and the gap between columns (1rem). */
const LIST_WIDTH = 208;
const PROPERTIES_WIDTH = 384;
const COLUMN_GAP = 16;

export type PagesTabLayout = 'columns' | 'beside' | 'stacked';

/**
 * How the tab lays out at `width` (its own, measured): everything side by side
 * only while the canvas keeps its grid width. Unmeasured (0) is the desktop layout.
 */
export function pagesTabLayout(width: number): PagesTabLayout {
  if (width <= 0 || width >= LIST_WIDTH + PROPERTIES_WIDTH + 2 * COLUMN_GAP + CANVAS_SINGLE_COLUMN_BELOW) {
    return 'columns';
  }
  if (width >= PROPERTIES_WIDTH + COLUMN_GAP + CANVAS_SINGLE_COLUMN_BELOW) return 'beside';
  return 'stacked';
}

/** The element's width, measured before paint (so the first frame already has its layout). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? element.clientWidth;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export interface BuilderSelection {
  pageId: string;
  cardId: string | null;
}

export function PagesTab({
  spec,
  base,
  errors,
  edit,
  selection,
  onSelect,
}: {
  spec: AppSpec;
  base: BuilderBase;
  errors: readonly AppSpecError[];
  edit: (change: (spec: AppSpec) => AppSpec) => void;
  selection: BuilderSelection;
  onSelect: (next: BuilderSelection) => void;
}) {
  const t = useT();
  const measured = useWidth();
  const layout = pagesTabLayout(measured.width);
  const wide = layout === 'columns';
  const propertiesBeside = layout !== 'stacked';
  const [catalog, setCatalog] = useState(false);
  const [pageSettings, setPageSettings] = useState(false);
  const page = spec.pages.find((entry) => entry.id === selection.pageId) ?? spec.pages[0]!;
  const card = selection.cardId ? page.cards.find((entry) => entry.id === selection.cardId) : undefined;
  const { schema, users } = base;

  const addCardOfKind = (kind: AppCardKind) => {
    setCatalog(false);
    // A new card starts on the table the builder is working with (the selected card's), if it fits.
    const preferred = card ? cardTableId(card) : undefined;
    const created = defaultCard(kind, {
      schema,
      id: newCardId(page, kind),
      layout: nextCardLayout(page.cards, kind),
      tableId: preferred,
      pageId: page.id,
      buttonLabel: t('apps.builder.catalog.defaultButton'),
    });
    if (!created) return toast(t('apps.builder.catalog.cannotAdd'), 'error');
    edit((current) => addCard(current, page.id, created));
    onSelect({ pageId: page.id, cardId: created.id });
  };

  const properties = card ? (
    <CardProperties
      key={`${page.id}/${card.id}`}
      spec={spec}
      page={page}
      card={card}
      schema={schema}
      users={users}
      errors={errors}
      onChange={(next) => edit((current) => updateCard(current, page.id, card.id, () => next))}
    />
  ) : (
    <PageProperties spec={spec} pageId={page.id} schema={schema} errors={errors} edit={edit} />
  );
  const propertiesTitle = card
    ? t('apps.builder.props.kindTitle', { kind: t(`apps.builder.catalog.kinds.${card.kind}.name`) })
    : t('apps.builder.pages.settings');
  const KindIcon = card ? CARD_KIND_ICONS[card.kind] : Settings;

  const list = (
    <PageList
      spec={spec}
      errors={errors}
      selectedPageId={page.id}
      layout={wide ? 'column' : 'strip'}
      onSelect={(pageId) => onSelect({ pageId, cardId: null })}
      onAdd={() => {
        let created = '';
        edit((current) => {
          const result = addPage(current, t('apps.builder.pages.newTitle'));
          created = result.pageId;
          return result.spec;
        });
        if (created) onSelect({ pageId: created, cardId: null });
      }}
      onMove={(pageId, toIndex) => edit((current) => movePage(current, pageId, toIndex))}
      onSetHome={(pageId) => edit((current) => setHome(current, pageId))}
      onDelete={(pageId) => {
        edit((current) => deletePage(current, pageId));
        const next = spec.pages.find((entry) => entry.id !== pageId);
        if (next) onSelect({ pageId: next.id, cardId: null });
      }}
    />
  );

  const canvas = (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-semibold text-fg" title={page.title}>
          {page.title}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSelect({ pageId: page.id, cardId: null });
            if (!propertiesBeside) setPageSettings(true);
          }}
          data-testid="app-page-settings"
        >
          <Settings size={13} className="mr-1.5" />
          {t('apps.builder.pages.settings')}
        </Button>
      </div>
      <PageCanvas
        page={page}
        schema={schema}
        errors={errors}
        selectedCardId={card?.id ?? null}
        onSelect={(cardId) => onSelect({ pageId: page.id, cardId })}
        onLayout={(layouts) => edit((current) => setCardLayouts(current, page.id, layouts))}
        onRemove={(cardId) => {
          edit((current) => removeCard(current, page.id, cardId));
          if (selection.cardId === cardId) onSelect({ pageId: page.id, cardId: null });
        }}
        onAdd={() => setCatalog(true)}
      />
    </div>
  );

  const propertiesPanel = (
    <aside
      className="min-h-0 overflow-y-auto rounded-xl border border-edge bg-surface-raised p-4"
      aria-label={propertiesTitle}
      data-testid="app-properties"
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
          <KindIcon size={14} className="flex-shrink-0 text-fg-muted" />
          <span className="truncate">{propertiesTitle}</span>
        </h3>
        {card && (
          <IconButton label={t('apps.builder.props.close')} onClick={() => onSelect({ pageId: page.id, cardId: null })}>
            <X size={13} />
          </IconButton>
        )}
      </div>
      {properties}
    </aside>
  );

  return (
    // Side by side, the columns scroll themselves; stacked, the tab scrolls as one.
    <div
      ref={measured.ref}
      className={`min-h-0 flex-1 ${layout === 'stacked' ? 'overflow-y-auto' : 'flex flex-col'}`}
      data-layout={layout}
    >
      {layout === 'columns' ? (
        <div
          className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)_24rem] gap-4"
          data-testid="app-builder-pages"
        >
          <aside className="min-h-0 overflow-y-auto">{list}</aside>
          <section className="min-h-0 overflow-y-auto pb-6">{canvas}</section>
          {propertiesPanel}
        </div>
      ) : layout === 'beside' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="app-builder-pages">
          {list}
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_24rem] gap-4">
            <section className="min-h-0 overflow-y-auto pb-6">{canvas}</section>
            {propertiesPanel}
          </div>
        </div>
      ) : (
        <div className="space-y-3" data-testid="app-builder-pages">
          {list}
          {canvas}
          <Dialog
            open={card !== undefined || pageSettings}
            onClose={() => {
              setPageSettings(false);
              onSelect({ pageId: page.id, cardId: null });
            }}
            title={propertiesTitle}
            size="lg"
          >
            <div data-testid="app-properties">{properties}</div>
          </Dialog>
        </div>
      )}
      <CardCatalog open={catalog} onClose={() => setCatalog(false)} onPick={addCardOfKind} schema={schema} />
    </div>
  );
}
