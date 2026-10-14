/**
 * The grid view (TBL-03, TBL-06, TBL-07, TBL-10): records as rows, fields as columns, the primary
 * field and `frozen` more columns pinned on the left. Only the rows in view are drawn, so a
 * table of thousands scrolls smoothly. Keyboard: arrows move, Shift extends a range, Enter edits,
 * Escape cancels, Space opens the record, typing replaces the cell, Delete clears, ⌘C copies and
 * ⌘V pastes a block (rows past the last one become new records). One click does one thing: the
 * checkbox selects, a cell becomes the current one, the open button opens the record.
 */

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronRight, Grid2X2, List, Maximize2, Plus, Trash2 } from 'lucide-react';
import { Button, Checkbox, Empty, IconButton, Menu, useContextMenu, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  CellParseError,
  canGroupBy,
  isEmptyValue,
  operatorsFor,
  parseCell,
  parseClipboard,
  toClipboard,
  type Field,
  type RecordValues,
  type TableRecord,
} from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { usePeople } from '../../data/people';
import { bulkRecords, deleteRecords, refreshBase, restoreRecord } from '../../data/tables';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { CellValue, FieldIcon, FieldInput, fromText, OptionChip, shortDay } from './cells';
import { tablesError } from './errors';
import { groupRecords, linkTable, orderedFields, resolveField, titleOf, valueText, type CellLookups } from './model';
import type { ViewProps } from './types';

const CHECK_W = 56;
const ADD_W = 44;
const HEADER_H = 40;
const GROUP_H = 36;
const ADD_H = 36;
const ROW_H = { short: 36, medium: 44, tall: 72 } as const;
const OVERSCAN = 8;

const DEFAULT_WIDTH: Record<Field['type'], number> = {
  text: 180,
  long_text: 240,
  number: 120,
  checkbox: 88,
  date: 130,
  datetime: 170,
  single_select: 150,
  multi_select: 200,
  member: 160,
  url: 200,
  email: 200,
  phone: 150,
  attachment: 200,
  relation: 200,
  parent: 180,
  dependency: 200,
  formula: 150,
  lookup: 200,
  rollup: 130,
  ai: 240,
};

export const widthOf = (field: Field, widths: Record<string, number> | undefined) =>
  widths?.[field.id] ?? (field.is_primary ? 240 : DEFAULT_WIDTH[field.type]);

/** Fields edited by typing into the cell; the others open a picker. */
const TYPED: readonly Field['type'][] = ['text', 'long_text', 'number', 'url', 'email', 'phone'];
/** Pickers that hold one value: a pick saves and closes. */
const singlePick = (field: Field) =>
  ['single_select', 'date', 'datetime', 'parent'].includes(field.type) ||
  (field.type === 'member' && !field.config.multiple) ||
  (field.type === 'relation' && !field.config.multiple);

type Line =
  | { kind: 'group'; key: string; count: number; sample: TableRecord }
  | { kind: 'record'; record: TableRecord; row: number }
  | { kind: 'add' };

interface Cell {
  row: number;
  col: number;
}

interface Editing extends Cell {
  value: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The first index whose offset is at or after `y`. */
export function lowerBound(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid]! < y) low = mid + 1;
    else high = mid;
  }
  return low;
}

function GroupLabel({
  field,
  sample,
  lookups,
}: {
  field: Field | 'created_by';
  sample: TableRecord;
  lookups: CellLookups;
}) {
  const { t, locale } = useI18n();
  const empty = <span className="app-muted">{t('tables.grid.groupEmpty')}</span>;
  if (field === 'created_by') return <span>{lookups.members.get(sample.created_by ?? '')?.name ?? '—'}</span>;
  const value = sample.values[field.id];
  if (field.type === 'checkbox') return <span>{value === true ? t('tables.checked') : t('tables.unchecked')}</span>;
  if (isEmptyValue(value)) return empty;
  if (field.type === 'single_select') {
    const option = field.config.options?.find((entry) => entry.id === value);
    return option ? <OptionChip option={option} /> : empty;
  }
  if (field.type === 'date' && typeof value === 'string') return <span>{shortDay(value, locale)}</span>;
  const first = Array.isArray(value) ? value.slice(0, 1) : value;
  return <span>{valueText(field, { ...sample, values: { [field.id]: first } }, lookups)}</span>;
}

interface RowProps {
  record: TableRecord;
  row: number;
  top: number;
  height: number;
  columns: Field[];
  lefts: number[];
  widths: number[];
  frozen: number;
  width: number;
  gridId: string;
  activeCol: number | null;
  /** The columns of this row inside the selected range. */
  rangeFrom: number;
  rangeTo: number;
  selected: boolean;
  canEdit: boolean;
  lookups: CellLookups;
  onSelect: (id: string, checked: boolean) => void;
  onCell: (cell: Cell, shift: boolean) => void;
  onEdit: (cell: Cell) => void;
  onOpen: (id: string) => void;
  onToggle: (record: TableRecord, field: Field) => void;
}

const Row = memo(function Row({
  record,
  row,
  top,
  height,
  columns,
  lefts,
  widths,
  frozen,
  width,
  gridId,
  activeCol,
  rangeFrom,
  rangeTo,
  selected,
  canEdit,
  lookups,
  onSelect,
  onCell,
  onEdit,
  onOpen,
  onToggle,
}: RowProps) {
  const { t } = useI18n();
  return (
    <div
      role="row"
      aria-rowindex={row + 2}
      aria-selected={selected || undefined}
      className={cx('app-tb-row', selected && 'is-selected')}
      style={{ top, height, width }}
    >
      <div role="gridcell" className="app-tb-cell app-tb-check-cell is-frozen" style={{ left: 0, width: CHECK_W }}>
        <span className="app-tb-row-number" aria-hidden>
          {row + 1}
        </span>
        <Checkbox
          aria-label={t('tables.grid.select', { n: row + 1 })}
          checked={selected}
          onChange={(checked) => onSelect(record.id, checked)}
        />
      </div>
      {columns.map((field, col) => {
        const active = activeCol === col;
        const inRange = col >= rangeFrom && col <= rangeTo;
        return (
          <div
            key={field.id}
            id={`${gridId}-${row}-${col}`}
            role="gridcell"
            aria-colindex={col + 2}
            aria-selected={active || inRange || undefined}
            className={cx(
              'app-tb-cell',
              col < frozen && 'is-frozen',
              col === frozen - 1 && 'is-frozen-edge',
              active && 'is-active',
              inRange && !active && 'is-in-range',
              field.type === 'number' && 'is-number',
            )}
            style={{ width: widths[col], ...(col < frozen ? { left: lefts[col] } : {}) }}
            onMouseDown={(event) => {
              if (event.button !== 0 || (event.target as HTMLElement).closest('a, button, input')) return;
              event.preventDefault();
              onCell({ row, col }, event.shiftKey);
            }}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest('a, button, input')) return;
              onEdit({ row, col });
            }}
          >
            {field.type === 'checkbox' ? (
              <Checkbox
                aria-label={field.name}
                checked={record.values[field.id] === true}
                disabled={!canEdit}
                onChange={() => onToggle(record, field)}
              />
            ) : (
              <span className="app-tb-cell-value">
                <CellValue field={field} value={record.values[field.id]} lookups={lookups} onOpenRecord={onOpen} />
              </span>
            )}
            {field.is_primary && (
              <IconButton
                size="sm"
                className="app-tb-open"
                label={t('tables.grid.open')}
                onClick={() => onOpen(record.id)}
              >
                <Maximize2 size={icon.sm} strokeWidth={icon.stroke} />
              </IconButton>
            )}
          </div>
        );
      })}
    </div>
  );
});

function HeaderCell({
  field,
  col,
  left,
  width,
  frozen,
  frozenEdge,
  menu,
  onResize,
}: {
  field: Field;
  col: number;
  left: number | undefined;
  width: number;
  frozen: boolean;
  frozenEdge: boolean;
  menu: MenuEntry[];
  onResize: (width: number, done: boolean) => void;
}) {
  const { t } = useI18n();
  const context = useContextMenu(menu, field.name);
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) => Math.max(60, Math.min(800, value));
  return (
    <div
      role="columnheader"
      aria-colindex={col + 2}
      aria-label={field.name}
      className={cx(
        'app-tb-head-cell',
        frozen && 'is-frozen',
        frozenEdge && 'is-frozen-edge',
        context.open && 'is-menu-open',
      )}
      style={{ width, ...(frozen ? { left } : {}) }}
      {...context.handlers}
    >
      <FieldIcon type={field.type} />
      <span className="app-tb-head-name">{field.name}</span>
      <Menu label={t('tables.field.menu', { name: field.name })} items={menu} />
      <span
        className="app-tb-resize"
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          start.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (start.current) onResize(clamp(start.current.width + event.clientX - start.current.x), false);
        }}
        onPointerUp={(event) => {
          if (!start.current) return;
          onResize(clamp(start.current.width + event.clientX - start.current.x), true);
          start.current = null;
        }}
      />
    </div>
  );
}

/** Phones: records as a list (title and two more values); the full grid is one tap away. */
function RecordList({ props }: { props: ViewProps }) {
  const { t } = useI18n();
  const columns = orderedFields(props.fields, props.config)
    .filter((field) => !field.is_primary)
    .slice(0, 2);
  return (
    <ul className="app-tb-list" aria-label={t('tables.grid.label')}>
      {props.data.items.map((record) => (
        <li key={record.id}>
          <button type="button" className="app-tb-list-row" onClick={() => props.onOpen(record.id)}>
            <span className="app-tb-list-title">{titleOf(props.fields, record) || t('tables.record.untitled')}</span>
            <span className="app-tb-list-meta">
              {columns.map((field) => (
                <CellValue key={field.id} field={field} value={record.values[field.id]} lookups={props.lookups} />
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function GridView(props: ViewProps) {
  const { t } = useI18n();
  const [list, setList] = useState(props.narrow);
  useEffect(() => setList(props.narrow), [props.narrow]);
  if (!props.data.items.length) {
    const filtered = !!props.config.filter?.clauses.length;
    return (
      <Empty
        title={filtered ? t('tables.grid.noMatch') : t('tables.grid.noRecords')}
        action={
          filtered ? (
            <Button onClick={() => props.onConfig({ ...props.config, filter: undefined })}>
              {t('tables.grid.clearFilters')}
            </Button>
          ) : props.canEdit ? (
            <Button
              kind="primary"
              onClick={() => void props.onCreate({}).then((made) => made && props.onOpen(made.id))}
            >
              {t('tables.addRecord')}
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <>
      {props.narrow && (
        <div className="app-tb-grid-switch">
          <IconButton
            label={list ? t('tables.grid.showGrid') : t('tables.grid.showList')}
            onClick={() => setList(!list)}
          >
            {list ? (
              <Grid2X2 size={icon.md} strokeWidth={icon.stroke} />
            ) : (
              <List size={icon.md} strokeWidth={icon.stroke} />
            )}
          </IconButton>
        </div>
      )}
      {list ? <RecordList props={props} /> : <Grid {...props} />}
    </>
  );
}

function Grid(props: ViewProps) {
  const { fields, config, data, lookups, canEdit, canBuild, onOpen, onChange, onCreate, onConfig, onEditField, table } =
    props;
  const { t } = useI18n();
  const notify = useNotify();
  const { members } = usePeople();
  const gridId = useId().replace(/:/g, '');
  const scroller = useRef<HTMLDivElement>(null);

  // ── Columns ─────────────────────────────────────────
  const columns = useMemo(() => orderedFields(fields, config), [fields, config]);
  const [resizing, setResizing] = useState<{ id: string; width: number } | null>(null);
  const { widths, lefts, totalWidth } = useMemo(() => {
    const sizes = columns.map((field) => (resizing?.id === field.id ? resizing.width : widthOf(field, config.widths)));
    const offsets: number[] = [];
    let x = CHECK_W;
    for (const size of sizes) {
      offsets.push(x);
      x += size;
    }
    return { widths: sizes, lefts: offsets, totalWidth: x + ADD_W };
  }, [columns, config.widths, resizing]);
  const frozen = Math.min(columns.length, 1 + (config.frozen ?? 0));
  const rowHeight = ROW_H[config.row_height ?? 'medium'];

  // ── Lines: group headers, records, the add row ──────
  const groupField = resolveField(fields, config.group?.field ?? undefined);
  const groupable =
    groupField && (typeof groupField !== 'string' || groupField === 'created_by') ? groupField : undefined;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { lines, records, tops, height } = useMemo(() => {
    const out: Line[] = [];
    const visible: TableRecord[] = [];
    const push = (record: TableRecord) => {
      out.push({ kind: 'record', record, row: visible.length });
      visible.push(record);
    };
    if (groupable) {
      for (const group of groupRecords(data.items, groupable)) {
        out.push({ kind: 'group', key: group.key, count: group.records.length, sample: group.records[0]! });
        if (!collapsed.has(group.key)) group.records.forEach(push);
      }
    } else data.items.forEach(push);
    if (canEdit) out.push({ kind: 'add' });
    const offsets: number[] = [];
    let y = 0;
    for (const line of out) {
      offsets.push(y);
      y += line.kind === 'group' ? GROUP_H : line.kind === 'add' ? ADD_H : rowHeight;
    }
    return { lines: out, records: visible, tops: offsets, height: y };
  }, [data.items, groupable, collapsed, canEdit, rowHeight]);
  const lineOfRow = useMemo(() => {
    const map = new Map<number, number>();
    lines.forEach((line, index) => line.kind === 'record' && map.set(line.row, index));
    return map;
  }, [lines]);

  // ── The window of rows drawn ────────────────────────
  const [port, setPort] = useState({ top: 0, height: 800 });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setPort({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const first = Math.max(0, lowerBound(tops, port.top - HEADER_H) - OVERSCAN);
  const last = Math.min(lines.length, lowerBound(tops, port.top + port.height) + OVERSCAN);

  // ── The current cell, a range, editing ──────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<Cell | null>(null);
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;
  const activeRef = useRef<Cell | null>(null);
  activeRef.current = active;
  const [cellError, setCellError] = useState<(Cell & { message: string }) | null>(null);
  const rowOf = useMemo(() => new Map(records.map((record, index) => [record.id, index])), [records]);
  useEffect(() => {
    setSelected((current) => {
      const kept = [...current].filter((id) => rowOf.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [rowOf]);

  const range =
    active && anchor
      ? {
          rows: [Math.min(active.row, anchor.row), Math.max(active.row, anchor.row)] as const,
          cols: [Math.min(active.col, anchor.col), Math.max(active.col, anchor.col)] as const,
        }
      : null;
  const multi = !!range && (range.rows[0] !== range.rows[1] || range.cols[0] !== range.cols[1]);

  const focusGrid = () => scroller.current?.focus({ preventScroll: true });

  const reveal = (cell: Cell) => {
    const element = scroller.current;
    const index = lineOfRow.get(cell.row);
    if (!element || index === undefined) return;
    const top = tops[index]! + HEADER_H;
    if (top < element.scrollTop + HEADER_H) element.scrollTop = top - HEADER_H;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight;
    }
    if (cell.col < frozen) return;
    const left = lefts[cell.col]!;
    const pinned = lefts[frozen - 1]! + widths[frozen - 1]!;
    if (left < element.scrollLeft + pinned) element.scrollLeft = left - pinned;
    else if (left + widths[cell.col]! > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = left + widths[cell.col]! - element.clientWidth;
    }
  };

  const moveTo = (cell: Cell, extend = false) => {
    if (!records.length) return;
    const next = {
      row: Math.max(0, Math.min(records.length - 1, cell.row)),
      col: Math.max(0, Math.min(columns.length - 1, cell.col)),
    };
    setActive(next);
    if (!extend) setAnchor(next);
    setCellError(null);
    reveal(next);
  };

  const save = useCallback(
    async (record: TableRecord, field: Field, value: unknown, cell: Cell) => {
      if (same(record.values[field.id], value)) return;
      try {
        await onChange(record, { [field.id]: value });
      } catch (error) {
        setCellError({ ...cell, message: tablesError(error, t) });
      }
    },
    [onChange, t],
  );

  const startEdit = (cell: Cell, typed?: string) => {
    const record = records[cell.row];
    const field = columns[cell.col];
    if (!record || !field || !canEdit) return;
    if (field.type === 'checkbox') {
      void save(record, field, record.values[field.id] !== true, cell);
      return;
    }
    if (field.type === 'attachment') {
      onOpen(record.id);
      return;
    }
    setCellError(null);
    setEditing({ ...cell, value: typed !== undefined ? typed : record.values[field.id] });
  };
  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;

  /** Ends the edit: saves what was typed or picked (unless cancelled), then the grid has focus again. */
  const finishEdit = (commit: boolean, move?: Cell) => {
    const done = editingRef.current;
    if (!done) return;
    editingRef.current = null;
    setEditing(null);
    const record = records[done.row];
    const field = columns[done.col];
    if (commit && record && field && !singlePick(field)) void save(record, field, fromText(field, done.value), done);
    if (move) moveTo(move);
    requestAnimationFrame(focusGrid);
  };

  const onToggle = useCallback(
    (record: TableRecord, field: Field) =>
      void save(record, field, record.values[field.id] !== true, {
        row: rowOf.get(record.id) ?? 0,
        col: columns.indexOf(field),
      }),
    [rowOf, save, columns],
  );
  const onSelect = useCallback((id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const onCell = useCallback((cell: Cell, shift: boolean) => {
    setCellError(null);
    setActive(cell);
    if (!shift || !activeRef.current) setAnchor(cell);
    scroller.current?.focus({ preventScroll: true });
  }, []);
  const onEdit = useCallback((cell: Cell) => startEditRef.current(cell), []);

  // ── Copy, paste, clear ──────────────────────────────
  const copy = async () => {
    if (!range) return;
    const matrix: string[][] = [];
    for (let row = range.rows[0]; row <= range.rows[1]; row++) {
      const record = records[row]!;
      const cells: string[] = [];
      for (let col = range.cols[0]; col <= range.cols[1]; col++) cells.push(valueText(columns[col]!, record, lookups));
      matrix.push(cells);
    }
    await navigator.clipboard?.writeText(toClipboard(matrix)).catch(() => undefined);
    notify(t('tables.grid.copied', { count: matrix.length * (matrix[0]?.length ?? 0) }));
  };

  const paste = async (text: string) => {
    const start = range ? { row: range.rows[0], col: range.cols[0] } : active;
    if (!start || !canEdit) return;
    const matrix = parseClipboard(text);
    if (!matrix.length) return;
    // Linked records are found by their titles; members by name or email.
    const linkTables = new Set<string>();
    for (let col = 0; col < (matrix[0]?.length ?? 0); col++) {
      const field = columns[start.col + col];
      if (field && ['relation', 'parent', 'dependency'].includes(field.type)) linkTables.add(linkTable(field));
    }
    const titles = new Map<string, Map<string, string>>();
    await Promise.all(
      [...linkTables].map(async (tableId) => {
        const found = await api.tables.tables.titles(tableId, { limit: 1000 }).catch(() => ({ items: [] }));
        titles.set(tableId, new Map(found.items.map((item) => [item.title.toLowerCase(), item.id])));
      }),
    );
    const people = new Map<string, string>();
    for (const member of members) {
      people.set(member.name.toLowerCase(), member.id);
      people.set(member.email.toLowerCase(), member.id);
    }
    const context = {
      timeZone: lookups.timeZone,
      findMember: (name: string) => people.get(name.toLowerCase()),
      findRecord: (tableId: string, title: string) => titles.get(tableId)?.get(title.toLowerCase()),
    };
    let skipped: unknown = null;
    const items: Array<{ id?: string; revision?: number; values: RecordValues }> = [];
    matrix.forEach((cells, r) => {
      const values: RecordValues = {};
      cells.forEach((raw, c) => {
        const field = columns[start.col + c];
        if (!field) return;
        try {
          values[field.id] = parseCell(field, raw, context);
        } catch (error) {
          if (!(error instanceof CellParseError)) throw error;
          skipped ??= error;
        }
      });
      if (!Object.keys(values).length) return;
      const record = records[start.row + r];
      items.push(record ? { id: record.id, revision: record.revision, values } : { values });
    });
    if (skipped) notify(t('tables.grid.pasteSkipped', { reason: tablesError(skipped, t) }));
    if (!items.length) return;
    try {
      const result = await bulkRecords(table.id, items.slice(0, 500));
      const ok = result.items.filter((item) => item.ok).length;
      const failed = result.items.length - ok;
      if (!skipped)
        notify(failed ? t('tables.grid.pastePartial', { ok, failed }) : t('tables.grid.pasted', { count: ok }));
      setAnchor(start);
      setActive({
        row: start.row + matrix.length - 1,
        col: Math.min(start.col + (matrix[0]?.length ?? 1) - 1, columns.length - 1),
      });
    } catch (error) {
      notify(tablesError(error, t));
    }
  };

  const clear = async () => {
    if (!range || !canEdit) return;
    const items: Array<{ id: string; revision: number; values: RecordValues }> = [];
    for (let row = range.rows[0]; row <= range.rows[1]; row++) {
      const record = records[row]!;
      const values: RecordValues = {};
      for (let col = range.cols[0]; col <= range.cols[1]; col++) {
        const field = columns[col]!;
        if (!isEmptyValue(record.values[field.id])) values[field.id] = field.type === 'checkbox' ? false : null;
      }
      if (Object.keys(values).length) items.push({ id: record.id, revision: record.revision, values });
    }
    if (!items.length) return;
    if (items.length === 1 && !multi) {
      const field = columns[range.cols[0]]!;
      await save(records[range.rows[0]]!, field, Object.values(items[0]!.values)[0], {
        row: range.rows[0],
        col: range.cols[0],
      });
      return;
    }
    await bulkRecords(table.id, items).catch((error: unknown) => notify(tablesError(error, t)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.target !== scroller.current || !records.length) return;
    if (!active) {
      if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        moveTo({ row: 0, col: 0 });
      }
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const step = (row: number, col: number) => {
      event.preventDefault();
      moveTo({ row: active.row + row, col: active.col + col }, event.shiftKey);
    };
    switch (event.key) {
      case 'ArrowDown':
        return step(mod ? records.length : 1, 0);
      case 'ArrowUp':
        return step(mod ? -records.length : -1, 0);
      case 'ArrowRight':
        return step(0, mod ? columns.length : 1);
      case 'ArrowLeft':
        return step(0, mod ? -columns.length : -1);
      case 'Tab': {
        const col = active.col + (event.shiftKey ? -1 : 1);
        if (col >= 0 && col < columns.length) {
          event.preventDefault();
          moveTo({ row: active.row, col });
          return;
        }
        const row = active.row + (event.shiftKey ? -1 : 1);
        if (row < 0 || row >= records.length) return;
        event.preventDefault();
        moveTo({ row, col: event.shiftKey ? columns.length - 1 : 0 });
        return;
      }
      case 'Home':
        event.preventDefault();
        return moveTo({ row: mod ? 0 : active.row, col: 0 });
      case 'End':
        event.preventDefault();
        return moveTo({ row: mod ? records.length - 1 : active.row, col: columns.length - 1 });
      case 'Enter':
        event.preventDefault();
        return startEdit(active);
      case ' ':
        event.preventDefault();
        if (columns[active.col]?.type === 'checkbox') return startEdit(active);
        return onOpen(records[active.row]!.id);
      case 'Escape':
        if (multi || cellError) {
          event.stopPropagation();
          setAnchor(active);
          setCellError(null);
        }
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        void clear();
        return;
    }
    if (mod && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copy();
      return;
    }
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setAnchor({ row: 0, col: 0 });
      setActive({ row: records.length - 1, col: columns.length - 1 });
      return;
    }
    if (!mod && !event.altKey && event.key.length === 1 && canEdit && TYPED.includes(columns[active.col]!.type)) {
      event.preventDefault();
      startEdit(active, event.key);
    }
  };

  // ── Column menus ────────────────────────────────────
  const columnMenu = (field: Field): MenuEntry[] => {
    const items: MenuEntry[] = [];
    if (canBuild) items.push({ label: t('tables.field.edit'), onClick: () => onEditField(field) });
    items.push(
      { label: t('tables.field.sortAsc'), onClick: () => onConfig({ ...config, sorts: [{ field: field.id }] }) },
      {
        label: t('tables.field.sortDesc'),
        onClick: () => onConfig({ ...config, sorts: [{ field: field.id, desc: true }] }),
      },
    );
    const ops = operatorsFor(field.type);
    if (ops.length) {
      items.push({
        label: t('tables.field.filterBy'),
        onClick: () =>
          onConfig({
            ...config,
            filter: {
              mode: config.filter?.mode ?? 'and',
              clauses: [...(config.filter?.clauses ?? []), { field: field.id, op: ops[0]! }],
            },
          }),
      });
    }
    if (canGroupBy(field.type) && !(field.type === 'member' && field.config.multiple)) {
      items.push({
        label: t('tables.field.groupBy'),
        onClick: () => onConfig({ ...config, group: { field: field.id } }),
      });
    }
    if (!field.is_primary) {
      items.push({
        label: t('tables.field.hide'),
        onClick: () => onConfig({ ...config, hidden: [...(config.hidden ?? []), field.id] }),
      });
    }
    if (canBuild && !field.is_primary) {
      items.push('-', {
        label: t('tables.field.delete'),
        icon: <Trash2 size={icon.md} />,
        danger: true,
        onClick: () =>
          void api.tables.fields
            .archive(field.id)
            .then(async () => {
              await refreshBase(props.base.id);
              notify(t('tables.field.deleted', { name: field.name }), {
                label: t('tables.undo'),
                onClick: () => void api.tables.fields.restore(field.id).then(() => refreshBase(props.base.id)),
              });
            })
            .catch((error: unknown) => notify(tablesError(error, t))),
      });
    }
    return items;
  };

  const addRecord = async () => {
    const made = await onCreate({});
    if (!made) return;
    // The new record is the last row; start typing its title.
    const row = records.length;
    requestAnimationFrame(() => {
      setActive({ row, col: 0 });
      setAnchor({ row, col: 0 });
      setEditing({ row, col: 0, value: '' });
    });
  };

  const removeSelected = async () => {
    const ids = [...selected];
    setSelected(new Set());
    try {
      await deleteRecords(table.id, ids);
      notify(t('tables.grid.deleted', { count: ids.length }), {
        label: t('tables.undo'),
        onClick: () => void Promise.all(ids.map((id) => restoreRecord(table.id, id))),
      });
    } catch (error) {
      notify(tablesError(error, t));
    }
  };

  // ── Drawing ─────────────────────────────────────────
  const allSelected = records.length > 0 && records.every((record) => selected.has(record.id));
  const rendered: ReactNode[] = [];
  for (let index = first; index < last; index++) {
    const line = lines[index]!;
    const top = tops[index]! + HEADER_H;
    if (line.kind === 'group') {
      const shut = collapsed.has(line.key);
      rendered.push(
        <div
          key={`g:${line.key}`}
          role="row"
          className="app-tb-group"
          style={{ top, height: GROUP_H, width: totalWidth }}
        >
          <button
            type="button"
            className="app-tb-group-toggle"
            aria-expanded={!shut}
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(line.key)) next.delete(line.key);
                else next.add(line.key);
                return next;
              })
            }
          >
            {shut ? <ChevronRight size={icon.sm} /> : <ChevronDown size={icon.sm} />}
            {groupable && (
              <GroupLabel field={groupable as Field | 'created_by'} sample={line.sample} lookups={lookups} />
            )}
            <span className="app-tb-group-count">{t('tables.grid.groupCount', { count: line.count })}</span>
          </button>
        </div>,
      );
    } else if (line.kind === 'add') {
      rendered.push(
        <div key="add" role="row" className="app-tb-add-row" style={{ top, height: ADD_H, width: totalWidth }}>
          <button type="button" className="app-tb-add-button" onClick={() => void addRecord()}>
            <Plus size={icon.sm} strokeWidth={icon.stroke} />
            {t('tables.grid.addRow')}
          </button>
        </div>,
      );
    } else {
      const inRows = multi && range && line.row >= range.rows[0] && line.row <= range.rows[1];
      rendered.push(
        <Row
          key={line.record.id}
          record={line.record}
          row={line.row}
          top={top}
          height={rowHeight}
          columns={columns}
          lefts={lefts}
          widths={widths}
          frozen={frozen}
          width={totalWidth}
          gridId={gridId}
          activeCol={active?.row === line.row && !editing ? active.col : null}
          rangeFrom={inRows ? range!.cols[0] : -1}
          rangeTo={inRows ? range!.cols[1] : -2}
          selected={selected.has(line.record.id)}
          canEdit={canEdit}
          lookups={lookups}
          onSelect={onSelect}
          onCell={onCell}
          onEdit={onEdit}
          onOpen={onOpen}
          onToggle={onToggle}
        />,
      );
    }
  }

  let editor: ReactNode = null;
  if (editing) {
    const index = lineOfRow.get(editing.row);
    const record = records[editing.row];
    const field = columns[editing.col];
    if (index !== undefined && record && field) {
      const picker = !TYPED.includes(field.type);
      const style: CSSProperties = {
        top: tops[index]! + HEADER_H,
        left: lefts[editing.col],
        width: Math.max(widths[editing.col]!, field.type === 'long_text' ? 320 : 0),
        minHeight: rowHeight,
      };
      editor = (
        <div
          className={cx('app-tb-editor', picker && 'is-picker')}
          style={style}
          onBlur={(event) => {
            if (picker || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            finishEdit(true);
          }}
        >
          <FieldInput
            field={field}
            value={editing.value}
            inline
            autoFocus
            recordId={record.id}
            baseId={props.base.id}
            lookups={lookups}
            onChange={(value) => {
              setEditing((current) => (current ? { ...current, value } : current));
              if (singlePick(field)) void save(record, field, value, editing);
            }}
            onDone={() => {
              // A picker closed: one-value pickers saved on pick; lists save what was picked now.
              const done = editingRef.current;
              editingRef.current = null;
              setEditing(null);
              if (done && !singlePick(field)) void save(record, field, done.value, done);
              requestAnimationFrame(focusGrid);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finishEdit(false);
              } else if (event.key === 'Enter' && (field.type !== 'long_text' || event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                finishEdit(true, { row: editing.row + (event.shiftKey ? -1 : 1), col: editing.col });
              } else if (event.key === 'Tab') {
                event.preventDefault();
                finishEdit(true, { row: editing.row, col: editing.col + (event.shiftKey ? -1 : 1) });
              }
            }}
          />
        </div>
      );
    }
  }

  let errorBubble: ReactNode = null;
  if (cellError) {
    const index = lineOfRow.get(cellError.row);
    if (index !== undefined) {
      errorBubble = (
        <div
          className="app-tb-cell-error"
          role="alert"
          style={{
            top: tops[index]! + HEADER_H + rowHeight,
            left: lefts[cellError.col],
            maxWidth: Math.max(widths[cellError.col]!, 240),
          }}
        >
          {cellError.message}
        </div>
      );
    }
  }

  return (
    <div className="app-tb-grid-wrap">
      {selected.size > 0 && (
        <div className="app-tb-bulk" role="status">
          <span>{t('tables.grid.selected', { count: selected.size })}</span>
          {canEdit && (
            <Button kind="ghost" size="sm" onClick={() => void removeSelected()}>
              <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
              {t('tables.grid.delete')}
            </Button>
          )}
          <Button kind="ghost" size="sm" className="app-tb-bulk-end" onClick={() => setSelected(new Set())}>
            {t('tables.grid.clearSelection')}
          </Button>
        </div>
      )}
      <div
        ref={scroller}
        className="app-tb-grid"
        role="grid"
        tabIndex={0}
        aria-label={t('tables.grid.label')}
        aria-rowcount={records.length + 1}
        aria-colcount={columns.length + 1}
        aria-multiselectable
        aria-activedescendant={active && !editing ? `${gridId}-${active.row}-${active.col}` : undefined}
        onKeyDown={onKeyDown}
        onScroll={(event) => setPort({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
        onPaste={(event) => {
          if (editing) return;
          event.preventDefault();
          void paste(event.clipboardData.getData('text/plain'));
        }}
      >
        <div className="app-tb-canvas" style={{ width: totalWidth, height: height + HEADER_H }}>
          <div role="row" className="app-tb-head" style={{ width: totalWidth }}>
            <div
              role="columnheader"
              className="app-tb-head-cell app-tb-check-cell is-frozen"
              style={{ left: 0, width: CHECK_W }}
            >
              <Checkbox
                aria-label={t('tables.grid.selectAll')}
                checked={allSelected}
                indeterminate={!allSelected && selected.size > 0}
                onChange={(checked) => setSelected(checked ? new Set(records.map((record) => record.id)) : new Set())}
              />
            </div>
            {columns.map((field, col) => (
              <HeaderCell
                key={field.id}
                field={field}
                col={col}
                left={lefts[col]}
                width={widths[col]!}
                frozen={col < frozen}
                frozenEdge={col === frozen - 1}
                menu={columnMenu(field)}
                onResize={(width, done) => {
                  if (!done) return setResizing({ id: field.id, width });
                  setResizing(null);
                  if (width !== widthOf(field, config.widths)) {
                    onConfig({ ...config, widths: { ...config.widths, [field.id]: Math.round(width) } });
                  }
                }}
              />
            ))}
            <div role="columnheader" className="app-tb-head-cell app-tb-add-cell" style={{ width: ADD_W }}>
              {canBuild && (
                <IconButton size="sm" label={t('tables.grid.addField')} onClick={() => onEditField()}>
                  <Plus size={icon.sm} strokeWidth={icon.stroke} />
                </IconButton>
              )}
            </div>
          </div>
          {rendered}
          {editor}
          {errorBubble}
        </div>
      </div>
      <div className="app-tb-grid-foot">
        <span className="app-muted">{t('tables.grid.count', { count: data.items.length })}</span>
      </div>
    </div>
  );
}
