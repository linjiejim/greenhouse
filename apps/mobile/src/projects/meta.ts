/**
 * Project module shared metadata + pure helpers — status/priority meta
 * (mirrors apps/web/src/components/project/types.ts), task-tree walking and
 * the gantt day math (mirrors apps/web/src/components/project/gantt-utils.ts).
 */

import type { ThemeColors } from '../theme';
import type { Priority, ProjectStatus, ProjectTask, TaskStatus } from '../shared/greenhouse-types';
import type { IconName } from '../ui/core';
import type { TranslationKey } from '../lib/i18n';
import { parseMs } from '../lib/format';

/** Shape of useT()'s return — kept local, i18n exports no named fn type. */
export type TranslateFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;

// ─── Status / priority meta ──────────────────────────────

export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'];
export const PROJECT_STATUSES: ProjectStatus[] = ['planning', 'active', 'on_hold', 'completed', 'archived'];
export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

export function taskStatusIcon(status: TaskStatus): IconName {
  switch (status) {
    case 'in_progress':
      return 'loader';
    case 'in_review':
      return 'eye';
    case 'done':
      return 'checkCircle';
    case 'cancelled':
      return 'x';
    default:
      return 'circle';
  }
}

/** Foreground color for a task status (web: statusConfig.color). */
export function taskStatusColor(status: TaskStatus, c: ThemeColors): string {
  switch (status) {
    case 'in_progress':
      return c.info;
    case 'in_review':
      return c.warning;
    case 'done':
      return c.success;
    case 'cancelled':
      return c.danger;
    default:
      return c.fgMuted;
  }
}

/** Subtle fill for a task status (web: statusConfig.bg). */
export function taskStatusTint(status: TaskStatus, c: ThemeColors): string {
  switch (status) {
    case 'in_progress':
      return c.infoTint;
    case 'in_review':
      return c.warningTint;
    case 'done':
      return c.successTint;
    case 'cancelled':
      return c.dangerTint;
    default:
      return c.surfaceMuted;
  }
}

export function taskStatusLabel(status: TaskStatus, t: TranslateFn): string {
  return t(`projects.status_${status}`);
}

export function projectStatusColor(status: ProjectStatus, c: ThemeColors): string {
  switch (status) {
    case 'active':
      return c.info;
    case 'on_hold':
      return c.warning;
    case 'completed':
      return c.success;
    case 'archived':
      return c.fgFaint;
    default:
      return c.fgSecondary;
  }
}

export function projectStatusTint(status: ProjectStatus, c: ThemeColors): string {
  switch (status) {
    case 'active':
      return c.infoTint;
    case 'on_hold':
      return c.warningTint;
    case 'completed':
      return c.successTint;
    default:
      return c.surfaceMuted;
  }
}

export function projectStatusLabel(status: ProjectStatus, t: TranslateFn): string {
  return t(`projects.pstatus_${status}`);
}

export function priorityColor(p: Priority, c: ThemeColors): string {
  switch (p) {
    case 'urgent':
      return c.danger;
    case 'high':
      return c.warning;
    case 'low':
      return c.fgFaint;
    default:
      return c.info;
  }
}

export function priorityLabel(p: Priority, t: TranslateFn): string {
  return t(`projects.priority_${p}`);
}

/** Mirror of the server's fallback palette (apps/api/src/routes/projects.ts). */
export const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1'];

/** `#rrggbb` → `rgba(...)`; passes non-hex values through untouched. */
export function hexAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ─── Task tree helpers ───────────────────────────────────

export interface FlatTask {
  task: ProjectTask;
  depth: number;
  isParent: boolean;
}

/** Depth-first walk over a task tree (task itself + all descendants). */
export function forEachTask(list: ProjectTask[], fn: (task: ProjectTask) => void): void {
  for (const t of list) {
    fn(t);
    if (t.children?.length) forEachTask(t.children, fn);
  }
}

/** Flatten a tree respecting an expanded-id set (collapsed parents keep children hidden). */
export function flattenTree(list: ProjectTask[], expanded: ReadonlySet<number>): FlatTask[] {
  const out: FlatTask[] = [];
  const walk = (nodes: ProjectTask[], depth: number) => {
    for (const task of nodes) {
      const isParent = !!task.children && task.children.length > 0;
      out.push({ task, depth, isParent });
      if (isParent && expanded.has(task.id)) walk(task.children!, depth + 1);
    }
  };
  walk(list, 0);
  return out;
}

/** Ids of every task that has children (expand-all seed). */
export function collectParentIds(list: ProjectTask[]): Set<number> {
  const ids = new Set<number>();
  forEachTask(list, (t) => {
    if (t.children?.length) ids.add(t.id);
  });
  return ids;
}

export function findTask(list: ProjectTask[], id: number): ProjectTask | null {
  for (const t of list) {
    if (t.id === id) return t;
    if (t.children?.length) {
      const hit = findTask(t.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Done-children ratio (leaf: own status), mirrors web childProgress(). */
export function subtreeProgress(task: ProjectTask): number {
  if (!task.children?.length) {
    return task.status === 'done' ? 100 : task.status === 'in_progress' ? 50 : 0;
  }
  const done = task.children.filter((child) => child.status === 'done').length;
  return Math.round((done / task.children.length) * 100);
}

export function parseTags(tags: ProjectTask['tags']): string[] {
  if (Array.isArray(tags)) return tags;
  try {
    const v = JSON.parse(tags || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function parseDeps(deps: ProjectTask['dependencies']): number[] {
  if (Array.isArray(deps)) return deps;
  try {
    const v = JSON.parse(deps || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

// ─── Day math (gantt + overdue) ──────────────────────────

const DAY_MS = 86400000;

/** UTC day index for a date string (matches web's toISOString-based day math). */
export function dayIndex(date: string | null | undefined): number | null {
  const ms = parseMs(date);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / DAY_MS);
}

export function todayIndex(): number {
  return Math.floor(Date.now() / DAY_MS);
}

/** `YYYY-MM-DD` of today (UTC — same convention the web views use). */
export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isOverdue(task: ProjectTask): boolean {
  if (!task.due_date) return false;
  if (task.status === 'done' || task.status === 'cancelled') return false;
  return task.due_date.slice(0, 10) < todayStamp();
}

/** Short `M/D` label for list rows and gantt ticks. */
export function shortDate(date: string | null | undefined): string {
  const ms = parseMs(date);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** `YYYY-MM-DD` from a UTC day index. */
export function stampFromIndex(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}
