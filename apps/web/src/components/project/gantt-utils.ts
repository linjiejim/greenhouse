/**
 * Pure utility functions for the Gantt chart component.
 * Extracted from gantt-view.tsx.
 */

import { authFetch } from '../../lib/auth';
import { toast } from '../ui';
import type { Task } from './types';

/** Depth-first walk over a task tree (task itself + all descendants). */
export function forEachTask(list: Task[], fn: (task: Task) => void): void {
  for (const t of list) {
    fn(t);
    if (t.children?.length) forEachTask(t.children, fn);
  }
}

/** Collect all start/due dates in a task tree (appends to `dates` when given). */
export function collectTaskDates(list: Task[], dates: Date[] = []): Date[] {
  forEachTask(list, (t) => {
    if (t.start_date) dates.push(new Date(t.start_date));
    if (t.due_date) dates.push(new Date(t.due_date));
  });
  return dates;
}

/** Collect ids of tasks that have children (expand-all / auto-expand). */
export function collectParentIds(list: Task[], into: Set<number> = new Set()): Set<number> {
  forEachTask(list, (t) => {
    if (t.children?.length) into.add(t.id);
  });
  return into;
}

/** PATCH /api/projects/tasks/:id with a JSON body. */
export function patchTask(taskId: number, body: Record<string, unknown>): Promise<Response> {
  return authFetch(`/api/projects/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** PATCH /api/projects/tasks/:id/move to another project. */
export function moveTask(taskId: number, projectId: number): Promise<Response> {
  return authFetch(`/api/projects/tasks/${taskId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  });
}

/** PATCH /api/projects/tasks-reorder with sort_order (and optional project_id) updates. */
export function reorderTasks(
  updates: Array<{ id: number; sort_order: number; project_id?: number }>,
): Promise<Response> {
  return authFetch('/api/projects/tasks-reorder', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates }),
  });
}

export function parseDeps(deps: number[] | string | undefined): number[] {
  if (!deps) return [];
  if (Array.isArray(deps)) return deps;
  try {
    return JSON.parse(deps);
  } catch (_err) {
    return [];
  }
}

export function dateToStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

export function childProgress(task: Task, allFlat: Task[]): number {
  const children = allFlat.filter((t) => t.parent_id === task.id);
  if (children.length === 0) return task.status === 'done' ? 100 : task.status === 'in_progress' ? 50 : 0;
  const done = children.filter((c) => c.status === 'done').length;
  return Math.round((done / children.length) * 100);
}

export function daysBetween(d1: string | null, d2: string | null): number | null {
  if (!d1 || !d2) return null;
  const a = new Date(d1),
    b = new Date(d2);
  return Math.ceil((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export interface GanttDateRange {
  startDate: Date;
  endDate: Date;
  totalDays: number;
}

/** Pad the min/max of the given dates by -7/+14 days (≥30 days total). Shared by both Gantt views. */
export function computeGanttRange(dates: Date[]): GanttDateRange {
  let start = new Date(Math.min(...dates.map((d) => d.getTime())));
  let end = new Date(Math.max(...dates.map((d) => d.getTime())));

  start = new Date(start.getTime() - 7 * 86400000);
  end = new Date(end.getTime() + 14 * 86400000);

  const totalDays = Math.max(Math.ceil((end.getTime() - start.getTime()) / 86400000), 30);
  return { startDate: start, endDate: end, totalDays };
}

// ─── Shared task action handlers ─────────────────────────

export interface TaskActionCallbacks {
  /** Called after a successful mutation so the caller can reload data */
  onRefresh: () => void;
  /** Called when 'edit' / 'view' is clicked */
  onSelect?: (task: Task) => void;
  /** Called when 'delete' is clicked — caller shows confirm dialog */
  onDelete?: (task: Task) => void;
  /** Called when 'add-subtask' is clicked */
  onAddSubtask?: (task: Task) => void;
  /** Optimistic update before server call (for instant UI feedback) */
  onOptimistic?: (taskId: number, updates: Record<string, any>) => void;
  /** Resolve a project name by id (for toast messages on move) */
  resolveProjectName?: (projectId: number) => string | undefined;
}

/**
 * Handle a context menu action string. Shared by GanttView and GlobalGanttView
 * to avoid duplicating the same action→API mapping.
 */
export async function handleTaskAction(action: string, task: Task, cbs: TaskActionCallbacks) {
  if (action.startsWith('status:')) {
    const newStatus = action.split(':')[1];
    const oldStatus = task.status;
    cbs.onOptimistic?.(task.id, { status: newStatus });
    await patchTask(task.id, { status: newStatus });
    toast(`状态已更新`, 'success', {
      onUndo: () => {
        patchTask(task.id, { status: oldStatus }).then(() => cbs.onRefresh());
      },
    });
    cbs.onRefresh();
  } else if (action.startsWith('type:')) {
    const newType = action.split(':')[1];
    cbs.onOptimistic?.(task.id, { task_type: newType });
    await patchTask(task.id, { task_type: newType });
    toast(newType === 'milestone' ? '已设为里程碑' : '已取消里程碑', 'success');
    cbs.onRefresh();
  } else if (action.startsWith('dep:')) {
    const depId = parseInt(action.split(':')[1], 10);
    if (isNaN(depId)) return;
    const currentDeps = parseDeps(task.dependencies);
    const newDeps = [...currentDeps, depId];
    await patchTask(task.id, { dependencies: newDeps });
    toast('已添加前置任务', 'success');
    cbs.onRefresh();
  } else if (action.startsWith('undep:')) {
    const depId = parseInt(action.split(':')[1], 10);
    if (isNaN(depId)) return;
    const currentDeps = parseDeps(task.dependencies);
    const newDeps = currentDeps.filter((d) => d !== depId);
    await patchTask(task.id, { dependencies: newDeps });
    toast('已移除前置任务', 'success');
    cbs.onRefresh();
  } else if (action.startsWith('move:')) {
    const targetProjectId = parseInt(action.split(':')[1], 10);
    if (isNaN(targetProjectId)) return;
    const oldProjectId = task.project_id;
    cbs.onOptimistic?.(task.id, { project_id: targetProjectId });
    await moveTask(task.id, targetProjectId);
    const targetName = cbs.resolveProjectName?.(targetProjectId) || '目标项目';
    toast(`任务已移动到「${targetName}」`, 'success', {
      onUndo: () => {
        moveTask(task.id, oldProjectId).then(() => cbs.onRefresh());
      },
    });
    cbs.onRefresh();
  } else if (action.startsWith('reparent:')) {
    const newParentId = parseInt(action.split(':')[1], 10);
    const oldParentId = task.parent_id;
    cbs.onOptimistic?.(task.id, { parent_id: isNaN(newParentId) ? null : newParentId });
    await patchTask(task.id, { parent_id: isNaN(newParentId) ? null : newParentId });
    toast('已设为子任务', 'success', {
      onUndo: () => {
        patchTask(task.id, { parent_id: oldParentId ?? null }).then(() => cbs.onRefresh());
      },
    });
    cbs.onRefresh();
  } else if (action === 'edit' || action === 'view') {
    cbs.onSelect?.(task);
  } else if (action === 'delete') {
    cbs.onDelete?.(task);
  } else if (action === 'add-subtask') {
    cbs.onAddSubtask?.(task);
  }
}
