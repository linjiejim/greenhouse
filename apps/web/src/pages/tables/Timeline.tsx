/**
 * The timeline view (TBL-04): a gantt of the table's records. Titles on the left, children
 * indented under their parent and collapsible; bars from the start to the end day on a day, week
 * or month axis; diamonds for milestones; arrows from each record to the ones that depend on it.
 * Editors drag a bar, or one of its ends, by whole days (a finger holds still first) or nudge it
 * with Alt + arrow keys; a click opens the record. Only the rows in view are drawn, placed by
 * `top` in a box as tall as all of them. The numbers come from timeline-model.ts.
 */

import '../../styles/tables-timeline.css';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { ChartGantt, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Empty, IconButton, Segmented } from '@greenhouse/ui/kit';
import { icon, space } from '@greenhouse/ui/tokens';
import { isComputedType, TIMELINE_SCALES, type TableRecord, type TimelineScale } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { shortDay } from './cells';
import { tablesError } from './errors';
import {
  SCALE_DAY_PX,
  dayNumber,
  dayOf,
  isMilestone,
  timelineRows,
  titleOf,
  todayIn,
  valueForDay,
  type Span,
  type TimelineRow,
} from './model';
import {
  AXIS_UNITS,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  ROW_HEIGHT_NARROW,
  TITLE_WIDTH,
  TITLE_WIDTH_NARROW,
  anchorsOf,
  arrowBox,
  arrowHead,
  arrowPath,
  axisCells,
  barBox,
  centerDayAt,
  crossesRows,
  dayCenter,
  dayWindow,
  defaultTimeline,
  dependencyEdges,
  dragSpan,
  grabMode,
  initialDay,
  pageAt,
  recordSpan,
  rowStepAt,
  rowWindow,
  sameSpan,
  scrollLeftFor,
  scrollLeftForCenter,
  spanValues,
  timelineRange,
  timelineSetup,
  wholeDays,
  type AxisCell,
  type AxisUnit,
  type DaySpan,
  type DragMode,
  type TimelineSetup,
} from './timeline-model';
import type { ViewProps } from './types';

/** A mouse press becomes a drag after this many px; a finger holds still this long first. */
const MOUSE_SLOP = space['1'];
const TOUCH_SLOP = space['2'];
const LONG_PRESS_MS = 350;
/** How near a bar's ends a press takes the end instead of the bar. */
const EDGE_MOUSE = space['2'];
const EDGE_TOUCH = space['4'];
/** Near the sides of the time area a drag scrolls it, up to this many px a frame. */
const AUTO_SCROLL_ZONE = space['10'];
const AUTO_SCROLL_MAX = space['4'];
/** Bars this wide carry their title inside; thinner ones have it beside them. */
const LABEL_INSIDE = space['16'];
const LABEL_GAP = space['2'];
const KEYS_RESIZE = 'Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight';
const KEYS_MOVE = 'Alt+ArrowLeft Alt+ArrowRight';

export function TimelineView(props: ViewProps) {
  const { config, fields } = props;
  const setup = useMemo(() => timelineSetup(config, fields), [config, fields]);
  if (!setup) return <NeedsSetup {...props} />;
  if (!props.data.items.length) return <NoRecords {...props} setup={setup} />;
  return <Timeline key={props.view.id} {...props} setup={setup} />;
}

function NeedsSetup({ config, fields, onConfig }: ViewProps) {
  const { t } = useI18n();
  const next = defaultTimeline(config, fields);
  return (
    <Empty
      icon={<ChartGantt />}
      title={t('tables.viewNeeds.timeline')}
      action={next ? <Button onClick={() => onConfig(next)}>{t('tables.viewNeedsAction')}</Button> : undefined}
    />
  );
}

/** Like the grid: nothing matches the filter, or nothing yet (a new record starts today). */
function NoRecords({
  config,
  canEdit,
  lookups,
  onConfig,
  onCreate,
  onOpen,
  setup,
}: ViewProps & { setup: TimelineSetup }) {
  const { t } = useI18n();
  const filtered = !!config.filter?.clauses.length;
  const create = async () => {
    const today = todayIn(lookups.timeZone);
    const made = await onCreate({ [setup.start.id]: valueForDay(setup.start, today, undefined, lookups.timeZone) });
    if (made) onOpen(made.id);
  };
  return (
    <Empty
      icon={<ChartGantt />}
      title={filtered ? t('tables.grid.noMatch') : t('tables.grid.noRecords')}
      action={
        filtered ? (
          <Button onClick={() => onConfig({ ...config, filter: undefined })}>{t('tables.grid.clearFilters')}</Button>
        ) : canEdit ? (
          <Button kind="primary" onClick={() => void create()}>
            {t('tables.addRecord')}
          </Button>
        ) : undefined
      }
    />
  );
}

/** A bar being dragged, as drawn. */
interface Preview {
  id: string;
  mode: DragMode;
  span: DaySpan;
}

interface Drag extends Preview {
  origin: DaySpan;
  pointerId: number;
  touch: boolean;
  element: HTMLElement;
  startX: number;
  startY: number;
  /** The pointer's day, with its fraction, when pressed. */
  startDay: number;
  lastX: number;
  active: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  frame: number | null;
  speed: number;
  /** Puts the bar under the pointer again (after the pointer moved or the view scrolled). */
  update: () => void;
  stop: () => void;
}

/** What event handlers and effects read between renders. */
interface Live {
  from: number;
  px: number;
  titleWidth: number;
  rowHeight: number;
  timeViewport: number;
  today: number;
  daySpans: ReadonlyMap<string, DaySpan | null>;
  byId: ReadonlyMap<string, TableRecord>;
  setup: TimelineSetup;
  timeZone: string;
  onChange: ViewProps['onChange'];
  /** Says why a save failed (a conflict is handled by the page and does not fail). */
  fail: (error: unknown) => void;
}

const byAttribute = (root: HTMLElement | null, name: string, id: string, inner = '') =>
  root?.querySelector<HTMLElement>(`[${name}="${CSS.escape(id)}"]${inner}`) ?? null;

function Timeline(props: ViewProps & { setup: TimelineSetup }) {
  const { setup, data, fields, config, lookups, narrow, onConfig, onOpen } = props;
  const canEdit = props.canEdit && !isComputedType(setup.start.type) && !(setup.end && isComputedType(setup.end.type));
  const { t, locale } = useI18n();
  const notify = useNotify();
  const timeZone = lookups.timeZone;
  const scale: TimelineScale = setup.timeline.scale ?? 'week';
  const px = SCALE_DAY_PX[scale];
  const rowHeight = narrow ? ROW_HEIGHT_NARROW : ROW_HEIGHT;
  const titleWidth = narrow ? TITLE_WIDTH_NARROW : TITLE_WIDTH;
  const indent = narrow ? space['3'] : space['4'];
  const today = useMemo(() => dayNumber(todayIn(timeZone)), [timeZone]);
  const items = data.items;

  // ── Spans, rows and arrows: once per change of the records ──
  const { spans, daySpans } = useMemo(() => {
    const spans = new Map<string, Span | null>();
    const daySpans = new Map<string, DaySpan | null>();
    for (const record of items) {
      const entry = recordSpan(record, setup.start, setup.end, timeZone);
      spans.set(record.id, entry?.span ?? null);
      daySpans.set(record.id, entry?.days ?? null);
    }
    return { spans, daySpans };
  }, [items, setup.start, setup.end, timeZone]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () => timelineRows(items, spans, setup.parent, collapsed),
    [items, spans, setup.parent, collapsed],
  );
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.record.id, index])), [rows]);
  const byId = useMemo(() => new Map(items.map((record) => [record.id, record])), [items]);
  const milestones = useMemo(
    () => new Set(items.filter((record) => isMilestone(record, setup.timeline, fields)).map((record) => record.id)),
    [items, setup.timeline, fields],
  );
  const edges = useMemo(() => dependencyEdges(rows, setup.dependency?.id), [rows, setup.dependency]);
  const unscheduled = useMemo(() => items.filter((record) => !daySpans.get(record.id)).length, [items, daySpans]);
  const firstUnscheduled = useMemo(() => rows.findIndex((row) => !daySpans.get(row.record.id)), [rows, daySpans]);
  const twisty = useMemo(() => rows.some((row) => row.hasChildren), [rows]);

  // ── The box the view has, and the days it shows ──
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const timeViewport = Math.max(0, viewport.width - titleWidth);
  const minDays = timeViewport ? Math.ceil(timeViewport / px) + 1 : 0;
  const { from, to } = useMemo(
    () => timelineRange(daySpans.values(), today, scale, minDays),
    [daySpans, today, scale, minDays],
  );
  const total = to - from + 1;
  const timeWidth = total * px;
  const bodyHeight = Math.max(rows.length * rowHeight, viewport.height - HEADER_HEIGHT);

  // ── A drag on screen, saves on their way, the focused row ──
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, DaySpan>>(() => new Map());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const display = (id: string): DaySpan | null =>
    preview?.id === id ? preview.span : (pending.get(id) ?? daySpans.get(id) ?? null);

  const live = useRef<Live | null>(null);
  const snapshot: Live = {
    from,
    px,
    titleWidth,
    rowHeight,
    timeViewport,
    today,
    daySpans,
    byId,
    setup,
    timeZone,
    onChange: props.onChange,
    fail: (error) => notify(tablesError(error, t)),
  };
  // First of the layout effects, so the ones below and every handler read this render.
  useLayoutEffect(() => {
    live.current = snapshot;
  });

  const drag = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);

  // ── Scrolling: the rows and header cells drawn follow it in steps ──
  const [pos, setPos] = useState({ step: 0, page: 0 });
  const center = useRef<number | null>(null);
  const sync = useCallback(() => {
    const element = scroller.current;
    const now = live.current;
    if (!element || !now) return;
    const next = {
      step: rowStepAt(element.scrollTop, now.rowHeight),
      page: pageAt(element.scrollLeft, now.timeViewport),
    };
    setPos((prev) => (prev.step === next.step && prev.page === next.page ? prev : next));
    if (now.timeViewport) center.current = centerDayAt(element.scrollLeft, now.from, now.px, now.timeViewport);
    if (drag.current?.active) drag.current.update();
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setViewport((prev) =>
        prev.width === element.clientWidth && prev.height === element.clientHeight
          ? prev
          : { width: element.clientWidth, height: element.clientHeight },
      );
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  // Opens on today (or where the records begin); keeps the middle day when the scale changes and
  // the same days in view when the range grows on the left.
  const placed = useRef<{ from: number; px: number } | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    const now = live.current;
    if (!element || !now?.timeViewport) return;
    const before = placed.current;
    if (!before) {
      const day = initialDay(now.daySpans.values(), now.today);
      element.scrollLeft = scrollLeftFor(day, now.from, now.px, now.timeViewport, 0.3);
    } else if (before.px !== now.px) {
      element.scrollLeft = scrollLeftForCenter(center.current ?? now.today + 0.5, now.from, now.px, now.timeViewport);
    } else if (before.from !== now.from) {
      element.scrollLeft += (before.from - now.from) * now.px;
    } else return;
    placed.current = { from: now.from, px: now.px };
    sync();
  }, [from, px, timeViewport, sync]);
  useLayoutEffect(() => sync(), [rowHeight, timeViewport, rows.length, sync]);

  const rowsDrawn = rowWindow(pos.step, (viewport.height || 800) - HEADER_HEIGHT, rowHeight, rows.length);
  const daysDrawn = dayWindow(pos.page, timeViewport || 1200, px, total);
  const axis = useMemo(() => {
    const units = AXIS_UNITS[scale];
    const range = { from, to };
    const first = from + daysDrawn.first;
    const last = from + daysDrawn.last;
    return { upper: axisCells(units.upper, range, first, last), lower: axisCells(units.lower, range, first, last) };
  }, [scale, from, to, daysDrawn.first, daysDrawn.last]);

  // ── Saving: one change of a record at a time, the newest wins ──
  const saves = useRef({
    /** The span a record should get, not sent yet. */
    targets: new Map<string, DaySpan>(),
    busy: new Set<string>(),
    /** The revision the last save of a record was based on: the next waits for a newer one. */
    sent: new Map<string, number>(),
  });
  const settle = useCallback(
    (id: string) =>
      setPending((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }),
    [],
  );
  const flush = useCallback(
    (id: string) => {
      const queue = saves.current;
      const now = live.current;
      const target = queue.targets.get(id);
      if (!now || !target || queue.busy.has(id)) return;
      const record = now.byId.get(id);
      if (!record) {
        queue.targets.delete(id);
        settle(id);
        return;
      }
      const sent = queue.sent.get(id);
      if (sent !== undefined && record.revision <= sent) return; // the saved record is still on its way
      queue.targets.delete(id);
      const values = spanValues(record, target, now.setup.start, now.setup.end, now.timeZone);
      if (!Object.keys(values).length) {
        settle(id);
        return;
      }
      queue.busy.add(id);
      void now
        .onChange(record, values)
        .then(
          () => void queue.sent.set(id, record.revision),
          (error: unknown) => {
            queue.targets.delete(id);
            queue.sent.delete(id);
            now.fail(error);
          },
        )
        .finally(() => {
          queue.busy.delete(id);
          if (queue.targets.has(id)) flush(id);
          else settle(id);
        });
    },
    [settle],
  );
  // A newer revision arrived: send what waited for it.
  useEffect(() => {
    for (const id of [...saves.current.targets.keys()]) flush(id);
  }, [items, flush]);
  const commit = useCallback(
    (id: string, span: DaySpan) => {
      saves.current.targets.set(id, span);
      setPending((prev) => new Map(prev).set(id, span));
      flush(id);
    },
    [flush],
  );

  // ── Dragging ──
  useEffect(() => () => drag.current?.stop(), []);
  // Once a finger is dragging a bar, the view must not scroll under it.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const hold = (event: TouchEvent) => {
      if (drag.current?.active && event.cancelable) event.preventDefault();
    };
    element.addEventListener('touchmove', hold, { passive: false });
    return () => element.removeEventListener('touchmove', hold);
  }, []);

  /** The day (with its fraction) under a pointer. */
  const pointerDay = (clientX: number) => {
    const element = scroller.current!;
    const now = live.current!;
    const left = element.getBoundingClientRect().left + element.clientLeft;
    return now.from + (clientX - left - now.titleWidth + element.scrollLeft) / now.px;
  };

  const startDrag = (bar: HTMLElement, event: PointerEvent<HTMLElement>, id: string, origin: DaySpan) => {
    const touch = event.pointerType === 'touch';
    const rect = bar.getBoundingClientRect();
    const mode: DragMode =
      bar.dataset.kind === 'milestone' || !setup.end
        ? 'move'
        : grabMode(event.clientX - rect.left, rect.width, touch ? EDGE_TOUCH : EDGE_MOUSE);
    drag.current?.stop();
    const d: Drag = {
      id,
      mode,
      span: origin,
      origin,
      pointerId: event.pointerId,
      touch,
      element: bar,
      startX: event.clientX,
      startY: event.clientY,
      startDay: pointerDay(event.clientX),
      lastX: event.clientX,
      active: false,
      cancelled: false,
      timer: null,
      frame: null,
      speed: 0,
      update: () => {
        if (d.cancelled) return;
        const span = dragSpan(d.origin, d.mode, wholeDays(pointerDay(d.lastX) - d.startDay));
        if (sameSpan(span, d.span)) return;
        d.span = span;
        setPreview({ id: d.id, mode: d.mode, span });
      },
      stop: () => {},
    };
    const update = d.update;
    const activate = () => {
      d.timer = null;
      d.active = true;
      if (!d.touch) {
        try {
          d.element.setPointerCapture(d.pointerId);
        } catch {
          // The pointer is already gone; its pointerup ends the drag.
        }
      }
      setPreview({ id: d.id, mode: d.mode, span: d.span });
    };
    const autoScroll = (clientX: number) => {
      const element = scroller.current;
      const now = live.current;
      if (!element || !now) return;
      const rect = element.getBoundingClientRect();
      const left = rect.left + now.titleWidth + AUTO_SCROLL_ZONE;
      const right = rect.right - AUTO_SCROLL_ZONE;
      const depth =
        clientX > right
          ? (clientX - right) / AUTO_SCROLL_ZONE
          : clientX < left
            ? (clientX - left) / AUTO_SCROLL_ZONE
            : 0;
      d.speed = Math.round(Math.max(-1, Math.min(1, depth)) * AUTO_SCROLL_MAX);
      if (!d.speed || d.frame !== null) return;
      const step = () => {
        d.frame = null;
        if (drag.current !== d || !d.active || d.cancelled || !d.speed) return;
        element.scrollLeft += d.speed;
        update();
        d.frame = requestAnimationFrame(step);
      };
      d.frame = requestAnimationFrame(step);
    };
    const finish = (apply: boolean) => {
      d.stop();
      if (drag.current === d) drag.current = null;
      if (!d.active) return;
      // The click that follows a drag does not open the record.
      suppressClickUntil.current = performance.now() + 400;
      if (apply && !d.cancelled && !sameSpan(d.span, d.origin)) commit(d.id, d.span);
      setPreview(null);
    };
    const move = (moved: globalThis.PointerEvent) => {
      if (moved.pointerId !== d.pointerId || d.cancelled) return;
      // The button came up where we did not hear it (outside the window): drop nothing.
      if (!d.touch && moved.buttons === 0) {
        finish(false);
        return;
      }
      d.lastX = moved.clientX;
      if (!d.active) {
        const distance = Math.hypot(moved.clientX - d.startX, moved.clientY - d.startY);
        // A finger that moves before the long press is scrolling.
        if (d.touch) {
          if (distance > TOUCH_SLOP) finish(false);
          return;
        }
        if (distance < MOUSE_SLOP) return;
        activate();
      }
      update();
      autoScroll(moved.clientX);
    };
    const up = (released: globalThis.PointerEvent) => {
      if (released.pointerId === d.pointerId) finish(true);
    };
    const cancel = (cancelled: globalThis.PointerEvent) => {
      if (cancelled.pointerId === d.pointerId) finish(false);
    };
    const escape = (pressed: globalThis.KeyboardEvent) => {
      if (pressed.key !== 'Escape' || !d.active || d.cancelled) return;
      pressed.preventDefault();
      pressed.stopPropagation();
      d.cancelled = true;
      setPreview(null);
    };
    d.stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape, true);
      if (d.timer) clearTimeout(d.timer);
      if (d.frame !== null) cancelAnimationFrame(d.frame);
      d.timer = null;
      d.frame = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape, true);
    if (touch) d.timer = setTimeout(activate, LONG_PRESS_MS);
    drag.current = d;
  };

  // ── Events of the rows, handled once for all of them ──
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canEdit || event.button !== 0 || !event.isPrimary) return;
    const bar = (event.target as HTMLElement).closest<HTMLElement>('[data-bar]');
    const id = bar?.dataset.bar;
    const origin = id ? display(id) : null;
    if (bar && id && origin) startDrag(bar, event, id, origin);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const toggle = target.closest<HTMLElement>('[data-toggle]')?.dataset.toggle;
    if (toggle) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(toggle)) next.add(toggle);
        return next;
      });
      return;
    }
    const open = target.closest<HTMLElement>('[data-open]')?.dataset.open;
    if (open && performance.now() >= suppressClickUntil.current) onOpen(open);
  };

  // A bar moved by keys stays in view, also when the move takes its row elsewhere.
  const follow = useRef<{ id: string; index: number; start: number; end: number } | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canEdit || !event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const bar = (event.target as HTMLElement).closest<HTMLElement>('[data-bar]');
    const id = bar?.dataset.bar;
    const span = id ? display(id) : null;
    const record = id ? byId.get(id) : undefined;
    if (!bar || !id || !span || !record) return;
    event.preventDefault();
    const milestone = bar.dataset.kind === 'milestone';
    if (event.shiftKey && (milestone || !setup.end)) return;
    const next = dragSpan(span, event.shiftKey ? 'end' : 'move', event.key === 'ArrowRight' ? 1 : -1);
    if (sameSpan(next, span)) return;
    commit(id, next);
    follow.current = { id, index: -1, start: Number.NaN, end: Number.NaN };
    const name = titleOf(fields, record) || t('tables.record.untitled');
    const start = shortDay(dayOf(next.start), locale);
    const end = shortDay(dayOf(next.end), locale);
    setAnnouncement(
      milestone || next.start === next.end
        ? t('tables.timeline.movedTo', { name, date: milestone ? end : start })
        : t('tables.timeline.moved', { name, start, end }),
    );
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-row]')?.dataset.row ?? null;
    if (follow.current && follow.current.id !== id) follow.current = null;
    setFocusId(id);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    follow.current = null;
    setFocusId(null);
  };

  useLayoutEffect(() => {
    const target = follow.current;
    if (!target) return;
    const index = rowIndex.get(target.id);
    const span = display(target.id);
    if (index === undefined || !span) {
      follow.current = null;
      return;
    }
    if (index === target.index && span.start === target.start && span.end === target.end) return;
    Object.assign(target, { index, start: span.start, end: span.end });
    byAttribute(scroller.current, 'data-bar', target.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  // 「未排期 N 条」 brings the first record without dates into view and focuses its title.
  const reveal = useRef<string | null>(null);
  const showUnscheduled = () => {
    const row = rows[firstUnscheduled];
    if (!row) return;
    reveal.current = row.record.id;
    setFocusId(row.record.id);
  };
  useLayoutEffect(() => {
    const id = reveal.current;
    const name = id ? byAttribute(scroller.current, 'data-row', id, ' .app-tb-tl-name') : null;
    if (!name) return;
    reveal.current = null;
    name.scrollIntoView({ block: 'center', inline: 'nearest' });
    name.focus({ preventScroll: true });
  });

  // ── The toolbar ──
  const scales = useMemo(() => TIMELINE_SCALES.map((value) => ({ value, label: t(`tables.scale.${value}`) })), [t]);
  const setScale = (value: string) => {
    const next = TIMELINE_SCALES.find((entry) => entry === value);
    if (next && next !== scale) onConfig({ ...config, timeline: { ...setup.timeline, scale: next } });
  };
  const behavior = (): ScrollBehavior =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const goToday = () =>
    scroller.current?.scrollTo({ left: scrollLeftFor(today, from, px, timeViewport), behavior: behavior() });
  const turn = (direction: 1 | -1) =>
    scroller.current?.scrollBy({ left: direction * Math.round(timeViewport * 0.8), behavior: behavior() });
  const unscheduledLabel = t('tables.timeline.unscheduled', {
    count: unscheduled.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US'),
  });

  // ── What is drawn: rows in view, plus the focused and the dragged one wherever they are ──
  const drawn: number[] = [];
  for (let index = rowsDrawn.first; index <= rowsDrawn.last; index++) drawn.push(index);
  for (const id of [focusId, preview?.id]) {
    const index = id ? rowIndex.get(id) : undefined;
    if (index !== undefined && (index < rowsDrawn.first || index > rowsDrawn.last) && !drawn.includes(index)) {
      drawn.push(index);
    }
  }
  const lit = (id: string) => id === focusId || id === preview?.id;
  const arrows = edges.flatMap((edge) => {
    if (!crossesRows(edge, rowsDrawn.first, rowsDrawn.last)) return [];
    const before = display(edge.from);
    const after = display(edge.to);
    if (!before || !after) return [];
    return [
      {
        key: `${edge.from}>${edge.to}`,
        x1: anchorsOf(before, milestones.has(edge.from), from, px).right,
        y1: (edge.fromRow + 0.5) * rowHeight,
        x2: anchorsOf(after, milestones.has(edge.to), from, px).left,
        y2: (edge.toRow + 0.5) * rowHeight,
        active: lit(edge.from) || lit(edge.to),
      },
    ];
  });
  // The lit arrows on top; the drawing only as big as the arrows.
  arrows.sort((a, b) => Number(a.active) - Number(b.active));
  const box = arrowBox(arrows);

  return (
    <div
      className={cx(
        'app-tb-tl',
        narrow && 'is-narrow',
        canEdit && 'is-editable',
        preview && 'is-dragging',
        preview && `is-${preview.mode}`,
      )}
      style={{ '--app-tb-tl-title': `${titleWidth}px`, '--app-tb-tl-row': `${rowHeight}px` } as CSSProperties}
    >
      <div className="app-tb-tl-tools">
        <Segmented label={t('tables.settings.scale')} items={scales} value={scale} onChange={setScale} />
        <span className="app-tb-tl-nav">
          <IconButton size="sm" label={t('tables.timeline.prev')} onClick={() => turn(-1)}>
            <ChevronLeft size={icon.md} strokeWidth={icon.stroke} />
          </IconButton>
          <Button size="sm" onClick={goToday}>
            {t('tables.timeline.today')}
          </Button>
          <IconButton size="sm" label={t('tables.timeline.next')} onClick={() => turn(1)}>
            <ChevronRight size={icon.md} strokeWidth={icon.stroke} />
          </IconButton>
        </span>
        {unscheduled > 0 &&
          (firstUnscheduled >= 0 ? (
            <Button kind="ghost" size="sm" className="app-tb-tl-unscheduled" onClick={showUnscheduled}>
              {unscheduledLabel}
            </Button>
          ) : (
            <span className="app-tb-tl-unscheduled">{unscheduledLabel}</span>
          ))}
      </div>
      <div
        ref={scroller}
        className="app-tb-tl-scroll"
        role="region"
        aria-label={t('tables.timeline.label')}
        onScroll={sync}
      >
        <div className="app-tb-tl-content" style={{ width: titleWidth + timeWidth }}>
          <TimelineHeader scale={scale} from={from} px={px} width={timeWidth} today={today} {...axis} />
          <div
            className="app-tb-tl-body"
            style={{ height: bodyHeight }}
            onPointerDown={onPointerDown}
            onClick={onClick}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onBlur={onBlur}
            onContextMenu={(event) => drag.current && event.preventDefault()}
          >
            <div className="app-tb-tl-rail" />
            <div
              className={cx('app-tb-tl-grid', `is-${scale}`)}
              style={{ left: titleWidth, width: timeWidth, '--app-tb-tl-day': `${px}px` } as CSSProperties}
            >
              {scale === 'month' &&
                axis.lower.map((cell) => (
                  <span key={cell.start} className="app-tb-tl-vline" style={{ left: (cell.start - from) * px }} />
                ))}
            </div>
            {today >= from && today <= to && (
              <div className="app-tb-tl-today" style={{ left: titleWidth + dayCenter(today, from, px) }} />
            )}
            {box && (
              <svg
                className="app-tb-tl-arrows"
                style={{ left: titleWidth + box.left, top: box.top }}
                width={box.width}
                height={box.height}
                aria-hidden
              >
                {arrows.map(({ key, x1, y1, x2, y2, active }) => (
                  <g key={key} className={cx('app-tb-tl-arrow', active && 'is-active')}>
                    <path d={arrowPath(x1 - box.left, y1 - box.top, x2 - box.left, y2 - box.top, rowHeight)} />
                    <path d={arrowHead(x2 - box.left, y2 - box.top)} className="app-tb-tl-arrow-head" />
                  </g>
                ))}
              </svg>
            )}
            {drawn.map((index) => {
              const row = rows[index]!;
              const id = row.record.id;
              return (
                <TimelineRowView
                  key={id}
                  row={row}
                  index={index}
                  rowHeight={rowHeight}
                  titleWidth={titleWidth}
                  indent={indent}
                  twisty={twisty}
                  collapsed={collapsed.has(id)}
                  title={titleOf(fields, row.record)}
                  span={display(id)}
                  milestone={milestones.has(id)}
                  from={from}
                  px={px}
                  editable={canEdit}
                  resizable={canEdit && !!setup.end}
                  dragMode={preview?.id === id ? preview.mode : null}
                />
              );
            })}
          </div>
        </div>
      </div>
      <div className="app-sr-only" role="status">
        {announcement}
      </div>
    </div>
  );
}

/** The header: month or year over days, weeks or months; its labels stay in view while scrolling. */
const TimelineHeader = memo(function TimelineHeader({
  scale,
  from,
  px,
  width,
  today,
  upper,
  lower,
}: {
  scale: TimelineScale;
  from: number;
  px: number;
  width: number;
  today: number;
  upper: AxisCell[];
  lower: AxisCell[];
}) {
  const { t } = useI18n();
  const months = useMemo(() => t('tables.timeline.months').split(','), [t]);
  const units = AXIS_UNITS[scale];
  const label = (unit: AxisUnit, cell: AxisCell, top: boolean) => {
    const month = months[cell.month - 1] ?? String(cell.month);
    switch (unit) {
      case 'year':
        return t('tables.timeline.year', { year: cell.year });
      case 'month':
        return top ? t('tables.timeline.monthOfYear', { year: cell.year, month }) : month;
      case 'week':
        return t('tables.timeline.monthDay', { month: cell.month, day: cell.date });
      case 'day':
        return String(cell.date);
    }
  };
  const cells = (list: AxisCell[], unit: AxisUnit, top: boolean) =>
    list.map((cell) => (
      <div
        key={cell.start}
        className={cx('app-tb-tl-cell', !top && today >= cell.start && today <= cell.end && 'is-today')}
        style={{ left: (cell.start - from) * px, width: (cell.end - cell.start + 1) * px }}
      >
        <span className="app-tb-tl-cell-text">{label(unit, cell, top)}</span>
      </div>
    ));
  return (
    <div className="app-tb-tl-head">
      <div className="app-tb-tl-corner">{t('tables.timeline.records')}</div>
      <div className={cx('app-tb-tl-axis', `is-${scale}`)} style={{ width }} aria-hidden>
        <div className="app-tb-tl-tier is-upper">{cells(upper, units.upper, true)}</div>
        <div className="app-tb-tl-tier is-lower">{cells(lower, units.lower, false)}</div>
        {today >= from && today < from + width / px && (
          <span className="app-tb-tl-today-mark" style={{ left: dayCenter(today, from, px) }} />
        )}
      </div>
    </div>
  );
});

interface RowProps {
  row: TimelineRow;
  index: number;
  rowHeight: number;
  titleWidth: number;
  indent: number;
  /** Some row has children: every title leaves room for the chevron. */
  twisty: boolean;
  collapsed: boolean;
  title: string;
  span: DaySpan | null;
  milestone: boolean;
  from: number;
  px: number;
  editable: boolean;
  resizable: boolean;
  dragMode: DragMode | null;
}

/** One record: its title and its bar or diamond. Redrawn only when something it shows changes. */
const TimelineRowView = memo(function TimelineRowView({
  row,
  index,
  rowHeight,
  titleWidth,
  indent,
  twisty,
  collapsed,
  title,
  span,
  milestone,
  from,
  px,
  editable,
  resizable,
  dragMode,
}: RowProps) {
  const { t, locale } = useI18n();
  const id = row.record.id;
  const name = title || t('tables.record.untitled');
  let mark = null;
  if (span && milestone) {
    const center = titleWidth + dayCenter(span.end, from, px);
    const date = shortDay(dayOf(span.end), locale);
    mark = (
      <>
        <button
          type="button"
          className={cx('app-tb-tl-milestone', dragMode && 'is-dragging')}
          style={{ left: center }}
          data-bar={id}
          data-kind="milestone"
          data-open={id}
          aria-label={t('tables.timeline.milestone', { name, date })}
          aria-keyshortcuts={editable ? KEYS_MOVE : undefined}
        >
          <span className="app-tb-tl-diamond" />
        </button>
        <span className="app-tb-tl-aside is-after-mark" style={{ left: center }} aria-hidden>
          {name}
        </span>
        {dragMode && (
          <span
            className={cx('app-tb-tl-tip is-centered', index === 0 && 'is-below')}
            style={{ left: center }}
            aria-hidden
          >
            {date}
          </span>
        )}
      </>
    );
  } else if (span) {
    const box = barBox(span, from, px);
    const left = titleWidth + box.left;
    const start = shortDay(dayOf(span.start), locale);
    const end = shortDay(dayOf(span.end), locale);
    const inside = box.width >= LABEL_INSIDE;
    mark = (
      <>
        <button
          type="button"
          className={cx('app-tb-tl-bar', row.hasChildren && 'is-parent', dragMode && 'is-dragging')}
          style={{ left, width: box.width }}
          data-bar={id}
          data-open={id}
          aria-label={t('tables.timeline.bar', { name, start, end })}
          aria-keyshortcuts={editable ? (resizable ? KEYS_RESIZE : KEYS_MOVE) : undefined}
        >
          {inside && <span className="app-tb-tl-bar-text">{name}</span>}
          {resizable && box.width >= EDGE_MOUSE * 3 && (
            <>
              <span className="app-tb-tl-grip is-start" />
              <span className="app-tb-tl-grip is-end" />
            </>
          )}
        </button>
        {!inside && (
          <span className="app-tb-tl-aside" style={{ left: left + box.width + LABEL_GAP }} aria-hidden>
            {name}
          </span>
        )}
        {dragMode && (
          <span className={cx('app-tb-tl-tip', index === 0 && 'is-below')} style={{ left }} aria-hidden>
            {span.start === span.end ? start : t('tables.timeline.range', { start, end })}
          </span>
        )}
      </>
    );
  }
  return (
    <div className="app-tb-tl-row" data-row={id} style={{ top: index * rowHeight, height: rowHeight }}>
      <div className="app-tb-tl-title" style={{ paddingLeft: space['2'] + row.depth * indent }}>
        {twisty &&
          (row.hasChildren ? (
            <IconButton
              size="sm"
              className="app-tb-tl-twisty"
              label={t(collapsed ? 'tables.timeline.expand' : 'tables.timeline.collapse', { name })}
              aria-expanded={!collapsed}
              data-toggle={id}
            >
              <ChevronRight
                size={icon.sm}
                strokeWidth={icon.stroke}
                className={cx('app-tb-tl-chevron', !collapsed && 'is-open')}
              />
            </IconButton>
          ) : (
            <span className="app-tb-tl-twisty-space" aria-hidden />
          ))}
        <button
          type="button"
          className={cx('app-tb-tl-name', !title && 'is-untitled', row.hasChildren && 'is-parent')}
          data-open={id}
        >
          {name}
        </button>
      </div>
      {mark}
    </div>
  );
});
