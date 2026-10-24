/**
 * Project tasks on the phone. React-free (./tasks.test.ts): flattening the task trees the project
 * routes answer, "my tasks" (open tasks assigned to me, by due date), due-date buckets, and the
 * optimistic patch of one task in a tree.
 */

import type { ProjectTask, TaskStatus } from '../shared/greenhouse-types';

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'];
const OPEN: ReadonlySet<TaskStatus> = new Set(['todo', 'in_progress', 'in_review']);

export const isOpen = (status: TaskStatus) => OPEN.has(status);

/** Every task of a tree, parents before their children, without the `children` arrays. */
export function flattenTasks(tree: readonly ProjectTask[]): ProjectTask[] {
  const out: ProjectTask[] = [];
  const walk = (tasks: readonly ProjectTask[], depth: number) => {
    if (depth > 20) return;
    for (const task of tasks) {
      const { children, ...flat } = task;
      out.push(flat);
      if (children?.length) walk(children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** A task tree with one task found (or null). */
export function findTask(tree: readonly ProjectTask[], id: number): ProjectTask | null {
  for (const task of tree) {
    if (task.id === id) return task;
    const inner = task.children?.length ? findTask(task.children, id) : null;
    if (inner) return inner;
  }
  return null;
}

/** The tree with one task's fields replaced (a new tree; the rest shared). */
export function withTaskPatched(tree: readonly ProjectTask[], id: number, patch: Partial<ProjectTask>): ProjectTask[] {
  return tree.map((task) => {
    if (task.id === id) return { ...task, ...patch };
    if (!task.children?.length) return task;
    const children = withTaskPatched(task.children, id, patch);
    return children.some((child, i) => child !== task.children![i]) ? { ...task, children } : task;
  });
}

/** `tags` as the routes answer them: a string array, a JSON string of one, or nothing. */
export function parseTags(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '') : [];
}

/** The local calendar day of `now` as `YYYY-MM-DD` (due dates are calendar days). */
export function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `day` plus `n` calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + n));
}

export type DueBucket = 'overdue' | 'today' | 'soon' | 'later' | 'none';
export const DUE_BUCKETS: readonly DueBucket[] = ['overdue', 'today', 'soon', 'later', 'none'];

/** Where a due date falls from `today`: overdue, today, within `soonDays`, later, or none. */
export function dueBucket(due: string | null | undefined, today: string, soonDays = 7): DueBucket {
  const day = due?.slice(0, 10);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'none';
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return day <= addDays(today, soonDays) ? 'soon' : 'later';
}

export interface MyTask extends ProjectTask {
  project_title: string;
  project_color: string | null;
}

/**
 * My open tasks across projects, grouped by when they are due (overdue first, no date last),
 * each group by due date then title. Empty groups are left out.
 */
export function myTasks(
  projects: readonly { id: number; title: string; color: string | null; tasks: readonly ProjectTask[] }[],
  userId: string,
  today: string,
): { bucket: DueBucket; tasks: MyTask[] }[] {
  const mine: MyTask[] = [];
  for (const project of projects) {
    for (const task of flattenTasks(project.tasks)) {
      if (task.assignee_id === userId && isOpen(task.status)) {
        mine.push({ ...task, project_title: project.title, project_color: project.color });
      }
    }
  }
  return groupMyTasks(mine, today);
}

/**
 * My tasks grouped by when they are due as seen on `today` (overdue first, no date last), each
 * group by due date then title, empty groups left out. Also regroups a saved list when it is shown,
 * so a copy saved yesterday does not still call yesterday's tasks "today".
 */
export function groupMyTasks(tasks: readonly MyTask[], today: string): { bucket: DueBucket; tasks: MyTask[] }[] {
  const groups = new Map<DueBucket, MyTask[]>();
  for (const task of tasks) {
    const bucket = dueBucket(task.due_date, today);
    groups.set(bucket, [...(groups.get(bucket) ?? []), task]);
  }
  const byDue = (a: MyTask, b: MyTask) =>
    (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.title.localeCompare(b.title);
  return DUE_BUCKETS.filter((bucket) => groups.has(bucket)).map((bucket) => ({
    bucket,
    tasks: groups.get(bucket)!.sort(byDue),
  }));
}
