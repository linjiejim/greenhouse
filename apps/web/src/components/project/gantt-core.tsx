/**
 * Gantt 共享引擎 — GanttView（单项目）与 GlobalGanttView（跨项目）的公共骨架。
 *
 * 负责：时间轴数学（表头/周末列/Today 高亮）、左右滚动同步、bar 几何与配色、
 *       拖拽（移动/调宽/拖拽创建/拖拽排序接线）、批量选择与批量操作条、
 *       右键菜单接线、键盘导航、依赖箭头、删除确认、MiniMap、渲染骨架。
 * 不负责：数据获取、行模型构建（展开/折叠/过滤/分组）、乐观更新、抽屉/弹窗 —
 *         由两个薄壳通过 props 注入（行渲染器、回调、特性开关）。
 */

import React, { useRef, useMemo, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { StatusIcon } from './task-tree';
import { authFetch } from '../../lib/auth';
import { ChevronDown, ChevronRight, GripVertical, User } from '../../lib/icons';
import { statusConfig } from './types';
import { toast, Select, ConfirmDialog } from '../ui';
import type { Task } from './types';
import { parseDeps, dateToStr, daysBetween, isWeekend } from './gantt-utils';
import type { GanttDateRange } from './gantt-utils';
import { GanttContextMenu } from './gantt-context-menu';
import type { GanttContextMenuProject } from './gantt-context-menu';
import { GanttMiniMap } from './gantt-minimap';
import { useT } from '../../lib/i18n';

// ─── Types ───────────────────────────────────────────────

export type GanttCoreZoom = 'day' | 'week' | 'month' | 'year';

/** Task carrying flattened-row metadata (depth/isParent), as built by the shells. */
export type GanttTaskItem = Task & { depth: number; isParent: boolean };

/** Task as needed by bar-style computation (minimap calls without depth). */
export type GanttBarTask = Task & { isParent: boolean };

export interface GanttTaskRow<TData> {
  kind: 'task';
  key: string;
  task: GanttTaskItem;
  data: TData;
}

export interface GanttGroupRow<GData> {
  kind: 'group';
  key: string;
  data: GData;
}

export type GanttRow<TData, GData> = GanttTaskRow<TData> | GanttGroupRow<GData>;

export interface GanttBarStyle {
  left: number;
  width: number;
  bgColor: string;
  isParent: boolean;
  isMilestone: boolean;
  progress: number;
  isDarkBg: boolean;
}

interface DragState {
  taskId: number;
  mode: 'move' | 'resize-start' | 'resize-end';
  origStart: string | null;
  origEnd: string | null;
  deltaDays: number;
}

/** Prebuilt row pieces handed to the shells' row renderers. */
export interface GanttRowCtx {
  dragGrip: ReactNode;
  expandToggle: (task: GanttTaskItem) => ReactNode;
  batchCheckbox: (taskId: number) => ReactNode;
  statusIcon: (task: GanttTaskItem) => ReactNode;
  titleSpan: (task: GanttTaskItem) => ReactNode;
  assigneeSpan: (task: GanttTaskItem) => ReactNode;
  openContextMenu: (x: number, y: number, task: Task) => void;
}

export const GANTT_ROW_HEIGHT = 36;

export function ganttDayWidth(zoom: GanttCoreZoom): number {
  return zoom === 'year' ? 3 : zoom === 'month' ? 8 : zoom === 'week' ? 14 : 28;
}

export interface GanttCoreProps<TData, GData> {
  rows: Array<GanttRow<TData, GData>>;
  zoom: GanttCoreZoom;
  range: GanttDateRange;
  users?: Array<{ id: string; nickname: string }>;
  /** Left label panel width in px. */
  labelWidth: number;
  /** Base left padding (px) before depth indent in left-panel task rows. */
  indentBase: number;
  /** Extra classes appended to task row container (e.g. 'group/row'). */
  taskRowClassName?: string;
  /** Extra classes appended to the left panel container (e.g. 'relative'). */
  leftPanelClassName?: string;
  /** SVG marker id for dependency arrowheads (must be unique per view). */
  arrowMarkerId: string;
  /** Show the status pill on task bars (single-project view only). */
  showBarStatusPill?: boolean;
  /** Full header element of the left panel. */
  leftHeader: ReactNode;
  /** Extra node inside the left panel (e.g. resize handle). */
  leftPanelExtra?: ReactNode;
  isTaskExpanded: (id: number) => boolean;
  onToggleTask: (id: number) => void;
  /** Content of a task row in the left panel (container/handlers provided by core). */
  renderTaskRow: (row: GanttTaskRow<TData>, ctx: GanttRowCtx) => ReactNode;
  /** Full row element for a group row in the left panel. */
  renderGroupRow?: (row: GanttGroupRow<GData>) => ReactNode;
  /** Full row element for a group row in the timeline. */
  renderGroupBar?: (row: GanttGroupRow<GData>) => ReactNode;
  /** Progress percent for a task bar (implementations differ per view). */
  progressFor: (task: GanttBarTask) => number;
  barTooltip: (row: GanttTaskRow<TData>, bar: GanttBarStyle) => string;
  barLeftBorder?: (row: GanttTaskRow<TData>) => string;
  /** Open a task (row click / bar click / Enter). */
  onRowOpen?: (task: Task) => void;
  /** Enter pressed on a focused group row. */
  onGroupEnter?: (row: GanttGroupRow<GData>) => void;
  /** Bar drag finished — persist new dates. */
  onBarDateChange: (task: Task, newStart: string | null, newEnd: string | null) => void;
  /** Drag-to-create finished. Enables drag-create when provided. */
  onDragCreate?: (startDate: string, endDate: string, rowIdx: number) => void;
  /** Resolve the drag-create row from the mouse Y position (cross-project view). */
  dragCreateByRow?: boolean;
  /** Row drag-sort drop — shells implement reorder/reparent/move semantics. */
  onSortDrop: (sourceId: number, targetIdx: number) => void;
  /** Batch action other than 'clear' — shells persist and call clear() as before. */
  onBatchAction: (action: string, value: string | undefined, ids: number[], clear: () => void) => void;
  /** Extra controls in the batch bar (e.g. move-to-project select). */
  renderBatchExtra?: (run: (action: string, value?: string) => void) => ReactNode;
  contextMenuProjects?: GanttContextMenuProject[];
  contextMenuTasks: Task[];
  onContextAction: (action: string, task: Task) => void;
  /** Delete-confirm state is shell-owned (the context menu 'delete' action sets it). */
  pendingDeleteTask: Task | null;
  setPendingDeleteTask: (task: Task | null) => void;
  /** Called after a confirmed delete succeeded. */
  onDeleted: (task: Task) => void;
  /** Skip keyboard shortcuts while a shell-owned modal/drawer is open. */
  isModalOpen?: boolean;
  /** Escape hook checked before core's pending-delete (return true if consumed). */
  onEscapeBefore?: () => boolean;
  /** Escape hook checked after core's pending-delete (return true if consumed). */
  onEscapeAfter?: () => boolean;
  /** Rendered inside the keyboard container (drawer/dialogs of the shells). */
  children?: ReactNode;
}

// ─── Component ───────────────────────────────────────────

export function GanttCore<TData, GData>({
  rows,
  zoom,
  range,
  users,
  labelWidth,
  indentBase,
  taskRowClassName,
  leftPanelClassName,
  arrowMarkerId,
  showBarStatusPill,
  leftHeader,
  leftPanelExtra,
  isTaskExpanded,
  onToggleTask,
  renderTaskRow,
  renderGroupRow,
  renderGroupBar,
  progressFor,
  barTooltip,
  barLeftBorder,
  onRowOpen,
  onGroupEnter,
  onBarDateChange,
  onDragCreate,
  dragCreateByRow,
  onSortDrop,
  onBatchAction,
  renderBatchExtra,
  contextMenuProjects,
  contextMenuTasks,
  onContextAction,
  pendingDeleteTask,
  setPendingDeleteTask,
  onDeleted,
  isModalOpen,
  onEscapeBefore,
  onEscapeAfter,
  children,
}: GanttCoreProps<TData, GData>) {
  const t = useT();
  const timelineRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragDidHappen = useRef(false);

  const { startDate, endDate, totalDays } = range;

  // Drag state
  const [dragState, setDragState] = useState<DragState | null>(null);

  // Drag-to-create state
  const [createDrag, setCreateDrag] = useState<{ startDay: number; currentDay: number } | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; task: Task } | null>(null);

  // Drag sort state
  const [dragSortState, setDragSortState] = useState<{ sourceId: number; overIndex: number } | null>(null);

  // Batch selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showBatchBar, setShowBatchBar] = useState(false);

  // Keyboard nav
  const [focusedRowIdx, setFocusedRowIdx] = useState(-1);

  const taskRows = useMemo(() => rows.filter((r): r is GanttTaskRow<TData> => r.kind === 'task'), [rows]);

  // ── Zoom ────────────────────────────────────────────────

  const DAY_WIDTH = ganttDayWidth(zoom);
  const ROW_HEIGHT = GANTT_ROW_HEIGHT;

  // ── Batch selection ─────────────────────────────────────

  const toggleSelected = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleRowSelect = useCallback(
    (e: React.MouseEvent, task: Task) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.has(task.id) ? next.delete(task.id) : next.add(task.id);
          return next;
        });
        setShowBatchBar(true);
        return true; // handled
      }
      if (e.shiftKey && selectedIds.size > 0) {
        e.preventDefault();
        const lastSelected = Array.from(selectedIds).pop()!;
        const lastIdx = taskRows.findIndex((r) => r.task.id === lastSelected);
        const curIdx = taskRows.findIndex((r) => r.task.id === task.id);
        if (lastIdx >= 0 && curIdx >= 0) {
          const start = Math.min(lastIdx, curIdx);
          const end = Math.max(lastIdx, curIdx);
          const next = new Set(selectedIds);
          for (let i = start; i <= end; i++) next.add(taskRows[i].task.id);
          setSelectedIds(next);
          setShowBatchBar(true);
        }
        return true;
      }
      return false; // not handled - parent should open drawer
    },
    [selectedIds, taskRows],
  );

  const clearBatch = useCallback(() => {
    setSelectedIds(new Set());
    setShowBatchBar(false);
  }, []);

  const runBatchAction = useCallback(
    (action: string, value?: string) => {
      if (selectedIds.size === 0) return;
      if (action === 'clear') {
        clearBatch();
        return;
      }
      onBatchAction(action, value, Array.from(selectedIds), clearBatch);
    },
    [selectedIds, onBatchAction, clearBatch],
  );

  // ── Today Offset ───────────────────────────────────────

  const todayOffset = useMemo(() => {
    const today = new Date();
    return Math.floor((today.getTime() - startDate.getTime()) / 86400000) * DAY_WIDTH;
  }, [startDate, DAY_WIDTH]);

  // Scroll to today on mount / zoom change
  useEffect(() => {
    if (timelineRef.current) {
      const scrollLeft = Math.max(0, todayOffset - 300);
      timelineRef.current.scrollLeft = scrollLeft;
    }
  }, [todayOffset]);

  // ── Timeline Headers ───────────────────────────────────

  const headers = useMemo(() => {
    const result: Array<{ label: string; left: number; width: number }> = [];
    if (zoom === 'year') {
      let d = new Date(startDate);
      d = new Date(d.getFullYear(), 0, 1);
      if (d < startDate) d = new Date(d.getFullYear() + 1, 0, 1);
      while (d <= endDate) {
        const left = Math.max(0, Math.floor((d.getTime() - startDate.getTime()) / 86400000)) * DAY_WIDTH;
        const nextYear = new Date(d.getFullYear() + 1, 0, 1);
        const daysInView = Math.min(
          Math.ceil((nextYear.getTime() - d.getTime()) / 86400000),
          Math.ceil((endDate.getTime() - d.getTime()) / 86400000),
        );
        result.push({ label: `${d.getFullYear()}`, left, width: daysInView * DAY_WIDTH });
        d = nextYear;
      }
    } else if (zoom === 'week') {
      let d = new Date(startDate);
      d.setDate(d.getDate() - d.getDay() + 1);
      while (d <= endDate) {
        const left = Math.max(0, Math.floor((d.getTime() - startDate.getTime()) / 86400000)) * DAY_WIDTH;
        const width = 7 * DAY_WIDTH;
        result.push({ label: `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`, left, width });
        d = new Date(d.getTime() + 7 * 86400000);
      }
    } else {
      let d = new Date(startDate);
      d.setDate(1);
      if (d < startDate) d.setMonth(d.getMonth() + 1);
      while (d <= endDate) {
        const left = Math.max(0, Math.floor((d.getTime() - startDate.getTime()) / 86400000)) * DAY_WIDTH;
        const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        const daysInView = Math.min(
          Math.ceil((nextMonth.getTime() - d.getTime()) / 86400000),
          Math.ceil((endDate.getTime() - d.getTime()) / 86400000),
        );
        result.push({
          label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
          left,
          width: daysInView * DAY_WIDTH,
        });
        d = nextMonth;
      }
    }
    return result;
  }, [startDate, endDate, zoom, DAY_WIDTH]);

  // ── Weekend columns ─────────────────────────────────────

  const weekendColumns = useMemo(() => {
    if (zoom !== 'day' && zoom !== 'week') return [];
    const cols: Array<{ left: number; width: number }> = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(startDate.getTime() + i * 86400000);
      if (isWeekend(d)) {
        cols.push({ left: i * DAY_WIDTH, width: DAY_WIDTH });
      }
    }
    return cols;
  }, [startDate, totalDays, zoom, DAY_WIDTH]);

  // ── Scroll Sync ─────────────────────────────────────────

  const handleLeftScroll = useCallback(() => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    if (timelineRef.current && leftPanelRef.current) {
      timelineRef.current.scrollTop = leftPanelRef.current.scrollTop;
    }
    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  }, []);

  const handleRightScroll = useCallback(() => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    if (leftPanelRef.current && timelineRef.current) {
      leftPanelRef.current.scrollTop = timelineRef.current.scrollTop;
    }
    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  }, []);

  // ── Bar Calculation ─────────────────────────────────────

  const getBar = useCallback(
    (tk: GanttBarTask, drag: DragState | null): GanttBarStyle | null => {
      const isMilestone = tk.task_type === 'milestone';
      let s = tk.start_date ? new Date(tk.start_date) : null;
      let e = tk.due_date ? new Date(tk.due_date) : null;
      if (!s && !e) return null;

      // Apply drag offset
      if (drag && drag.taskId === tk.id) {
        if (drag.mode === 'move') {
          if (s) s = new Date(s.getTime() + drag.deltaDays * 86400000);
          if (e) e = new Date(e.getTime() + drag.deltaDays * 86400000);
        } else if (drag.mode === 'resize-start' && s) {
          s = new Date(s.getTime() + drag.deltaDays * 86400000);
        } else if (drag.mode === 'resize-end' && e) {
          e = new Date(e.getTime() + drag.deltaDays * 86400000);
        }
      }

      const barStart = s ?? e!;
      const barEnd = e ?? s!;

      const left = Math.floor((barStart.getTime() - startDate.getTime()) / 86400000) * DAY_WIDTH;
      const width = isMilestone
        ? DAY_WIDTH
        : Math.max(1, Math.ceil((barEnd.getTime() - barStart.getTime()) / 86400000) + 1) * DAY_WIDTH;

      const today = new Date().toISOString().split('T')[0];
      const isOverdue = tk.due_date && tk.due_date < today && tk.status !== 'done' && tk.status !== 'cancelled';

      let bgColor = 'bg-surface-muted';
      let isDarkBg = false;
      if (tk.status === 'in_progress') {
        bgColor = 'bg-info';
        isDarkBg = true;
      } else if (tk.status === 'in_review') {
        bgColor = 'bg-warning';
        isDarkBg = true;
      } else if (tk.status === 'done') {
        bgColor = 'bg-success';
        isDarkBg = true;
      } else if (tk.status === 'cancelled') {
        bgColor = 'bg-fg-faint';
        isDarkBg = false;
      }
      if (isOverdue) {
        bgColor = 'bg-danger';
        isDarkBg = true;
      }

      const progress = progressFor(tk);

      return { left, width, bgColor, isParent: tk.isParent, isMilestone, progress, isDarkBg };
    },
    [startDate, DAY_WIDTH, progressFor],
  );

  // ── Drag Handlers ───────────────────────────────────────

  const handleBarMouseDown = useCallback(
    (e: React.MouseEvent, task: Task, mode: 'move' | 'resize-start' | 'resize-end') => {
      e.stopPropagation();
      e.preventDefault();

      const startX = e.clientX;
      const origStart = task.start_date;
      const origEnd = task.due_date;

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const deltaDays = Math.round(dx / DAY_WIDTH);
        setDragState({ taskId: task.id, mode, origStart, origEnd, deltaDays });
      };

      const onMouseUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        const dx = ev.clientX - startX;
        const deltaDays = Math.round(dx / DAY_WIDTH);
        setDragState(null);

        if (deltaDays === 0) return;

        let newStart = origStart;
        let newEnd = origEnd;

        if (mode === 'move') {
          if (origStart) newStart = dateToStr(new Date(new Date(origStart).getTime() + deltaDays * 86400000));
          if (origEnd) newEnd = dateToStr(new Date(new Date(origEnd).getTime() + deltaDays * 86400000));
        } else if (mode === 'resize-start' && origStart) {
          newStart = dateToStr(new Date(new Date(origStart).getTime() + deltaDays * 86400000));
        } else if (mode === 'resize-end' && origEnd) {
          newEnd = dateToStr(new Date(new Date(origEnd).getTime() + deltaDays * 86400000));
        }

        onBarDateChange(task, newStart, newEnd);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [DAY_WIDTH, onBarDateChange],
  );

  // ── Drag-to-Create ─────────────────────────────────────

  const handleTimelineMouseDown = useCallback(
    (e: React.MouseEvent, rowIdx: number) => {
      if ((e.target as HTMLElement).closest('[data-gantt-bar]')) return;
      if (!onDragCreate) return;

      // currentTarget is the position:relative bars layer that scrolls WITH the
      // content, so its rect.left already bakes in -scrollLeft — adding scrollLeft
      // again double-counted it and shoved new bars a full viewport to the right.
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const dayOffset = Math.floor(x / DAY_WIDTH);

      const startX = e.clientX;

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const endDayOffset = dayOffset + Math.round(dx / DAY_WIDTH);
        setCreateDrag({ startDay: dayOffset, currentDay: endDayOffset });
      };

      const onMouseUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        const dx = ev.clientX - startX;
        const endDayOffset = dayOffset + Math.round(dx / DAY_WIDTH);
        setCreateDrag(null);

        if (Math.abs(endDayOffset - dayOffset) < 1) return;

        const d1 = new Date(startDate.getTime() + Math.min(dayOffset, endDayOffset) * 86400000);
        const d2 = new Date(startDate.getTime() + Math.max(dayOffset, endDayOffset) * 86400000);
        onDragCreate(dateToStr(d1), dateToStr(d2), rowIdx);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [DAY_WIDTH, startDate, onDragCreate],
  );

  // ── Drag Sort Handlers ─────────────────────────────────

  const handleDragSortStart = useCallback((e: React.DragEvent, task: Task) => {
    e.dataTransfer.setData('text/plain', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
    setDragSortState({ sourceId: task.id, overIndex: -1 });
  }, []);

  const handleDragSortOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragSortState((prev) => (prev ? { ...prev, overIndex: idx } : null));
  }, []);

  const handleDragSortDrop = useCallback(
    (e: React.DragEvent, targetIdx: number) => {
      e.preventDefault();
      const sourceId = parseInt(e.dataTransfer.getData('text/plain'), 10);
      setDragSortState(null);

      if (isNaN(sourceId)) return;
      onSortDrop(sourceId, targetIdx);
    },
    [onSortDrop],
  );

  // ── Context Menu Handler ───────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent, task: Task) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, task });
  }, []);

  // ── Dependency Arrows (SVG) ─────────────────────────────

  const depArrows = useMemo(() => {
    const arrows: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const taskIndexMap = new Map<number, number>();
    rows.forEach((row, i) => {
      if (row.kind === 'task') taskIndexMap.set(row.task.id, i);
    });

    for (const row of rows) {
      if (row.kind !== 'task') continue;
      const tk = row.task;
      const deps = parseDeps(tk.dependencies);
      const targetIdx = taskIndexMap.get(tk.id);
      if (targetIdx === undefined) continue;

      for (const depId of deps) {
        const srcIdx = taskIndexMap.get(depId);
        if (srcIdx === undefined) continue;
        const srcRow = rows[srcIdx];
        if (srcRow.kind !== 'task') continue;
        const srcBar = getBar(srcRow.task, null);
        const tgtBar = getBar(tk, null);
        if (!srcBar || !tgtBar) continue;

        arrows.push({
          x1: srcBar.left + srcBar.width,
          y1: srcIdx * ROW_HEIGHT + ROW_HEIGHT / 2,
          x2: tgtBar.left,
          y2: targetIdx * ROW_HEIGHT + ROW_HEIGHT / 2,
        });
      }
    }
    return arrows;
  }, [rows, getBar, ROW_HEIGHT]);

  const minimapFlatTasks = useMemo(() => taskRows.map((r) => r.task), [taskRows]);

  // ── Keyboard Navigation ─────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onEscapeBefore?.()) return;
        if (pendingDeleteTask) {
          setPendingDeleteTask(null);
          return;
        }
        if (onEscapeAfter?.()) return;
        setFocusedRowIdx(-1);
        setSelectedIds(new Set());
        setShowBatchBar(false);
        return;
      }
      if (pendingDeleteTask || isModalOpen) return;
      if (
        document.activeElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement).tagName)
      )
        return;

      const taskRowIdxs = rows.reduce<number[]>((acc, row, idx) => {
        if (row.kind === 'task') acc.push(idx);
        return acc;
      }, []);

      if (taskRowIdxs.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
        case 'j': {
          e.preventDefault();
          const currentTaskIdx = taskRowIdxs.indexOf(focusedRowIdx);
          const nextIdx = currentTaskIdx < 0 ? 0 : Math.min(currentTaskIdx + 1, taskRowIdxs.length - 1);
          setFocusedRowIdx(taskRowIdxs[nextIdx]);
          break;
        }
        case 'ArrowUp':
        case 'k': {
          e.preventDefault();
          const currentTaskIdx = taskRowIdxs.indexOf(focusedRowIdx);
          const prevIdx = currentTaskIdx <= 0 ? 0 : currentTaskIdx - 1;
          setFocusedRowIdx(taskRowIdxs[prevIdx]);
          break;
        }
        case 'Enter': {
          e.preventDefault();
          const row = rows[focusedRowIdx];
          if (row?.kind === 'task') onRowOpen?.(row.task);
          else if (row?.kind === 'group') onGroupEnter?.(row);
          break;
        }
        case 'Delete':
        case 'Backspace': {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            const row = rows[focusedRowIdx];
            if (row?.kind === 'task') setPendingDeleteTask(row.task);
          }
          break;
        }
      }
    };
    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [
    rows,
    focusedRowIdx,
    pendingDeleteTask,
    setPendingDeleteTask,
    isModalOpen,
    onEscapeBefore,
    onEscapeAfter,
    onRowOpen,
    onGroupEnter,
  ]);

  // ── Render ──────────────────────────────────────────────

  const timelineWidth = totalDays * DAY_WIDTH;

  const rowCtx: GanttRowCtx = {
    dragGrip: (
      <span
        className="flex-shrink-0 text-fg-faint hover:text-fg-muted cursor-grab opacity-0 hover:opacity-100 transition-opacity"
        style={{ width: 12 }}
      >
        <GripVertical size={10} />
      </span>
    ),
    expandToggle: (task) =>
      task.isParent ? (
        <span
          className="w-4 h-4 flex items-center justify-center flex-shrink-0 cursor-pointer hover:bg-surface-muted rounded"
          onClick={(e) => {
            e.stopPropagation();
            onToggleTask(task.id);
          }}
        >
          {isTaskExpanded(task.id) ? (
            <ChevronDown size={11} className="text-fg-faint" />
          ) : (
            <ChevronRight size={11} className="text-fg-faint" />
          )}
        </span>
      ) : (
        <span className="w-4 flex-shrink-0" />
      ),
    batchCheckbox: (taskId) =>
      showBatchBar ? (
        <input
          type="checkbox"
          checked={selectedIds.has(taskId)}
          onChange={() => toggleSelected(taskId)}
          className="mr-0.5 flex-shrink-0 accent-primary-600"
          onClick={(e) => e.stopPropagation()}
        />
      ) : null,
    statusIcon: (task) =>
      task.task_type === 'milestone' ? (
        <span className="text-star flex-shrink-0" style={{ fontSize: 10 }}>
          ◆
        </span>
      ) : (
        <StatusIcon status={task.status} size={12} />
      ),
    titleSpan: (task) => (
      <span
        className={`truncate flex-1 ${task.isParent ? 'font-medium' : ''} ${task.task_type === 'milestone' ? 'text-warning font-medium' : ''}`}
      >
        {task.title}
      </span>
    ),
    assigneeSpan: (task) =>
      task.assignee_nickname ? (
        <span className="text-[10px] text-fg-faint truncate max-w-[60px] flex-shrink-0 text-right">
          {task.assignee_nickname}
        </span>
      ) : null,
    openContextMenu: (x, y, task) => setContextMenu({ x, y, task }),
  };

  return (
    <div ref={containerRef} className="flex flex-col h-full outline-none" tabIndex={0}>
      {/* Batch action bar */}
      {showBatchBar && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-primary-subtle border-b border-primary-edge text-xs flex-shrink-0">
          <span className="font-medium text-primary-fg-strong">
            {t('common.selected', { count: String(selectedIds.size) })}
          </span>
          <span className="text-fg-faint">|</span>
          <span className="text-fg-muted">{t('common.batchUpdateStatus')}</span>
          {Object.entries(statusConfig).map(([key, cfg]) => (
            <button
              key={key}
              onClick={() => runBatchAction('status', key)}
              className={`px-2 py-0.5 rounded-full border text-[10px] hover:shadow-sm transition-colors ${cfg.bg}`}
            >
              {cfg.label}
            </button>
          ))}
          {users && users.length > 0 && (
            <>
              <span className="text-fg-faint">|</span>
              <span className="text-fg-muted">{t('common.assign')}</span>
              <Select
                onChange={(e) => {
                  if (e.target.value) runBatchAction('assignee', e.target.value);
                }}
                size="xs"
                inline
                defaultValue=""
              >
                <option value="" disabled>
                  {t('common.select')}
                </option>
                <option value="">{t('common.unassigned')}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nickname}
                  </option>
                ))}
              </Select>
            </>
          )}
          {renderBatchExtra?.(runBatchAction)}
          <button
            onClick={() => runBatchAction('clear')}
            className="ml-auto text-fg-faint hover:text-fg-secondary text-xs"
          >
            {t('common.cancelSelection')}
          </button>
        </div>
      )}

      <div className="flex flex-1 border-t border-edge overflow-hidden">
        {/* Left: Task names + assignee */}
        <div
          className={`flex-shrink-0 border-r border-edge bg-surface-raised flex flex-col${leftPanelClassName ? ` ${leftPanelClassName}` : ''}`}
          style={{ width: labelWidth }}
        >
          {leftHeader}
          <div ref={leftPanelRef} className="flex-1 overflow-y-auto overflow-x-hidden" onScroll={handleLeftScroll}>
            {rows.map((row, idx) => {
              if (row.kind === 'group') {
                return <React.Fragment key={row.key}>{renderGroupRow?.(row)}</React.Fragment>;
              }
              const task = row.task;
              const isSelected = selectedIds.has(task.id);
              const isDragOver = dragSortState && dragSortState.overIndex === idx;
              const isFocused = focusedRowIdx === idx;
              return (
                <div
                  key={row.key}
                  className={`flex items-center gap-1 px-1 border-b border-edge text-xs text-fg-secondary cursor-pointer transition-colors${taskRowClassName ? ` ${taskRowClassName}` : ''} ${
                    isSelected
                      ? 'bg-primary-subtle-hover'
                      : isFocused
                        ? 'bg-primary-subtle/70 ring-1 ring-primary-400 ring-inset'
                        : 'hover:bg-primary-subtle'
                  } ${isDragOver ? 'border-t-2 border-t-primary-400' : ''}`}
                  style={{ height: ROW_HEIGHT, paddingLeft: `${indentBase + task.depth * 14}px` }}
                  title={task.title}
                  draggable
                  onDragStart={(e) => {
                    dragDidHappen.current = true;
                    handleDragSortStart(e, task);
                  }}
                  onDragOver={(e) => handleDragSortOver(e, idx)}
                  onDrop={(e) => handleDragSortDrop(e, idx)}
                  onDragEnd={() => {
                    setDragSortState(null);
                    setTimeout(() => {
                      dragDidHappen.current = false;
                    }, 50);
                  }}
                  onClick={(e) => {
                    if (dragDidHappen.current) return;
                    if (!handleRowSelect(e, task)) onRowOpen?.(task);
                  }}
                  onContextMenu={(e) => handleContextMenu(e, task)}
                >
                  {renderTaskRow(row, rowCtx)}
                </div>
              );
            })}
          </div>
          {leftPanelExtra}
        </div>

        {/* Right: Timeline */}
        <div ref={timelineRef} className="flex-1 overflow-auto" onScroll={handleRightScroll}>
          <div style={{ width: timelineWidth, position: 'relative', minHeight: '100%' }}>
            {/* Timeline headers */}
            <div className="h-10 border-b border-edge bg-surface-sunken relative sticky top-0 z-[5]">
              {headers.map((m, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full flex items-center px-2 border-l border-edge text-[10px] font-medium text-fg-muted"
                  style={{ left: m.left, width: m.width }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            {/* Weekend columns */}
            {weekendColumns.map((col, i) => (
              <div
                key={`we-${i}`}
                className="absolute z-[0] pointer-events-none"
                style={{
                  left: col.left,
                  top: 40,
                  width: col.width,
                  bottom: 0,
                  backgroundColor: 'color-mix(in srgb, var(--t-fg) 3%, transparent)',
                }}
              />
            ))}

            {/* Today column highlight */}
            <div
              className="absolute z-[1] pointer-events-none"
              style={{
                left: todayOffset,
                top: 40,
                width: DAY_WIDTH,
                bottom: 0,
                backgroundColor: 'color-mix(in srgb, var(--t-danger) 8%, transparent)',
              }}
            />

            {/* Dependency arrows SVG overlay */}
            {depArrows.length > 0 && (
              <svg
                className="absolute pointer-events-none z-[3]"
                style={{ top: 40, left: 0, width: timelineWidth, height: rows.length * ROW_HEIGHT }}
              >
                <defs>
                  <marker id={arrowMarkerId} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                    <polygon points="0 0, 8 3, 0 6" fill="var(--t-fg-faint)" />
                  </marker>
                </defs>
                {depArrows.map((a, i) => {
                  const mx = (a.x1 + a.x2) / 2;
                  return (
                    <path
                      key={i}
                      d={`M${a.x1},${a.y1} C${mx},${a.y1} ${mx},${a.y2} ${a.x2},${a.y2}`}
                      fill="none"
                      stroke="var(--t-fg-faint)"
                      strokeWidth="1.5"
                      strokeDasharray="4,2"
                      markerEnd={`url(#${arrowMarkerId})`}
                    />
                  );
                })}
              </svg>
            )}

            {/* Drag-to-create preview */}
            {createDrag && (
              <div
                className="absolute z-[4] bg-primary-200 opacity-40 rounded"
                style={{
                  left: Math.min(createDrag.startDay, createDrag.currentDay) * DAY_WIDTH,
                  top: 40,
                  width: Math.abs(createDrag.currentDay - createDrag.startDay) * DAY_WIDTH,
                  height: rows.length * ROW_HEIGHT || ROW_HEIGHT,
                }}
              />
            )}

            {/* Bars */}
            <div
              style={{ position: 'relative' }}
              onMouseDown={
                onDragCreate
                  ? (e) => {
                      if (dragCreateByRow) {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        const y = e.clientY - rect.top;
                        const rowIdx = Math.floor(y / ROW_HEIGHT);
                        if (rowIdx >= 0 && rowIdx < rows.length) handleTimelineMouseDown(e, rowIdx);
                      } else {
                        handleTimelineMouseDown(e, 0);
                      }
                    }
                  : undefined
              }
              title={onDragCreate ? t('projects.dragToCreate') : undefined}
            >
              {rows.map((row, _idx) => {
                if (row.kind === 'group') {
                  return <React.Fragment key={row.key}>{renderGroupBar?.(row)}</React.Fragment>;
                }
                const task = row.task;
                const bar = getBar(task, dragState);
                const isMilestone = task.task_type === 'milestone';
                const days = daysBetween(task.start_date, task.due_date);
                const isSelected = selectedIds.has(task.id);
                const borderLeft = barLeftBorder?.(row);
                return (
                  <div
                    key={row.key}
                    className={`relative border-b border-edge ${isSelected ? 'bg-primary-subtle/50' : ''}`}
                    style={{ height: ROW_HEIGHT }}
                    onContextMenu={(e) => handleContextMenu(e, task)}
                  >
                    {bar && !isMilestone && (
                      <div
                        data-gantt-bar
                        className={`absolute rounded-sm cursor-pointer hover:brightness-110 transition-all ${bar.bgColor} ${bar.isParent ? 'h-3 opacity-70' : 'h-5'} group`}
                        style={{
                          left: bar.left,
                          width: Math.max(bar.width, DAY_WIDTH / 2),
                          top: bar.isParent ? 12 : 8,
                          ...(borderLeft ? { borderLeft } : {}),
                        }}
                        title={barTooltip(row, bar)}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRowOpen?.(task);
                        }}
                        onMouseDown={(e) => {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          const x = e.clientX - rect.left;
                          const w = rect.width;
                          if (x <= 6) handleBarMouseDown(e, task, 'resize-start');
                          else if (x >= w - 6) handleBarMouseDown(e, task, 'resize-end');
                          else handleBarMouseDown(e, task, 'move');
                        }}
                      >
                        {/* Progress fill */}
                        {!bar.isParent && bar.progress > 0 && bar.progress < 100 && (
                          <div
                            className="absolute inset-0 rounded-sm opacity-30 bg-black"
                            style={{ width: `${bar.progress}%` }}
                          />
                        )}
                        {/* Resize handles */}
                        {!bar.isParent && (
                          <>
                            <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize opacity-0 group-hover:opacity-100 bg-surface-raised/40 rounded-l-sm" />
                            <div className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize opacity-0 group-hover:opacity-100 bg-surface-raised/40 rounded-r-sm" />
                          </>
                        )}
                        {/* Enhanced label with assignee, days, status */}
                        {!bar.isParent && (
                          <div className="flex items-center gap-1 px-1.5 truncate leading-5 relative z-[1] h-full">
                            {bar.width > 40 && (
                              <span
                                className={`text-[9px] ${bar.isDarkBg ? 'text-white' : 'text-fg-secondary'} truncate font-medium`}
                                title={task.title}
                              >
                                {task.title}
                              </span>
                            )}
                            {bar.width > 120 && task.assignee_nickname && (
                              <span
                                className={`text-[8px] ${bar.isDarkBg ? 'text-white/80' : 'text-fg-muted'} flex-shrink-0 flex items-center gap-0.5`}
                              >
                                <User size={7} />
                                {task.assignee_nickname}
                              </span>
                            )}
                            {bar.width > 80 && days && (
                              <span
                                className={`text-[8px] ${bar.isDarkBg ? 'text-white/70' : 'text-fg-faint'} flex-shrink-0`}
                              >
                                {days}d
                              </span>
                            )}
                            {showBarStatusPill && bar.width > 100 && (
                              <span
                                className={`text-[7px] px-1 py-px rounded-full flex-shrink-0 ${
                                  bar.isDarkBg ? 'bg-surface-raised/25 text-white' : 'bg-fg/10 text-fg-muted'
                                }`}
                              >
                                {statusConfig[task.status]?.label || task.status}
                              </span>
                            )}
                          </div>
                        )}
                        {/* Parent bar label */}
                        {bar.isParent && bar.width > 50 && (
                          <span
                            className={`text-[8px] ${bar.isDarkBg ? 'text-white/80' : 'text-fg-muted'} px-1 truncate block leading-3 relative z-[1]`}
                          >
                            {task.title}
                          </span>
                        )}
                      </div>
                    )}
                    {/* Milestone diamond */}
                    {bar && isMilestone && (
                      <div
                        data-gantt-bar
                        className="absolute cursor-pointer hover:scale-110 transition-transform"
                        style={{ left: bar.left - 6, top: 8 }}
                        title={`◆ ${task.title}\n${task.due_date || task.start_date || '?'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRowOpen?.(task);
                        }}
                        onContextMenu={(e) => handleContextMenu(e, task)}
                      >
                        <svg width="20" height="20" viewBox="0 0 20 20">
                          <polygon points="10,2 18,10 10,18 2,10" fill="#f59e0b" stroke="#d97706" strokeWidth="1" />
                        </svg>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Today line */}
            <div
              className="absolute top-0 bottom-0 w-px bg-danger z-[6] pointer-events-none"
              style={{ left: todayOffset }}
            >
              <div className="absolute top-0 -left-2 text-[9px] text-danger font-medium bg-danger-subtle px-1 rounded">
                Today
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* MiniMap */}
      <GanttMiniMap
        flatTasks={minimapFlatTasks}
        totalDays={totalDays}
        DAY_WIDTH={DAY_WIDTH}
        ROW_HEIGHT={ROW_HEIGHT}
        timelineRef={timelineRef}
        getBarStyle={getBar}
      />

      {/* Context Menu */}
      {contextMenu && (
        <GanttContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          task={contextMenu.task}
          onClose={() => setContextMenu(null)}
          onAction={onContextAction}
          projects={contextMenuProjects}
          allTasks={contextMenuTasks}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!pendingDeleteTask}
        onClose={() => setPendingDeleteTask(null)}
        onConfirm={async () => {
          if (!pendingDeleteTask) return;
          await authFetch(`/api/projects/tasks/${pendingDeleteTask.id}`, { method: 'DELETE' });
          toast(t('projects.taskDeleted'), 'success');
          const task = pendingDeleteTask;
          setPendingDeleteTask(null);
          onDeleted(task);
        }}
        title={t('projects.deleteTaskConfirm')}
        description={t('projects.deleteTaskDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />

      {children}
    </div>
  );
}
