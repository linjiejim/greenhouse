/**
 * The canvas of one page: its cards on the shared `WidgetGrid` (drag a card
 * by its title, resize from its corner — saved only when a person moved
 * something), each drawn as a schematic of what it will show: its kind, its
 * table, the fields, the buttons and how many problems the server found.
 * Live data is what "Preview" is for — the canvas never reads records.
 *
 * Below 768px the grid is one column and does not drag; each card's menu
 * moves it earlier / later instead.
 */

import { useState } from 'react';
import type { AppCard, AppPage, AppSpecError } from '@greenhouse/types/apps';
import { TableCardFrame } from '../../../components/table-cards';
import { WidgetGrid, type WidgetGridItem } from '../../../components/workbench/widget-grid';
import { Button, ConfirmDialog, IconButton, Tag } from '../../../components/ui';
import { ContextMenu, useContextMenu } from '../../../components/app/context-menu';
import { useT } from '../../../lib/i18n';
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Trash2 } from '../../../lib/icons';
import { CARD_KIND_ICONS } from './card-catalog';
import { cardErrors } from './spec-errors';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../components/tables/field-types';
import { cardTableId, fieldsOf, isEmbedded, isRecordsLike, tableName, type BuilderSchema } from './spec-model';

/** Cards in reading order (the order a narrow screen shows them). */
export function readingOrder(cards: readonly AppCard[]): AppCard[] {
  return [...cards].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
}

/** Swap a card's place with its neighbour in reading order (keyboard and phone reordering). */
export function swapWithNeighbour(cards: readonly AppCard[], cardId: string, by: -1 | 1) {
  const ordered = readingOrder(cards);
  const index = ordered.findIndex((card) => card.id === cardId);
  const other = ordered[index + by];
  const card = ordered[index];
  if (!card || !other) return null;
  return [
    { id: card.id, ...other.layout },
    { id: other.id, ...card.layout },
  ];
}

function CardSummary({ card, schema }: { card: AppCard; schema: BuilderSchema }) {
  const t = useT();
  const tableId = cardTableId(card);
  const fields = fieldsOf(schema, tableId);
  const named = (ids: readonly number[]) =>
    ids.map((id) => fields.find((field) => field.id === id)?.name ?? `#${id}`).join(', ');
  const table = tableId !== undefined ? tableName(schema, tableId) : undefined;
  const lines: string[] = [];
  if (tableId !== undefined) {
    lines.push(
      table ? t('apps.builder.canvas.table', { name: table }) : t('apps.builder.canvas.missingTable', { id: tableId }),
    );
  }
  if (isEmbedded(card) && card.card.aggregate) {
    const { operation, groupBy } = card.card.aggregate;
    const what = t(`tables.aggregationType.${operation}`);
    const by = groupBy?.systemField
      ? t(SYSTEM_FIELD_LABEL_KEYS[groupBy.systemField])
      : groupBy?.fieldId !== undefined
        ? named([groupBy.fieldId])
        : undefined;
    lines.push(
      by
        ? t('apps.builder.canvas.aggregateBy', { operation: what, group: by })
        : t('apps.builder.canvas.aggregate', { operation: what }),
    );
  }
  if (isRecordsLike(card) || card.kind === 'form') {
    lines.push(
      card.fieldIds.length > 0
        ? t('apps.builder.canvas.fields', { fields: named(card.fieldIds) })
        : t('apps.builder.canvas.noFields'),
    );
  }
  if (isRecordsLike(card)) {
    const actions = [...(card.actions ?? []), ...(card.detail?.actions ?? [])];
    if (actions.length > 0)
      lines.push(t('apps.builder.canvas.actions', { names: actions.map((action) => action.label).join(', ') }));
    if (card.kind === 'records' && card.create) lines.push(t('apps.builder.canvas.creates'));
  }
  if (card.kind === 'text') {
    lines.push(
      card.markdown.trim() ? card.markdown.trim().split('\n')[0]!.slice(0, 120) : t('apps.builder.canvas.emptyText'),
    );
  }
  if (card.kind === 'buttons') {
    lines.push(t('apps.builder.canvas.buttons', { labels: card.buttons.map((button) => button.label).join(', ') }));
  }
  return (
    <ul className="space-y-1 text-xs text-fg-muted">
      {lines.map((line, index) => (
        <li key={index} className="truncate" title={line}>
          {line}
        </li>
      ))}
    </ul>
  );
}

export function PageCanvas({
  page,
  schema,
  errors,
  selectedCardId,
  onSelect,
  onLayout,
  onRemove,
  onAdd,
  narrow = false,
}: {
  page: AppPage;
  schema: BuilderSchema;
  errors: readonly AppSpecError[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
  onLayout: (layouts: Array<{ id: string; x: number; y: number; w: number; h: number }>) => void;
  onRemove: (cardId: string) => void;
  onAdd: () => void;
  /** One column (below 768px): nothing drags, the card menu moves cards. */
  narrow?: boolean;
}) {
  const t = useT();
  const { menu, openMenu, closeMenu } = useContextMenu();
  const [removing, setRemoving] = useState<AppCard | null>(null);
  const items: WidgetGridItem[] = page.cards.map((card) => ({
    id: card.id,
    ...card.layout,
    minW: 2,
    minH: 2,
    mobileH: Math.min(card.layout.h, 4),
  }));
  const kindName = (card: AppCard) => t(`apps.builder.catalog.kinds.${card.kind}.name`);
  const titleOf = (card: AppCard) => card.title || t('apps.builder.canvas.untitled', { kind: kindName(card) });
  const lastCard = page.cards.length <= 1;

  const render = (id: string) => {
    const card = page.cards.find((entry) => entry.id === id);
    if (!card) return null;
    const Icon = CARD_KIND_ICONS[card.kind];
    const problems = cardErrors(errors, page.id, card.id).length;
    const selected = card.id === selectedCardId;
    const move = (by: -1 | 1) => {
      const swapped = swapWithNeighbour(page.cards, card.id, by);
      if (swapped) onLayout(swapped);
    };
    return (
      <div
        className={`h-full rounded-xl ${selected ? 'ring-2 ring-primary-500' : ''}`}
        onClick={() => onSelect(card.id)}
        data-testid={`app-canvas-card-${card.id}`}
        data-selected={selected || undefined}
      >
        <TableCardFrame
          title={titleOf(card)}
          draggable
          actions={
            <span className="flex items-center" onClick={(event) => event.stopPropagation()}>
              <IconButton
                size="compact"
                label={t('apps.builder.canvas.cardActions', { title: titleOf(card) })}
                onClick={(event) =>
                  openMenu(event, [
                    { label: t('apps.builder.canvas.moveUp'), icon: ArrowUp, onClick: () => move(-1) },
                    { label: t('apps.builder.canvas.moveDown'), icon: ArrowDown, onClick: () => move(1) },
                    ...(lastCard
                      ? []
                      : [
                          {
                            label: t('apps.builder.canvas.remove'),
                            icon: Trash2,
                            danger: true,
                            onClick: () => setRemoving(card),
                          },
                        ]),
                  ])
                }
              >
                <MoreHorizontal size={13} />
              </IconButton>
            </span>
          }
        >
          <button
            type="button"
            className="flex h-full w-full flex-col items-start gap-2 text-left focus:outline-none"
            aria-pressed={selected}
            aria-label={t('apps.builder.canvas.select', { title: titleOf(card) })}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(card.id);
            }}
          >
            <span className="flex items-center gap-1.5">
              <Tag tone="neutral" icon={<Icon size={11} />}>
                {kindName(card)}
              </Tag>
              {problems > 0 && <Tag tone="danger">{t('apps.builder.canvas.problems', { count: problems })}</Tag>}
            </span>
            <CardSummary card={card} schema={schema} />
          </button>
        </TableCardFrame>
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid="app-canvas">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-faint">
          {narrow ? t('apps.builder.canvas.hintNarrow') : t('apps.builder.canvas.hint')}
        </p>
        <Button size="sm" onClick={onAdd} data-testid="app-add-card">
          <Plus size={13} className="mr-1.5" />
          {t('apps.builder.canvas.addCard')}
        </Button>
      </div>
      <WidgetGrid
        // A page change is a different arrangement; the grid starts over.
        key={page.id}
        items={items}
        renderItem={render}
        editing
        onLayoutChange={(next) => onLayout(next.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })))}
      />
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) onRemove(removing.id);
          setRemoving(null);
        }}
        title={t('apps.builder.canvas.removeTitle', { title: removing ? titleOf(removing) : '' })}
        description={t('apps.builder.canvas.removeDescription')}
        confirmLabel={t('apps.builder.canvas.remove')}
        confirmVariant="destructive"
      />
    </div>
  );
}
