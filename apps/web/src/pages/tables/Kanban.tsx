/**
 * 看板 (TBL-03): a column per option of a single select, or per member of a single member field,
 * after 「（无）」 for records without one. A card opens its record on a click or Enter; editors
 * drag cards between columns, move them from the card's "⋯" (keyboard and touch) and add a record
 * at the bottom of a column. Also the card pieces the gallery and the calendar share.
 */

import '../../styles/tables-boards.css';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Plus, SquareKanban } from 'lucide-react';
import { Button, Empty, Menu, type MenuItem } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Field, TableRecord } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { MemberAvatar } from '../../shell/MemberAvatar';
import { CellValue, OptionChip } from './cells';
import { tablesError } from './errors';
import { titleOf, type CellLookups } from './model';
import {
  KANBAN_PAGE,
  cardFields,
  firstKanbanField,
  hasValue,
  kanbanColumns,
  kanbanField,
  moreCount,
  moveToColumn,
  newInColumn,
  visibleColumns,
  type KanbanColumn,
} from './boards-model';
import type { ViewProps } from './types';

// ── Shared by the board views ───────────────────────────

/** A click on a card (not on a link, button or menu inside it), or Enter on the card itself, opens it. */
export function cardOpeners(open: () => void) {
  return {
    onClick(event: MouseEvent<HTMLElement>) {
      const control = (event.target as Element).closest('a, button, input, [role="menu"], [role="dialog"]');
      if (control && control !== event.currentTarget && event.currentTarget.contains(control)) return;
      // Selecting text on a card is not a click on it.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
      open();
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== 'Enter' || event.target !== event.currentTarget) return;
      event.preventDefault();
      open();
    },
  };
}

/** The values under a card's title; empty ones are left out, a ticked checkbox shows its field's name. */
export function CardFields({
  record,
  fields,
  lookups,
}: {
  record: TableRecord;
  fields: readonly Field[];
  lookups: CellLookups;
}) {
  const shown = fields.filter((field) => hasValue(field, record.values[field.id]));
  if (!shown.length) return null;
  return (
    <div className="app-tb-kb-fields">
      {shown.map((field) => (
        <div key={field.id} className="app-tb-kb-field">
          {field.type !== 'checkbox' && <span className="app-sr-only">{field.name}</span>}
          <CellValue field={field} value={record.values[field.id]} lookups={lookups} />
          {field.type === 'checkbox' && <span className="app-tb-kb-flag">{field.name}</span>}
        </div>
      ))}
    </div>
  );
}

/** What a view lacks to show anything, with the one step that fixes it for a builder. */
export function ViewNeeds({
  glyph,
  title,
  canBuild,
  onSetUp,
  onAddField,
}: {
  glyph: ReactNode;
  title: string;
  canBuild: boolean;
  /** Uses the first field that fits; absent when the table has none. */
  onSetUp?: () => void;
  onAddField: () => void;
}) {
  const { t } = useI18n();
  return (
    <Empty
      icon={glyph}
      title={title}
      action={
        canBuild ? (
          <Button onClick={onSetUp ?? onAddField}>{t(onSetUp ? 'tables.viewNeedsAction' : 'tables.fields.add')}</Button>
        ) : undefined
      }
    />
  );
}

/** No records yet (an editor can add one), or none that match the view's filter (with the way back); as the grid. */
export function NoRecords({
  config,
  canEdit,
  onConfig,
  onCreate,
  onOpen,
}: Pick<ViewProps, 'config' | 'canEdit' | 'onConfig' | 'onCreate' | 'onOpen'>) {
  const { t } = useI18n();
  if (config.filter?.clauses.length) {
    const { filter: _filter, ...unfiltered } = config;
    return (
      <Empty
        title={t('tables.grid.noMatch')}
        action={<Button onClick={() => onConfig(unfiltered)}>{t('tables.grid.clearFilters')}</Button>}
      />
    );
  }
  return (
    <Empty
      title={t('tables.grid.noRecords')}
      action={
        canEdit ? (
          <Button kind="primary" onClick={() => void onCreate({}).then((made) => made && onOpen(made.id))}>
            {t('tables.addRecord')}
          </Button>
        ) : undefined
      }
    />
  );
}

// ── Kanban ──────────────────────────────────────────────

export function KanbanView(props: ViewProps) {
  const { t } = useI18n();
  const field = kanbanField(props.fields, props.config);
  if (field) return <Board {...props} field={field} />;
  const candidate = firstKanbanField(props.fields);
  return (
    <ViewNeeds
      glyph={<SquareKanban strokeWidth={icon.stroke} />}
      title={t('tables.viewNeeds.kanban')}
      canBuild={props.canBuild}
      onSetUp={
        candidate &&
        (() => props.onConfig({ ...props.config, kanban: { ...props.config.kanban, field: candidate.id } }))
      }
      onAddField={() => props.onEditField()}
    />
  );
}

interface Target {
  key: string;
  name: string;
}

/** What a card asks of its board. Stable, so cards skip rendering while a drag crosses columns. */
interface CardActions {
  open(id: string): void;
  /** From the card's menu: the card keeps the focus in its new column. */
  move(record: TableRecord, key: string): void;
  dragStart(event: DragEvent<HTMLElement>, record: TableRecord, from: string, name: string): void;
  dragEnd(): void;
  drop(id: string, key: string): void;
}

function Board(props: ViewProps & { field: Field }) {
  const { field, fields, config, data, lookups, canEdit, narrow, onCreate, onOpen } = props;
  const { t } = useI18n();
  const notify = useNotify();
  const members = lookups.members;
  const columns = useMemo(
    () => kanbanColumns(field, data.items, (id) => members.get(id)?.name),
    [field, data.items, members],
  );
  const shown = visibleColumns(columns, !!config.kanban?.hide_empty, narrow);
  const extra = useMemo(() => cardFields(fields, config, [field.id]), [fields, config, field.id]);
  // Keyed by the columns there are, not their records: editing a record leaves the other cards alone.
  const columnKeys = columns.map((column) => column.key).join('\n');
  /** Every column, hidden empty ones too: a card can move to any of them from its menu. */
  const targets = useMemo<Target[]>(
    () =>
      columnKeys.split('\n').map((key) => ({
        key,
        name: !key
          ? t('tables.kanban.empty')
          : field.type === 'single_select'
            ? (field.config.options?.find((option) => option.id === key)?.label ?? '')
            : (members.get(key)?.name ?? t('tables.activity.someone')),
      })),
    [columnKeys, field, members, t],
  );
  const names = useMemo(() => new Map(targets.map((target) => [target.key, target.name])), [targets]);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; from: string } | null>(null);
  /** A card moved from its menu, to focus once it shows in its new column. */
  const follow = useRef<{ id: string; key: string } | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const target = follow.current;
    if (!target) return;
    const card = board.current?.querySelector<HTMLElement>(`[data-record="${CSS.escape(target.id)}"]`);
    if (!card || card.closest('[data-column]')?.getAttribute('data-column') !== target.key) return;
    follow.current = null;
    card.focus();
  });

  const actions = useMemo<CardActions>(() => {
    /** Saves a move; null when the record is already in that column. */
    const save = (record: TableRecord, key: string) => {
      const values = moveToColumn(latest.current.field, record, key);
      if (!values) return null;
      // A conflict is handled by the page; the card goes back to its column on any failure.
      return latest.current.onChange(record, values).catch((error: unknown) => notify(tablesError(error, t)));
    };
    const end = () => {
      drag.current = null;
      setDragging(null);
      setOver(null);
    };
    return {
      open: (id) => latest.current.onOpen(id),
      move: (record, key) => {
        follow.current = { id: record.id, key };
        const saving = save(record, key);
        const stop = () => {
          if (follow.current?.id === record.id) follow.current = null;
        };
        if (saving) void saving.finally(() => requestAnimationFrame(stop));
        else stop();
      },
      dragStart: (event, record, from, name) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', name);
        drag.current = { id: record.id, from };
        // After the browser has taken the drag image, so the image is not the faded card.
        requestAnimationFrame(() => {
          if (drag.current?.id === record.id) setDragging(record.id);
        });
      },
      dragEnd: end,
      drop: (id, key) => {
        end();
        const record = latest.current.data.items.find((item) => item.id === id);
        if (record) void save(record, key);
      },
    };
  }, [notify, t]);

  const dropTarget = (key: string) =>
    canEdit
      ? {
          onDragOver(event: DragEvent<HTMLElement>) {
            if (!drag.current || drag.current.from === key) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setOver(key);
          },
          onDragLeave(event: DragEvent<HTMLElement>) {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setOver((current) => (current === key ? null : current));
          },
          onDrop(event: DragEvent<HTMLElement>) {
            const moving = drag.current;
            if (!moving || moving.from === key) return actions.dragEnd();
            event.preventDefault();
            actions.drop(moving.id, key);
          },
        }
      : {};

  const create = async (key: string) => {
    setCreating(key);
    try {
      const made = await onCreate(newInColumn(field, key));
      if (made) onOpen(made.id);
    } finally {
      setCreating(null);
    }
  };

  if (!shown.length) return <NoRecords {...props} />;
  return (
    <div
      ref={board}
      className={cx('app-tb-kb', narrow && 'is-narrow')}
      role="group"
      aria-label={t('tables.kanban.label')}
    >
      {shown.map((column) => {
        const name = names.get(column.key) ?? '';
        const count = column.records.length;
        const limit = limits[column.key] ?? KANBAN_PAGE;
        const more = moreCount(count, limit, KANBAN_PAGE);
        return (
          <div
            key={`column:${column.key}`}
            role="group"
            aria-label={t('tables.kanban.column', { name, count })}
            data-column={column.key}
            className={cx('app-tb-kb-column', over === column.key && 'is-over')}
            {...dropTarget(column.key)}
          >
            <div className="app-tb-kb-head" aria-hidden>
              <span className="app-tb-kb-name">
                <ColumnName column={column} lookups={lookups} />
              </span>
              <span className="app-tb-kb-count">{count}</span>
            </div>
            <div className="app-tb-kb-cards">
              {column.records.slice(0, limit).map((record) => (
                <Card
                  key={record.id}
                  record={record}
                  column={column.key}
                  fields={fields}
                  extra={extra}
                  targets={targets}
                  lookups={lookups}
                  canEdit={canEdit}
                  dragging={dragging === record.id}
                  actions={actions}
                />
              ))}
              {more > 0 && (
                <Button
                  kind="ghost"
                  size="sm"
                  className="app-tb-kb-more"
                  onClick={() => setLimits((current) => ({ ...current, [column.key]: limit + KANBAN_PAGE }))}
                >
                  {t('tables.kanban.more', { count: more })}
                </Button>
              )}
            </div>
            {canEdit && (
              <Button
                kind="ghost"
                size="sm"
                className="app-tb-kb-add"
                loading={creating === column.key}
                aria-label={t('tables.kanban.add', { name })}
                onClick={() => void create(column.key)}
              >
                <Plus size={icon.sm} strokeWidth={icon.stroke} />
                {t('tables.addRecord')}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ColumnName({ column, lookups }: { column: KanbanColumn; lookups: CellLookups }) {
  const { t } = useI18n();
  if (column.option) return <OptionChip option={column.option} />;
  if (!column.key) return <span className="app-tb-kb-none">{t('tables.kanban.empty')}</span>;
  const member = lookups.members.get(column.key);
  const name = member?.name ?? t('tables.activity.someone');
  return (
    <span className="app-tb-person">
      <MemberAvatar name={name} url={member?.avatar_url} size={20} />
      <span>{name}</span>
    </span>
  );
}

const Card = memo(function Card({
  record,
  column,
  fields,
  extra,
  targets,
  lookups,
  canEdit,
  dragging,
  actions,
}: {
  record: TableRecord;
  column: string;
  fields: readonly Field[];
  extra: readonly Field[];
  targets: readonly Target[];
  lookups: CellLookups;
  canEdit: boolean;
  dragging: boolean;
  actions: CardActions;
}) {
  const { t } = useI18n();
  /** The press began on the card's menu, which is no drag of the card. */
  const onMenu = useRef(false);
  const title = titleOf(fields, record);
  const name = title || t('tables.record.untitled');
  const moves: MenuItem[] = targets
    .filter((target) => target.key !== column)
    .map((target) => ({
      label: t('tables.kanban.moveTo', { name: target.name }),
      onClick: () => actions.move(record, target.key),
    }));
  return (
    <article
      className={cx('app-tb-kb-card', dragging && 'is-dragging')}
      tabIndex={0}
      aria-label={name}
      data-record={record.id}
      draggable={canEdit}
      {...cardOpeners(() => actions.open(record.id))}
      onPointerDown={(event) => {
        onMenu.current = !!(event.target as Element).closest('.app-tb-kb-card-menu');
      }}
      onDragStart={(event) => {
        // A link or a picture inside drags itself.
        if (event.target !== event.currentTarget) return;
        if (!canEdit || onMenu.current) return event.preventDefault();
        actions.dragStart(event, record, column, name);
      }}
      onDragEnd={actions.dragEnd}
    >
      <div className="app-tb-kb-card-head">
        <span className={cx('app-tb-kb-card-title', !title && 'is-untitled')}>{name}</span>
        {canEdit && moves.length > 0 && (
          // The menu's panel sits inside the card: its clicks must not open the card.
          <span className="app-tb-kb-card-menu" onClick={(event) => event.stopPropagation()}>
            <Menu label={t('tables.kanban.move', { name })} items={moves} />
          </span>
        )}
      </div>
      <CardFields record={record} fields={extra} lookups={lookups} />
    </article>
  );
});
