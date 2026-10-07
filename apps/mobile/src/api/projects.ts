/**
 * Project management — full read/write client for /api/projects
 * (mirrors the web pages/projects + project-detail API usage; route contract
 * in apps/api/src/routes/projects.ts). Mutations resolve to the saved row or
 * null/false on any failure — callers surface a generic error. Reads resolve
 * to `null` on failure (never a fake empty list), so screens can tell "none"
 * from "couldn't load" and offer a retry.
 *
 * Permission note: PATCH /:id with `owner_id` or `visibility` needs *manage*
 * rights (owner / creator / super) while other fields only need membership —
 * send those two keys only when they actually changed.
 */

import type {
  GanttProject,
  Priority,
  Project,
  ProjectActivity,
  ProjectMember,
  ProjectMemberRole,
  ProjectStats,
  ProjectStatus,
  ProjectTask,
  ProjectVisibility,
  TaskComment,
  TaskStatus,
} from '../shared/greenhouse-types';
import { api, apiJson } from './client';

export type {
  GanttProject,
  Priority,
  Project,
  ProjectActivity,
  ProjectMember,
  ProjectStats,
  ProjectStatus,
  ProjectMemberRole,
  ProjectTask,
  ProjectVisibility,
  TaskComment,
  TaskStatus,
};

export interface ProjectDetail {
  project: Project;
  /** Root tasks with nested children. */
  tasks: ProjectTask[];
  stats: ProjectStats;
  progress: number;
  members: ProjectMember[];
}

export interface ProjectInput {
  title?: string;
  description?: string;
  status?: ProjectStatus;
  priority?: Priority;
  owner_id?: string;
  start_date?: string | null;
  end_date?: string | null;
  color?: string | null;
  visibility?: ProjectVisibility;
}

export interface TaskInput {
  title?: string;
  description?: string;
  parent_id?: number | null;
  status?: ProjectTask['status'];
  priority?: Priority;
  task_type?: string;
  assignee_id?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  estimated_hours?: number | null;
  tags?: string[];
  dependencies?: number[];
}

export interface AssignableUser {
  id: string;
  nickname: string;
  role: string;
}

async function jsonOrNull<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── Projects ────────────────────────────────────────────

export async function listProjects(opts?: {
  status?: ProjectStatus;
  priority?: Priority;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ total: number; projects: Project[] } | null> {
  const q = new URLSearchParams();
  if (opts?.status) q.set('status', opts.status);
  if (opts?.priority) q.set('priority', opts.priority);
  if (opts?.search) q.set('search', opts.search);
  q.set('limit', String(opts?.limit ?? 50));
  q.set('offset', String(opts?.offset ?? 0));
  const data = await apiJson<{ total: number; projects: Project[] } | null>(`/api/projects?${q}`, null);
  return data ? { total: data.total ?? 0, projects: data.projects ?? [] } : null;
}

/**
 * One project's detail. A failure says whether it is *definitive* (403/404:
 * deleted or no access — drop any cached copy) or transient (offline, 5xx —
 * keep showing what we have).
 */
export type ProjectFetch = { ok: true; detail: ProjectDetail } | { ok: false; definitive: boolean };

export async function getProject(id: number): Promise<ProjectFetch> {
  try {
    const res = await api(`/api/projects/${id}`);
    const detail = await jsonOrNull<ProjectDetail>(res);
    if (detail) return { ok: true, detail };
    return { ok: false, definitive: res.status === 403 || res.status === 404 };
  } catch {
    return { ok: false, definitive: false };
  }
}

export async function createProject(body: ProjectInput & { title: string }): Promise<Project | null> {
  try {
    const data = await jsonOrNull<{ project: Project }>(
      await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    );
    return data?.project ?? null;
  } catch {
    return null;
  }
}

export async function updateProject(id: number, body: ProjectInput): Promise<Project | null> {
  try {
    const data = await jsonOrNull<{ project: Project }>(
      await api(`/api/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    );
    return data?.project ?? null;
  } catch {
    return null;
  }
}

export async function deleteProject(id: number): Promise<boolean> {
  try {
    return (await api(`/api/projects/${id}`, { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

/** All projects with task trees for the global gantt (archived excluded server-side). */
export async function getGlobalGantt(): Promise<GanttProject[] | null> {
  const data = await apiJson<{ projects: GanttProject[] } | null>('/api/projects/gantt', null);
  return data ? (data.projects ?? []) : null;
}

// ─── Tasks ───────────────────────────────────────────────

export async function createTask(projectId: number, body: TaskInput & { title: string }): Promise<ProjectTask | null> {
  try {
    const data = await jsonOrNull<{ task: ProjectTask }>(
      await api(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data?.task ?? null;
  } catch {
    return null;
  }
}

export async function updateTask(taskId: number, body: TaskInput): Promise<ProjectTask | null> {
  try {
    const data = await jsonOrNull<{ task: ProjectTask }>(
      await api(`/api/projects/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data?.task ?? null;
  } catch {
    return null;
  }
}

export async function deleteTask(taskId: number): Promise<boolean> {
  try {
    return (await api(`/api/projects/tasks/${taskId}`, { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

// ─── Comments ────────────────────────────────────────────

export async function listComments(taskId: number): Promise<TaskComment[] | null> {
  const data = await apiJson<{ comments: TaskComment[] } | null>(`/api/projects/tasks/${taskId}/comments`, null);
  return data ? (data.comments ?? []) : null;
}

export async function addComment(taskId: number, content: string): Promise<TaskComment | null> {
  try {
    const data = await jsonOrNull<{ comment: TaskComment }>(
      await api(`/api/projects/tasks/${taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    );
    return data?.comment ?? null;
  } catch {
    return null;
  }
}

export async function deleteComment(commentId: number): Promise<boolean> {
  try {
    return (await api(`/api/projects/comments/${commentId}`, { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

// ─── Activities / users / members ────────────────────────

export async function listActivities(projectId: number, limit = 30): Promise<ProjectActivity[] | null> {
  const data = await apiJson<{ activities: ProjectActivity[] } | null>(`/api/projects/${projectId}/activities?limit=${limit}`, null);
  return data ? (data.activities ?? []) : null;
}

/** Active internal users for assignment / ownership / membership pickers (`[]` on failure). */
export async function listAssignableUsers(): Promise<AssignableUser[]> {
  const data = await apiJson<{ users: AssignableUser[] }>('/api/projects/meta/users', { users: [] });
  return data.users ?? [];
}

export async function addMember(projectId: number, userId: string, role?: ProjectMemberRole): Promise<ProjectMember | null> {
  try {
    const data = await jsonOrNull<{ member: ProjectMember }>(
      await api(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, role }),
      }),
    );
    return data?.member ?? null;
  } catch {
    return null;
  }
}

/** Promote / demote a member (owner ⇄ member). */
export async function updateMemberRole(projectId: number, userId: string, role: ProjectMemberRole): Promise<boolean> {
  try {
    const res = await api(`/api/projects/${projectId}/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function removeMember(projectId: number, userId: string): Promise<boolean> {
  try {
    return (await api(`/api/projects/${projectId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}
