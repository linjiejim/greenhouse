/**
 * The Pages tab: the page list, the selected page's canvas, and the
 * properties of the selected card (or of the page, when no card is
 * selected). Three columns from `lg`; below it the list is a strip above the
 * canvas and the properties open in a dialog, so the builder works on a
 * phone too.
 */

import { useEffect, useState } from 'react';
import type { AppCardKind, AppSpec, AppSpecError } from '@greenhouse/types/apps';
import { Button, Dialog, IconButton, toast } from '../../../components/ui';
import { useT } from '../../../lib/i18n';
import { Settings, X } from '../../../lib/icons';
import { PageCanvas } from './canvas';
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

/** Tailwind's `lg`: three columns from here. */
const WIDE_QUERY = '(min-width: 1024px)';

/** Tailwind's `md`: below it the canvas is one column (the shared grid's own breakpoint). */
const GRID_QUERY = '(min-width: 768px)';

function useMinWidth(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
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
  const wide = useMinWidth(WIDE_QUERY);
  const grid = useMinWidth(GRID_QUERY);
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
            if (!wide) setPageSettings(true);
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
        narrow={!grid}
      />
    </div>
  );

  return (
    <>
      {wide ? (
        <div
          className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)_24rem] gap-4"
          data-testid="app-builder-pages"
        >
          <aside className="min-h-0 overflow-y-auto">{list}</aside>
          <section className="min-h-0 overflow-y-auto pb-6">{canvas}</section>
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
                <IconButton
                  label={t('apps.builder.props.close')}
                  onClick={() => onSelect({ pageId: page.id, cardId: null })}
                >
                  <X size={13} />
                </IconButton>
              )}
            </div>
            {properties}
          </aside>
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
    </>
  );
}
