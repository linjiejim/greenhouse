/**
 * A dashboard of a base (TBL-13): its cards in a grid (small, medium and large spans; one column
 * on a narrow screen), each with what the server worked out for me. Whoever may change it (its
 * owner when personal, builders when shared) adds, edits, copies, moves and deletes cards, and
 * renames or deletes the dashboard; anyone may copy it as a dashboard of their own. Every change
 * saves the whole card list to the view with its revision, one save after another.
 */

import { useCallback, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, LayoutDashboard, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, ConfirmDialog, Empty, ErrorBox, Menu, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Base, BaseTable, Card, CardData, View } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../../app/notify';
import { queryClient } from '../../../data/query';
import { putView, refreshBase, tablesKeys } from '../../../data/tables';
import { useDashboardData } from '../../../data/tables-cards';
import { api } from '../../../lib/api';
import { cx } from '../../../lib/cx';
import { useI18n } from '../../../lib/i18n';
import { navigate } from '../../../lib/router';
import { tablesError } from '../errors';
import { NameDialog } from '../TableTabs';
import { CardBody } from './CardBody';
import { CardEditor } from './CardEditor';
import { blankCard, cardTitle, duplicateCard, moveCard, putCard, restoreCard, sizeOf, withoutCard } from './model';
import { NewDashboardDialog } from './NewDashboardDialog';
import '../../../styles/tables-dashboards.css';

function CardFrame({
  card,
  index,
  count,
  data,
  baseId,
  table,
  editable,
  onEdit,
  onDuplicate,
  onMove,
  onDelete,
}: {
  card: Card;
  index: number;
  count: number;
  data: CardData | undefined;
  baseId: string;
  table: BaseTable | undefined;
  editable: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const title = cardTitle(card, table, t);
  const filters = card.filter?.clauses.length ?? 0;
  const meta = [table?.name, filters ? t('tables.filterCount', { count: filters }) : null].filter(Boolean).join(' · ');
  const items: MenuEntry[] = editable
    ? [
        { label: t('tables.dashboards.editCard'), icon: <Pencil size={icon.md} />, onClick: onEdit },
        { label: t('tables.dashboards.duplicateCard'), icon: <Copy size={icon.md} />, onClick: onDuplicate },
        {
          label: t('tables.dashboards.moveUp'),
          icon: <ArrowUp size={icon.md} />,
          disabled: index === 0,
          onClick: () => onMove(-1),
        },
        {
          label: t('tables.dashboards.moveDown'),
          icon: <ArrowDown size={icon.md} />,
          disabled: index === count - 1,
          onClick: () => onMove(1),
        },
        '-',
        { label: t('tables.dashboards.deleteCard'), icon: <Trash2 size={icon.md} />, danger: true, onClick: onDelete },
      ]
    : [];
  return (
    <section className={cx('app-tb-dash-card', `is-${sizeOf(card)}`)} aria-labelledby={titleId}>
      <header className="app-tb-dash-card-head">
        <div className="app-tb-dash-card-titles">
          <h3 id={titleId} className="app-tb-dash-card-title">
            {title}
          </h3>
          {meta && <p className="app-tb-dash-card-meta">{meta}</p>}
        </div>
        {items.length > 0 && <Menu label={t('tables.dashboards.cardMenu', { name: title })} items={items} />}
      </header>
      <div className="app-tb-dash-card-body">
        <CardBody
          card={card}
          data={data}
          baseId={baseId}
          table={table}
          label={title}
          onEdit={editable ? onEdit : undefined}
        />
      </div>
    </section>
  );
}

export function DashboardView({
  base,
  view,
  narrow,
}: {
  base: Base;
  view: View;
  /** May build the base (shared dashboards are theirs to change; `view.editable` says for this one). */
  canBuild: boolean;
  narrow: boolean;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const editable = view.editable && !base.archived_at;
  const cards = view.config.cards ?? [];
  const data = useDashboardData(base, view);
  const shown = new Map((data.data?.items ?? []).map((item) => [item.id, item.data]));
  const [editing, setEditing] = useState<{ card: Card; isNew: boolean } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copying, setCopying] = useState(false);

  // Changes go one after another, each with the revision the one before left. Quick ones show at
  // once; while several are on their way, only the last puts the server's view back in.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const cachedView = useCallback(
    () => queryClient.getQueryData<Base>(tablesKeys.base(base.id))?.views.find((entry) => entry.id === view.id),
    [base.id, view.id],
  );
  const currentCards = useCallback(() => (cachedView() ?? view).config.cards ?? [], [cachedView, view]);
  const change = useCallback(
    (next: { cards?: Card[]; name?: string }, { optimistic = true } = {}) => {
      if (optimistic) {
        const now = cachedView() ?? view;
        putView(base.id, {
          ...now,
          ...(next.name !== undefined ? { name: next.name } : {}),
          ...(next.cards ? { config: { ...now.config, cards: next.cards } } : {}),
        });
      }
      pending.current += 1;
      const run = saving.current.then(async () => {
        try {
          const latest = cachedView() ?? view;
          const saved = await api.tables.views.update(view.id, {
            revision: latest.revision,
            ...(next.name !== undefined ? { name: next.name } : {}),
            ...(next.cards ? { config: { cards: next.cards } } : {}),
          });
          pending.current -= 1;
          const now = cachedView();
          putView(base.id, pending.current > 0 && now ? { ...now, revision: saved.revision } : saved);
        } catch (error) {
          pending.current -= 1;
          // Someone else's change, or ours refused: the base as it is now.
          void refreshBase(base.id);
          throw error;
        }
      });
      saving.current = run.catch(() => undefined);
      return run;
    },
    [base.id, view, cachedView],
  );
  /** The words for a refused change; a card the server names is named too. */
  const errorOf = (error: unknown, saved: readonly Card[]) => {
    const id = error instanceof ApiClientError ? (error.details as { card?: unknown } | undefined)?.card : undefined;
    const card = saved.find((entry) => entry.id === id);
    if (!card || !(error instanceof ApiClientError)) return tablesError(error, t);
    const table = base.tables.find((entry) => entry.id === card.table_id);
    return t('tables.dashboards.cardRefused', { name: cardTitle(card, table, t), reason: tablesError(error, t) });
  };
  const quick = (next: Card[], done?: () => void) =>
    void change({ cards: next })
      .then(done)
      .catch((error: unknown) => notify(errorOf(error, next)));

  const add = () => {
    const first = base.tables[0];
    if (first) setEditing({ card: blankCard(currentCards(), first.id), isNew: true });
  };
  const remove = (card: Card) => {
    const before = currentCards();
    const index = before.findIndex((entry) => entry.id === card.id);
    const name = cardTitle(
      card,
      base.tables.find((entry) => entry.id === card.table_id),
      t,
    );
    quick(withoutCard(before, card.id), () =>
      notify(t('tables.dashboards.cardDeleted', { name }), {
        label: t('tables.undo'),
        onClick: () => quick(restoreCard(currentCards(), card, index)),
      }),
    );
  };

  const menu: MenuEntry[] = [
    ...(editable
      ? [{ label: t('tables.dashboards.rename'), icon: <Pencil size={icon.md} />, onClick: () => setRenaming(true) }]
      : []),
    ...(!base.archived_at
      ? [
          {
            label: t('tables.dashboards.duplicateDashboard'),
            icon: <Copy size={icon.md} />,
            onClick: () => setCopying(true),
          },
        ]
      : []),
    ...(editable
      ? [
          '-' as const,
          {
            label: t('tables.dashboards.delete'),
            icon: <Trash2 size={icon.md} />,
            danger: true,
            onClick: () => setDeleting(true),
          },
        ]
      : []),
  ];
  /** 添加卡片: in the bar above the cards, or as the empty dashboard's one action. */
  const addButton = (size: 'sm' | 'md') => (
    <Button size={size} disabled={!base.tables.length} disabledReason={t('tables.noTables')} onClick={add}>
      <Plus size={icon.sm} strokeWidth={icon.stroke} />
      {t('tables.dashboards.addCard')}
    </Button>
  );

  return (
    <div className={cx('app-tb-dash', narrow && 'is-narrow')}>
      <div className="app-tb-dash-bar">
        {view.personal && <Badge>{t('tables.personal')}</Badge>}
        <span className="app-tb-dash-spacer" />
        {editable && cards.length > 0 && addButton('sm')}
        {menu.length > 0 && <Menu label={t('tables.dashboards.menu')} items={menu} />}
      </div>
      {!cards.length ? (
        <Empty
          icon={<LayoutDashboard strokeWidth={icon.stroke} />}
          title={t('tables.dashboards.none')}
          action={editable ? addButton('md') : undefined}
        />
      ) : data.isError && !data.data ? (
        <ErrorBox onRetry={() => void data.refetch()}>
          {t('tables.dashboards.loadFailed')} · {tablesError(data.error, t)}
        </ErrorBox>
      ) : (
        <div className="app-tb-dash-grid">
          {cards.map((card, index) => (
            <CardFrame
              key={card.id}
              card={card}
              index={index}
              count={cards.length}
              data={shown.get(card.id)}
              baseId={base.id}
              table={base.tables.find((entry) => entry.id === card.table_id)}
              editable={editable}
              onEdit={() => setEditing({ card, isNew: false })}
              onDuplicate={() =>
                quick(duplicateCard(currentCards(), card.id, (name) => t('tables.copyName', { name })))
              }
              onMove={(by) => quick(moveCard(currentCards(), card.id, by))}
              onDelete={() => remove(card)}
            />
          ))}
        </div>
      )}
      {editing && (
        <CardEditor
          base={base}
          card={editing.card}
          isNew={editing.isNew}
          onSave={async (card) => {
            const next = putCard(currentCards(), card);
            try {
              await change({ cards: next }, { optimistic: false });
              return null;
            } catch (error) {
              return errorOf(error, withoutCard(next, card.id));
            }
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {renaming && (
        <NameDialog
          title={t('tables.dashboards.rename')}
          label={t('tables.dashboards.name')}
          initial={view.name}
          submit={t('tables.save')}
          onClose={() => setRenaming(false)}
          onSave={async (name) => {
            await change({ name }, { optimistic: false });
            void refreshBase(base.id);
          }}
        />
      )}
      {copying && (
        <NewDashboardDialog
          base={base}
          name={t('tables.copyName', { name: view.name })}
          cards={cards}
          onClose={() => setCopying(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('tables.dashboards.deleteTitle', { name: view.name })}
          confirmLabel={t('tables.dashboards.delete')}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void api.tables.views
              .remove(view.id)
              .then(async () => {
                await refreshBase(base.id);
                navigate({ page: 'base', id: base.id }, { replace: true });
                notify(t('tables.dashboards.deleted', { name: view.name }));
              })
              .catch((error: unknown) => notify(tablesError(error, t)));
          }}
        >
          {t('tables.dashboards.deleteBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}
