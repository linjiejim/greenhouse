/**
 * Projects and their tasks (`/api/projects`, apps/api/src/routes/projects.ts). There is no task
 * by id and no "my tasks" route: a task comes from its project's tree, and my tasks from the
 * gantt view (every readable, non-archived project with its task tree in one call). A project
 * or task the member cannot read answers 404; a missing capability 403. Every call answers an
 * `ApiResult`, never throws.
 */

import type { Project, ProjectDetail, ProjectTask, TaskComment, TaskStatus } from '../shared/greenhouse-types';
import { collectPages } from '../data/paging';
import { get, patch, post, seg, type ApiResult } from './client';

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

export const updateTaskStatus = (taskId: string, status: TaskStatus) =>
  patch<{ task: ProjectTask }>(`/api/projects/tasks/${seg(String(taskId))}`, { status });

export const listTaskComments = (taskId: string) =>
  get<{ comments: TaskComment[] }>(`/api/projects/tasks/${seg(String(taskId))}/comments`);

export const addTaskComment = (taskId: string, content: string) =>
  post<{ comment: TaskComment }>(`/api/projects/tasks/${seg(String(taskId))}/comments`, { content });
