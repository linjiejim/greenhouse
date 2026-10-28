/**
 * Projects and their tasks (`/api/projects`, apps/api/src/routes/projects.ts). There is no task
 * by id and no "my tasks" route: a task comes from its project's tree, and my tasks from the
 * gantt view (every readable, non-archived project with its task tree in one call). A project
 * or task the member cannot read answers 404; a missing capability 403. Every call answers an
 * `ApiResult`, never throws.
 */

import type {
  Project,
  ProjectDetail,
  ProjectMember,
  ProjectTask,
  TaskComment,
  TaskStatus,
} from '../shared/greenhouse-types';
import { collectPages } from '../data/paging';
import { del, get, patch, post, seg, type ApiResult } from './client';

const PAGE = 50;

/** Every project I can read (not archived unless asked), paged by offset. */
export async function listProjects(stillCurrent: () => boolean): Promise<ApiResult<Project[]>> {
  return collectPages<Project>(
    async (offset, limit) => {
      const page = await get<{ projects: Project[]; total: number }>('/api/projects', { limit, offset });
      return page.ok ? { ok: true, data: page.data.projects } : page;
    },
    { pageSize: PAGE, stillCurrent },
  );
}

/** A new project, mine (`POST /api/projects`); the station refuses without the capability (403). */
export const createProject = (title: string) => post<{ project: Project }>('/api/projects', { title });

export const getProject = (id: string) => get<ProjectDetail>(`/api/projects/${seg(String(id))}`);

/** Every readable, non-archived project with its task tree — the source of "my tasks". */
export const gantt = () =>
  get<{ projects: (Project & { tasks: ProjectTask[] })[] }>('/api/projects/gantt');

/** A new task in a project (`POST /api/projects/:id/tasks`, body from src/projects/task-draft.ts). */
export const createTask = (projectId: string, body: Record<string, string>) =>
  post<{ task: ProjectTask }>(`/api/projects/${seg(String(projectId))}/tasks`, body);

/** Change a task's fields (only those given; null clears an assignee or a due day). */
export const updateTask = (taskId: string, patchBody: Record<string, string | null>) =>
  patch<{ task: ProjectTask }>(`/api/projects/tasks/${seg(String(taskId))}`, patchBody);

/** The people a task may be assigned to (active members). */
export const listAssignableUsers = () =>
  get<{ users: { id: string; nickname: string; role: string }[] }>('/api/projects/meta/users');

export const updateTaskStatus = (taskId: string, status: TaskStatus) =>
  patch<{ task: ProjectTask }>(`/api/projects/tasks/${seg(String(taskId))}`, { status });

export const listTaskComments = (taskId: string) =>
  get<{ comments: TaskComment[] }>(`/api/projects/tasks/${seg(String(taskId))}/comments`);

export const addTaskComment = (taskId: string, content: string) =>
  post<{ comment: TaskComment }>(`/api/projects/tasks/${seg(String(taskId))}/comments`, { content });

/**
 * A project's members (`/api/projects/:id/members`). Anyone who reads the project reads them;
 * adding, changing a role and removing take a manager (super, the owner, the maker or an
 * owner-role member): others are refused, as is removing the owner or the maker (409).
 */
export const listMembers = (projectId: string) =>
  get<{ members: ProjectMember[] }>(`/api/projects/${seg(String(projectId))}/members`);

export const addMember = (projectId: string, userId: string, role: ProjectMember['role']) =>
  post<{ member: ProjectMember }>(`/api/projects/${seg(String(projectId))}/members`, { user_id: userId, role });

export const setMemberRole = (projectId: string, userId: string, role: ProjectMember['role']) =>
  patch<{ member: ProjectMember }>(`/api/projects/${seg(String(projectId))}/members/${seg(userId)}`, { role });

export const removeMember = (projectId: string, userId: string) =>
  del<{ success: true }>(`/api/projects/${seg(String(projectId))}/members/${seg(userId)}`);
