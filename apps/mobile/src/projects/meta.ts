/**
 * Project module shared metadata + pure helpers — status/priority meta
 * (semantics mirror apps/web/src/components/project/types.ts), access rules
 * (mirror apps/api/src/platform/projects/application.ts `projectAccess`),
 * task-tree walking, date-only conversions and the gantt day math (mirrors
 * apps/web/src/components/project/gantt-utils.ts).
 *
 * Colors are iOS system colors. Every color helper is generic over the
 * palette, so the same mapping serves views (`colors.*`, PlatformColor) and
 * drawing code that needs real strings (`hex.*` — the gantt canvas, alpha
 * math): `taskStatusColor(s, colors)` or `taskStatusColor(s, hex)`.
 */

import type { HexPalette } from '../theme';
import type { AuthenticatedUser, Priority, Project, ProjectMember, ProjectStatus, ProjectTask, TaskStatus } from '../shared/greenhouse-types';
import type { IconName } from '../ui/core';
import type { BadgeTone } from '../ui/list';
import { localeOf, type TranslationKey } from '../lib/i18n';
import type { LangPref } from '../store/prefs';
import { parseMs } from '../lib/format';

/** Shape of useT()'s return — kept local, i18n exports no named fn type. */
export type TranslateFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** Either view of the theme palette: `colors` (ColorValue) or `hex` (string). */
type Palette<V> = { [K in keyof HexPalette]: V };

// ─── Status / priority meta ──────────────────────────────

export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'];
export const PROJECT_STATUSES: ProjectStatus[] = ['planning', 'active', 'on_hold', 'completed', 'archived'];
export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

/** Reminders-style status glyphs: empty circle → half → review → filled check. */
export function taskStatusIcon(status: TaskStatus): IconName {
  switch (status) {
    case 'in_progress':
      return 'statusProgress';
    case 'in_review':
      return 'statusReview';
    case 'done':
      return 'checkCircleFill';
    case 'cancelled':
      return 'statusCancelled';
    default:
      return 'circle';
  }
}

export function taskStatusColor<V>(status: TaskStatus, c: Palette<V>): V {
  switch (status) {
    case 'in_progress':
      return c.blue;
    case 'in_review':
      return c.orange;
    case 'done':
      return c.green;
    default:
      return c.gray;
  }
}

/** Subtle fill behind a status (pills, lane headers, gantt bars). */
export function taskStatusTint<V>(status: TaskStatus, c: Palette<V>): V {
  switch (status) {
    case 'in_progress':
      return c.blueFill;
    case 'in_review':
      return c.orangeFill;
    case 'done':
      return c.greenFill;
    default:
      return c.tertiaryFill;
  }
}

/** A status as a `Badge` tone (the same system color pair as `taskStatusColor` / `taskStatusTint`). */
export function taskStatusTone(status: TaskStatus): BadgeTone {
  switch (status) {
    case 'in_progress':
      return 'blue';
    case 'in_review':
      return 'orange';
    case 'done':
      return 'green';
    default:
      return 'neutral';
  }
}

export function taskStatusLabel(status: TaskStatus, t: TranslateFn): string {
  return t(`projects.status_${status}`);
}

export function projectStatusColor<V>(status: ProjectStatus, c: Palette<V>): V {
  switch (status) {
    case 'active':
      return c.blue;
    case 'on_hold':
      return c.orange;
    case 'completed':
      return c.green;
    case 'archived':
      return c.tertiaryLabel;
    default:
      return c.secondaryLabel;
  }
}

export function projectStatusTint<V>(status: ProjectStatus, c: Palette<V>): V {
  switch (status) {
    case 'active':
      return c.blueFill;
    case 'on_hold':
      return c.orangeFill;
    case 'completed':
      return c.greenFill;
    default:
      return c.tertiaryFill;
  }
}

/** A project status as a `Badge` tone (mirrors `projectStatusColor` / `projectStatusTint`). */
export function projectStatusTone(status: ProjectStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'blue';
    case 'on_hold':
      return 'orange';
    case 'completed':
      return 'green';
    default:
      return 'neutral';
  }
}

export function projectStatusLabel(status: ProjectStatus, t: TranslateFn): string {
  return t(`projects.pstatus_${status}`);
}

export function priorityColor<V>(p: Priority, c: Palette<V>): V {
  switch (p) {
    case 'urgent':
      return c.red;
    case 'high':
      return c.orange;
    case 'low':
      return c.gray;
    default:
      return c.blue;
  }
}

export function priorityLabel(p: Priority, t: TranslateFn): string {
  return t(`projects.priority_${p}`);
}

/** Mirror of the server's fallback palette (apps/api/src/routes/projects.ts). */
export const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1'];

/** Spoken names of the palette swatches (VoiceOver), index-aligned with PROJECT_COLORS. */
const PROJECT_COLOR_NAMES: readonly TranslationKey[] = [
  'projects.color_blue',
  'projects.color_violet',
  'projects.color_cyan',
  'projects.color_amber',
  'projects.color_red',
  'projects.color_green',
  'projects.color_pink',
  'projects.color_indigo',
];

/** The spoken name of a palette color ("蓝色"); null for an off-palette hex. */
export function projectColorName(color: string, t: TranslateFn): string | null {
  const i = PROJECT_COLORS.findIndex((c) => c.toLowerCase() === color.toLowerCase());
  return i >= 0 ? t(PROJECT_COLOR_NAMES[i]) : null;
}

/** A project's color (data-driven hex) or the brand accent when unset. */
export function projectColor(color: string | null | undefined, hex: HexPalette): string {
  return color || hex.accent;
}

// ─── Access (client mirror of the server's projectAccess) ─

export interface ProjectAccess {
  /** Create/edit tasks, comment, edit project fields (members + super). */
  canWrite: boolean;
  /** Delete the project, manage members, change owner/visibility. */
  canManage: boolean;
}

/**
 * What the signed-in user may do on a project. Pass `members` when known
 * (detail endpoint); without them (list rows) only ownership is visible, so
 * `canWrite` falls back to `canManage`. The server re-checks everything.
 */
export function projectAccess(
  project: Pick<Project, 'owner_id' | 'created_by'>,
  members: ProjectMember[] | undefined,
  me: AuthenticatedUser | null,
): ProjectAccess {
  if (!me) return { canWrite: false, canManage: false };
  const isSuper = me.role === 'super';
  const member = members?.find((m) => m.user_id === me.id);
  const canManage = isSuper || member?.role === 'owner' || project.owner_id === me.id || project.created_by === me.id;
  const canWrite = members ? isSuper || !!member : canManage;
  return { canWrite, canManage };
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

/** A copy of the tree with one task patched (optimistic updates). */
export function patchTree(list: ProjectTask[], id: number, patch: Partial<ProjectTask>): ProjectTask[] {
  return list.map((t) => {
    if (t.id === id) return { ...t, ...patch };
    if (t.children?.length) {
      const children = patchTree(t.children, id, patch);
      return children === t.children ? t : { ...t, children };
    }
    return t;
  });
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
    const v: unknown = JSON.parse(tags || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function parseDeps(deps: ProjectTask['dependencies']): number[] {
  if (Array.isArray(deps)) return deps;
  try {
    const v: unknown = JSON.parse(deps || '[]');
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

export function isMilestone(task: Pick<ProjectTask, 'task_type'>): boolean {
  return task.task_type === 'milestone';
}

// ─── Date-only values (`YYYY-MM-DD` calendar days on the wire) ─

/**
 * The server stores task/project dates as date-only columns and the web reads
 * them as UTC days. Pickers work in local time, so a stamp is mapped to the
 * same *calendar day* at local noon (never midnight — a DST jump or a negative
 * UTC offset can't push noon into a neighbouring day) and back via the local
 * calendar components. Round-trips are exact in every time zone.
 */
export function stampToDate(stamp: string): Date {
  const [y, m, d] = stamp.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}

export function dateToStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The calendar day of a wire value (`2026-10-05` or a timestamp) as a stamp. */
export function toStamp(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const ms = parseMs(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86400000;

/**
 * Day number (days since 1970-01-01) of a stamp's calendar day — `YYYY-MM-DD`
 * parses as UTC midnight, so this is the calendar day itself in every time
 * zone (matches web's toISOString-based day math). Compare with `todayIndex`.
 */
export function dayIndex(date: string | null | undefined): number | null {
  const ms = parseMs(date);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / DAY_MS);
}

/**
 * Today's day index on the *local* calendar. Stamps are calendar days, so
 * "today" (the gantt today line, overdue, a project's late flag, the default
 * day a date toggle switches on to) is the user's own date — not the UTC one,
 * which would put the today line on yesterday for UTC+8 mornings.
 */
export function todayIndex(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
}

/** `YYYY-MM-DD` of today on the local calendar (see `todayIndex`). */
export function todayStamp(): string {
  return dateToStamp(new Date());
}

export function isOverdue(task: Pick<ProjectTask, 'due_date' | 'status'>): boolean {
  if (!task.due_date) return false;
  if (task.status === 'done' || task.status === 'cancelled') return false;
  return task.due_date.slice(0, 10) < todayStamp();
}

/**
 * Human date for rows and details: `10月5日` / `Oct 5`, with the year only when
 * it isn't the current one. Formats the calendar day of the stamp (no shift).
 */
export function formatDay(date: string | null | undefined, lang: LangPref): string {
  const stamp = toStamp(date);
  if (!stamp) return '';
  const d = stampToDate(stamp);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  try {
    return d.toLocaleDateString(localeOf(lang), {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? null : { year: 'numeric' }),
    });
  } catch {
    return sameYear ? `${d.getMonth() + 1}/${d.getDate()}` : stamp;
  }
}
