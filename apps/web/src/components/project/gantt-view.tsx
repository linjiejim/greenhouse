/**
 * 甘特图组件 — 完整的项目时间线视图（单项目）。
 *
 * 功能：缩放(日/周/月/年)、拖拽调整日期、依赖箭头、里程碑标记、
 *       拖拽创建任务、完成进度条、筛选、Today 高亮、垂直滚动同步、
 *       展开/折叠子任务、右键菜单、拖拽排序、mini-map、批量操作、
 *       周末高亮、Bar 上显示更多信息。
 *
 * 薄壳：行模型构建（展开/折叠/过滤）与数据回调在此，渲染骨架在 GanttCore。
 */

import { useMemo, useEffect, useState, useCallback } from 'react';
import type { Task, Project } from './types';
import {
  childProgress,
  collectParentIds,
  collectTaskDates,
  computeGanttRange,
  forEachTask,
  handleTaskAction,
  patchTask,
  reorderTasks,
} from './gantt-utils';
import { GanttCore } from './gantt-core';
import type { GanttBarStyle, GanttBarTask, GanttRow, GanttRowCtx, GanttTaskRow } from './gantt-core';
import { useT } from '../../lib/i18n';

export type GanttZoom = 'day' | 'week' | 'month' | 'year';

export interface GanttFilter {
  assignee?: string;
  status?: string;
  priority?: string;
}

// Helpers, ContextMenu, and MiniMap live in ./gantt-utils.ts, ./gantt-context-menu.tsx, ./gantt-minimap.tsx
// Shared rendering engine lives in ./gantt-core.tsx

// ─── Component ───────────────────────────────────────────

export function GanttView({
  tasks,
  project,
  onSelect,
  zoom = 'day',
  filter,
  onDragCreate,
  onContextAction,
  users,
  onBatchUpdate,
}: {
  tasks: Task[];
  project: Project;
  onSelect?: (task: Task) => void;
  zoom?: GanttZoom;
  filter?: GanttFilter;
  onDragCreate?: (startDate: string, endDate: string) => void;
  onContextAction?: (action: string, task: Task) => void;
  users?: Array<{ id: string; nickname: string }>;
  onBatchUpdate?: (taskIds: number[], updates: Record<string, any>) => void;
}) {
  const t = useT();

  // Expand/Collapse state for Gantt
  const [ganttExpanded, setGanttExpanded] = useState<Set<number>>(new Set());

  const [pendingDeleteTask, setPendingDeleteTask] = useState<Task | null>(null);

  // Auto-expand top-level items on mount
  useEffect(() => {
    setGanttExpanded(collectParentIds(tasks));
  }, [tasks]);

  // ── Flatten & Filter (with expand/collapse) ─────────────

  const flatTasks = useMemo(() => {
    const result: Array<Task & { depth: number; isParent: boolean }> = [];
    function walk(list: Task[], depth: number) {
      for (const t of list) {
        const isParent = !!t.children && t.children.length > 0;
        result.push({ ...t, depth, isParent });
        if (isParent && ganttExpanded.has(t.id) && t.children?.length) {
          walk(t.children, depth + 1);
        }
      }
    }
    walk(tasks, 0);
    return result;
  }, [tasks, ganttExpanded]);

  const filteredTasks = useMemo(() => {
    if (!filter || (!filter.assignee && !filter.status && !filter.priority)) return flatTasks;
    return flatTasks.filter((t) => {
      if (filter.assignee && t.assignee_id !== filter.assignee) return false;
      if (filter.status && t.status !== filter.status) return false;
      if (filter.priority && t.priority !== filter.priority) return false;
      return true;
    });
  }, [flatTasks, filter]);

  const rows = useMemo<Array<GanttRow<null, never>>>(
    () => filteredTasks.map((task) => ({ kind: 'task', key: String(task.id), task, data: null })),
    [filteredTasks],
  );

  // ── Toggle expand/collapse ──────────────────────────────

  const handleGanttToggle = useCallback((id: number) => {
    setGanttExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setGanttExpanded(collectParentIds(tasks));
  }, [tasks]);

  const handleCollapseAll = useCallback(() => {
    setGanttExpanded(new Set());
  }, []);

  // ── Batch actions ───────────────────────────────────────

  const handleBatchAction = useCallback(
    async (action: string, value: string | undefined, ids: number[], clear: () => void) => {
      const updates: Record<string, string | null> = {};

      if (action === 'status' && value) updates.status = value;
      else if (action === 'assignee') updates.assignee_id = value || null;

      if (onBatchUpdate && Object.keys(updates).length > 0) {
        onBatchUpdate(ids, updates);
      } else {
        // Fallback: update one by one
        for (const id of ids) {
          await patchTask(id, updates);
        }
        onSelect?.(filteredTasks[0]); // trigger reload
      }
      clear();
    },
    [onBatchUpdate, onSelect, filteredTasks],
  );

  // ── Date Range ──────────────────────────────────────────

  const range = useMemo(() => {
    const dates: Date[] = [];
    const today = new Date();
    dates.push(today);

    if (project.start_date) dates.push(new Date(project.start_date));
    if (project.end_date) dates.push(new Date(project.end_date));

    // Use ALL flat tasks (not filtered) for date range
    collectTaskDates(tasks, dates);

    return computeGanttRange(dates);
  }, [tasks, project]);

  // ── Bar progress ────────────────────────────────────────

  const progressFor = useCallback(
    (task: GanttBarTask) => {
      // Collect all flat tasks (the task's own subtree) for progress
      const allFlat: Task[] = [];
      forEachTask([task], (tt) => allFlat.push(tt));
      return childProgress(task, allFlat.length > 1 ? allFlat : filteredTasks);
    },
    [filteredTasks],
  );

  // ── Drag (move/resize) persist ──────────────────────────

  const handleBarDateChange = useCallback(
    async (task: Task, newStart: string | null, newEnd: string | null) => {
      await patchTask(task.id, { start_date: newStart, due_date: newEnd });
      onSelect?.(task);
    },
    [onSelect],
  );

  // ── Drag Sort ───────────────────────────────────────────

  const handleSortDrop = useCallback(
    async (sourceId: number, targetIdx: number) => {
      const sourceTask = filteredTasks.find((t) => t.id === sourceId);
      if (!sourceTask) return;
      const targetTask = filteredTasks[targetIdx];

      // If dropping onto a parent task, offer to make it a subtask
      if (targetTask && targetTask.isParent && targetTask.id !== sourceId && sourceTask.parent_id !== targetTask.id) {
        // Use context menu action to reparent
        await handleTaskAction(`reparent:${targetTask.id}`, sourceTask, {
          onRefresh: () => onSelect?.(sourceTask),
        });
        return;
      }

      // Normal reorder
      const reordered = filteredTasks.filter((t) => t.id !== sourceId);
      reordered.splice(targetIdx, 0, sourceTask);
      const updates = reordered.map((t, i) => ({ id: t.id, sort_order: i * 10 }));

      try {
        await reorderTasks(updates);
        onSelect?.(sourceTask);
      } catch (_err) {
        /* ignore */
      }
    },
    [filteredTasks, onSelect],
  );

  // ── Context Menu ────────────────────────────────────────

  const handleContextAction = useCallback(
    async (action: string, task: Task) => {
      await handleTaskAction(action, task, {
        onRefresh: () => onSelect?.(task),
        onSelect: (t) => onSelect?.(t),
        onDelete: (t) => setPendingDeleteTask(t),
        onAddSubtask: (t) => onContextAction?.('add-subtask', t),
      });
      // Forward unhandled actions
      if (
        onContextAction &&
        !['status:', 'type:', 'dep:', 'undep:', 'move:', 'reparent:', 'edit', 'view', 'delete', 'add-subtask'].some(
          (p) => action.startsWith(p) || action === p,
        )
      ) {
        onContextAction(action, task);
      }
    },
    [onSelect, onContextAction],
  );

  // ── Render ──────────────────────────────────────────────

  const renderTaskRow = useCallback((row: GanttTaskRow<null>, ctx: GanttRowCtx) => {
    const task = row.task;
    return (
      <>
        {ctx.dragGrip}
        {ctx.expandToggle(task)}
        {ctx.batchCheckbox(task.id)}
        {ctx.statusIcon(task)}
        {ctx.titleSpan(task)}
        {ctx.assigneeSpan(task)}
      </>
    );
  }, []);

  const barTooltip = useCallback(
    (row: GanttTaskRow<null>, bar: GanttBarStyle) =>
      `${row.task.title}\n${row.task.start_date || '?'} → ${row.task.due_date || '?'}\nProgress: ${bar.progress}%`,
    [],
  );

  const leftHeader = (
    <div className="h-10 border-b border-edge bg-surface-sunken px-3 flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-fg-secondary">Task</span>
        <button
          onClick={handleExpandAll}
          className="text-[10px] text-fg-faint hover:text-primary-fg"
          title={t('projects.expandAll')}
        >
          ▼
        </button>
        <button
          onClick={handleCollapseAll}
          className="text-[10px] text-fg-faint hover:text-primary-fg"
          title={t('projects.collapseAll')}
        >
          ▶
        </button>
      </div>
      <span className="text-xs font-medium text-fg-faint">Assignee</span>
    </div>
  );

  return (
    <GanttCore
      rows={rows}
      zoom={zoom}
      range={range}
      users={users}
      labelWidth={300}
      indentBase={4}
      arrowMarkerId="arrowhead"
      showBarStatusPill
      leftHeader={leftHeader}
      isTaskExpanded={(id) => ganttExpanded.has(id)}
      onToggleTask={handleGanttToggle}
      renderTaskRow={renderTaskRow}
      progressFor={progressFor}
      barTooltip={barTooltip}
      onRowOpen={onSelect}
      onBarDateChange={handleBarDateChange}
      onDragCreate={onDragCreate}
      onSortDrop={handleSortDrop}
      onBatchAction={handleBatchAction}
      contextMenuTasks={flatTasks}
      onContextAction={handleContextAction}
      pendingDeleteTask={pendingDeleteTask}
      setPendingDeleteTask={setPendingDeleteTask}
      onDeleted={(task) => onSelect?.(task)}
    />
  );
}
