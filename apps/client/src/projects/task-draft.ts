/**
 * A task as the phone's form edits it: title, assignee, due day and priority. React-free
 * (./task-draft.test.ts). A new task posts what is set (`POST /api/projects/:id/tasks`); an edit
 * patches only what changed (`PATCH /api/projects/tasks/:id`), null clearing an assignee or a due
 * day, so a save never overwrites a field someone else changed meanwhile.
 */

import type { ProjectTask, TaskPriority } from '../shared/greenhouse-types';

export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

/** The longest title the phone sends (the web's limit). */
export const TASK_TITLE_MAX = 500;

export interface TaskDraft {
  title: string;
  assigneeId: string | null;
  /** `YYYY-MM-DD`, or null for no due day. */
  due: string | null;
  priority: TaskPriority;
}

export const EMPTY_DRAFT: TaskDraft = { title: '', assigneeId: null, due: null, priority: 'normal' };

/** The draft a saved task starts from (its due day without a time). */
export function draftOf(task: Pick<ProjectTask, 'title' | 'assignee_id' | 'due_date' | 'priority'>): TaskDraft {
  return {
    title: task.title,
    assigneeId: task.assignee_id ?? null,
    due: task.due_date ? task.due_date.slice(0, 10) : null,
    priority: TASK_PRIORITIES.includes(task.priority) ? task.priority : 'normal',
  };
}

const cleanTitle = (title: string) => title.trim().slice(0, TASK_TITLE_MAX);

/** A due day as typed (Android): `YYYY-MM-DD` that is a real date. */
export function validDay(day: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function canSaveDraft(draft: TaskDraft): boolean {
  return cleanTitle(draft.title).length > 0 && (draft.due === null || validDay(draft.due));
}

/** The body of a new task. */
export function createBody(draft: TaskDraft): Record<string, string> {
  const body: Record<string, string> = { title: cleanTitle(draft.title), priority: draft.priority };
  if (draft.assigneeId) body.assignee_id = draft.assigneeId;
  if (draft.due) body.due_date = draft.due;
  return body;
}

/** What an edit changes, field by field; empty when nothing did. */
export function taskPatch(from: TaskDraft, to: TaskDraft): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  const title = cleanTitle(to.title);
  if (title && title !== from.title.trim()) patch.title = title;
  if (to.assigneeId !== from.assigneeId) patch.assignee_id = to.assigneeId;
  if (to.due !== from.due) patch.due_date = to.due;
  if (to.priority !== from.priority) patch.priority = to.priority;
  return patch;
}
