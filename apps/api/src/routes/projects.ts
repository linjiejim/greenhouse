/**
 * Project Management routes — /api/projects (Platform Kernel adapter)
 *
 * GET    /api/projects                         — 项目列表（含进度统计）
 * POST   /api/projects                         — 创建项目
 * GET    /api/projects/gantt                   — 全局甘特图
 * PATCH  /api/projects/tasks-reorder           — 批量排序/跨项目移动
 * PATCH  /api/projects/tasks/:taskId/move      — 移动任务
 * GET    /api/projects/:id                     — 项目详情
 * PATCH  /api/projects/:id                     — 更新项目
 * DELETE /api/projects/:id                     — 删除项目
 * GET    /api/projects/:id/tasks               — 任务列表
 * POST   /api/projects/:id/tasks               — 创建任务
 * PATCH  /api/projects/tasks/:taskId           — 更新任务
 * DELETE /api/projects/tasks/:taskId           — 删除任务
 * GET    /api/projects/tasks/:taskId/comments  — 评论列表
 * POST   /api/projects/tasks/:taskId/comments  — 添加评论
 * DELETE /api/projects/comments/:commentId     — 删除评论
 * GET    /api/projects/:id/activities          — 活动记录
 * GET    /api/projects/meta/users              — 可指派用户
 * GET    /api/projects/:id/members             — 成员列表
 * POST   /api/projects/:id/members             — 添加成员
 * PATCH  /api/projects/:id/members/:userId     — 修改成员角色
 * DELETE /api/projects/:id/members/:userId     — 移除成员
 */

import { Hono, type Context } from 'hono';
import { getDb, type ProjectMemberRow, type ProjectRow, type TaskRow } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { humanActor } from '../platform/actor.js';
import { projectResource, type ProjectActionId } from '../platform/projects/application.js';
import { getPlatformRuntime } from '../platform/runtime.js';

const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1'];

type ActionFailure = {
  ok: false;
  code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR';
  message: string;
};

type TaskTreeNode = TaskRow & {
  assignee_nickname: string | null;
  children: TaskTreeNode[];
};

function errorStatus(code: ActionFailure['code']): 400 | 403 | 404 | 409 | 500 {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'INTERNAL_ERROR':
      return 500;
  }
}

function actionError(c: Context, result: ActionFailure) {
  return c.json({ error: result.message }, errorStatus(result.code));
}

async function dispatch(
  c: Context,
  actionId: ProjectActionId,
  payload: unknown,
  ids: { projectId?: number; taskId?: number; commentId?: number } = {},
) {
  return getPlatformRuntime().dispatch({
    actor: humanActor(getAuthUser(c), c),
    appId: 'projects',
    actionId,
    payload,
    resource: projectResource(actionId, ids),
  });
}

async function getUserMap() {
  const users = await getDb().users.list();
  return new Map(users.map((user) => [user.id, user]));
}

function buildTaskTree(tasks: TaskRow[], userMap: Awaited<ReturnType<typeof getUserMap>>): TaskTreeNode[] {
  const taskMap = new Map<number, TaskTreeNode>();
  for (const task of tasks) {
    taskMap.set(task.id, {
      ...task,
      assignee_nickname: userMap.get(task.assignee_id ?? '')?.nickname ?? task.assignee_id,
      children: [],
    });
  }
  const roots: TaskTreeNode[] = [];
  for (const task of taskMap.values()) {
    const parent = task.parent_id ? taskMap.get(task.parent_id) : undefined;
    if (parent) parent.children.push(task);
    else roots.push(task);
  }
  return roots;
}

const projects = new Hono<AppEnv>()
  .get('/gantt', async (c) => {
    const statusFilter = c.req.query('status');
    const allowedStatuses = statusFilter ? statusFilter.split(',').map((status) => status.trim()) : undefined;
    const result = await dispatch(c, 'getGantt', { limit: 200 });
    if (!result.ok) return actionError(c, result);
    const rows = (result.data as { projects: ProjectRow[] }).projects;
    const filtered = allowedStatuses
      ? rows.filter((project) => allowedStatuses.includes(project.status))
      : rows.filter((project) => project.status !== 'archived');
    const userMap = await getUserMap();
    const enriched = await Promise.all(
      filtered.map(async (project, index) => {
        const tasksResult = await dispatch(
          c,
          'listTasks',
          { projectId: project.id, limit: 500 },
          { projectId: project.id },
        );
        if (!tasksResult.ok) return null;
        const [stats] = await Promise.all([getDb().projects.getProjectStats(project.id)]);
        const tasks = (tasksResult.data as { tasks: TaskRow[] }).tasks;
        return {
          id: project.id,
          title: project.title,
          description: project.description,
          status: project.status,
          priority: project.priority,
          owner_id: project.owner_id,
          owner_nickname: userMap.get(project.owner_id)?.nickname ?? project.owner_id,
          start_date: project.start_date,
          end_date: project.end_date,
          color: project.color || PROJECT_COLORS[index % PROJECT_COLORS.length],
          tasks: buildTaskTree(tasks, userMap),
          stats,
          progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
        };
      }),
    );
    return c.json({ projects: enriched.filter((project) => project !== null) });
  })
  .patch('/tasks-reorder', async (c) => {
    const body = (await c.req.json()) as {
      updates?: Array<{ id: number; sort_order: number; project_id?: number }>;
    };
    const result = await dispatch(c, 'reorderTasks', {
      updates: body.updates?.map((update) => ({
        id: update.id,
        sortOrder: update.sort_order,
        projectId: update.project_id,
      })),
    });
    if (!result.ok) return actionError(c, result);
    return c.json({ success: true });
  })
  .patch('/tasks/:taskId/move', async (c) => {
    const taskId = Number(c.req.param('taskId'));
    const body = (await c.req.json()) as { project_id?: number };
    const result = await dispatch(
      c,
      'moveTask',
      { taskId, projectId: body.project_id },
      { taskId, projectId: body.project_id },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { task: TaskRow });
  })
  .get('/', async (c) => {
    const result = await dispatch(c, 'listProjects', {
      status: c.req.query('status') || undefined,
      priority: c.req.query('priority') || undefined,
      search: c.req.query('search') || undefined,
      limit: Number(c.req.query('limit') || 50),
      offset: Number(c.req.query('offset') || 0),
    });
    if (!result.ok) return actionError(c, result);
    const { projects: rows, total } = result.data as { projects: ProjectRow[]; total: number };
    const userMap = await getUserMap();
    const enriched = await Promise.all(
      rows.map(async (project) => {
        const stats = await getDb().projects.getProjectStats(project.id);
        return {
          ...project,
          owner_nickname: userMap.get(project.owner_id)?.nickname ?? project.owner_id,
          stats,
          progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
        };
      }),
    );
    return c.json({ total, projects: enriched });
  })
  .post('/', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await dispatch(c, 'createProject', {
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      ownerId: body.owner_id,
      startDate: body.start_date,
      endDate: body.end_date,
      color: body.color,
      visibility: body.visibility,
    });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { project: ProjectRow }, 201);
  })
  .get('/:id', async (c) => {
    const projectId = Number(c.req.param('id'));
    const projectResult = await dispatch(c, 'getProject', { projectId }, { projectId });
    if (!projectResult.ok) return actionError(c, projectResult);
    const project = (projectResult.data as { project: ProjectRow }).project;
    const [tasksResult, membersResult, stats, userMap] = await Promise.all([
      dispatch(c, 'listTasks', { projectId, limit: 500 }, { projectId }),
      dispatch(c, 'listMembers', { projectId }, { projectId }),
      getDb().projects.getProjectStats(projectId),
      getUserMap(),
    ]);
    if (!tasksResult.ok) return actionError(c, tasksResult);
    if (!membersResult.ok) return actionError(c, membersResult);
    const tasks = (tasksResult.data as { tasks: TaskRow[] }).tasks;
    const members = (membersResult.data as { members: ProjectMemberRow[] }).members;
    return c.json({
      project: {
        ...project,
        owner_nickname: userMap.get(project.owner_id)?.nickname ?? project.owner_id,
      },
      tasks: buildTaskTree(tasks, userMap),
      stats,
      progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
      members: members.map((member) => ({
        ...member,
        nickname: userMap.get(member.user_id)?.nickname ?? member.user_id,
      })),
    });
  })
  .patch('/:id', async (c) => {
    const projectId = Number(c.req.param('id'));
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await dispatch(
      c,
      'updateProject',
      {
        projectId,
        updates: {
          title: body.title,
          description: body.description,
          status: body.status,
          priority: body.priority,
          owner_id: body.owner_id,
          start_date: body.start_date,
          end_date: body.end_date,
          color: body.color,
          visibility: body.visibility,
        },
      },
      { projectId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { project: ProjectRow });
  })
  .delete('/:id', async (c) => {
    const projectId = Number(c.req.param('id'));
    const result = await dispatch(c, 'deleteProject', { projectId }, { projectId });
    if (!result.ok) return actionError(c, result);
    return c.json({ success: true });
  })
  .get('/:id/tasks', async (c) => {
    const projectId = Number(c.req.param('id'));
    const result = await dispatch(
      c,
      'listTasks',
      {
        projectId,
        status: c.req.query('status') || undefined,
        assigneeId: c.req.query('assignee_id') || undefined,
      },
      { projectId },
    );
    if (!result.ok) return actionError(c, result);
    const userMap = await getUserMap();
    const tasks = (result.data as { tasks: TaskRow[] }).tasks.map((task) => ({
      ...task,
      assignee_nickname: userMap.get(task.assignee_id ?? '')?.nickname ?? task.assignee_id,
      tags: safeJsonParse(task.tags, []) as string[],
    }));
    return c.json({ tasks });
  })
  .post('/:id/tasks', async (c) => {
    const projectId = Number(c.req.param('id'));
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await dispatch(
      c,
      'createTask',
      {
        projectId,
        parentId: body.parent_id,
        title: body.title,
        description: body.description,
        status: body.status,
        priority: body.priority,
        taskType: body.task_type,
        assigneeId: body.assignee_id,
        startDate: body.start_date,
        dueDate: body.due_date,
        estimatedHours: body.estimated_hours,
        tags: body.tags,
        dependencies: body.dependencies,
      },
      { projectId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { task: TaskRow }, 201);
  })
  .patch('/tasks/:taskId', async (c) => {
    const taskId = Number(c.req.param('taskId'));
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await dispatch(
      c,
      'updateTask',
      {
        taskId,
        updates: {
          title: body.title,
          description: body.description,
          status: body.status,
          priority: body.priority,
          task_type: body.task_type,
          assignee_id: body.assignee_id,
          parent_id: body.parent_id,
          project_id: body.project_id,
          start_date: body.start_date,
          due_date: body.due_date,
          sort_order: body.sort_order,
          estimated_hours: body.estimated_hours,
          tags: body.tags,
          dependencies: body.dependencies,
        },
      },
      { taskId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { task: TaskRow });
  })
  .delete('/tasks/:taskId', async (c) => {
    const taskId = Number(c.req.param('taskId'));
    const result = await dispatch(c, 'deleteTask', { taskId }, { taskId });
    if (!result.ok) return actionError(c, result);
    return c.json({ success: true });
  })
  .get('/tasks/:taskId/comments', async (c) => {
    const taskId = Number(c.req.param('taskId'));
    const result = await dispatch(c, 'listComments', { taskId }, { taskId });
    if (!result.ok) return actionError(c, result);
    const userMap = await getUserMap();
    const comments = (
      result.data as {
        comments: Array<{ id: number; task_id: number; user_id: string; content: string; created_at: string }>;
      }
    ).comments;
    return c.json({
      comments: comments.map((comment) => ({
        ...comment,
        user_nickname: userMap.get(comment.user_id)?.nickname ?? comment.user_id,
      })),
    });
  })
  .post('/tasks/:taskId/comments', async (c) => {
    const taskId = Number(c.req.param('taskId'));
    const body = (await c.req.json()) as { content?: string };
    const result = await dispatch(c, 'addComment', { taskId, content: body.content }, { taskId });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        comment: { id: number; task_id: number; user_id: string; content: string; created_at: string };
      },
      201,
    );
  })
  .delete('/comments/:commentId', async (c) => {
    const commentId = Number(c.req.param('commentId'));
    const result = await dispatch(c, 'deleteComment', { commentId }, { commentId });
    if (!result.ok) return actionError(c, result);
    return c.json({ success: true });
  })
  .get('/:id/activities', async (c) => {
    const projectId = Number(c.req.param('id'));
    const result = await dispatch(
      c,
      'listActivities',
      {
        projectId,
        limit: Number(c.req.query('limit') || 50),
        offset: Number(c.req.query('offset') || 0),
      },
      { projectId },
    );
    if (!result.ok) return actionError(c, result);
    const userMap = await getUserMap();
    const activities = (
      result.data as {
        activities: Array<{
          id: number;
          project_id: number;
          task_id: number | null;
          user_id: string;
          action: string;
          detail: string | null;
          created_at: string;
        }>;
      }
    ).activities;
    return c.json({
      activities: activities.map((activity) => ({
        ...activity,
        user_nickname: userMap.get(activity.user_id)?.nickname ?? activity.user_id,
      })),
    });
  })
  .get('/meta/users', async (c) => {
    const result = await dispatch(c, 'listAssignableUsers', {});
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { users: Array<{ id: string; nickname: string; role: string }> });
  })
  .get('/:id/members', async (c) => {
    const projectId = Number(c.req.param('id'));
    const result = await dispatch(c, 'listMembers', { projectId }, { projectId });
    if (!result.ok) return actionError(c, result);
    const userMap = await getUserMap();
    const members = (result.data as { members: ProjectMemberRow[] }).members;
    return c.json({
      members: members.map((member) => ({
        ...member,
        nickname: userMap.get(member.user_id)?.nickname ?? member.user_id,
      })),
    });
  })
  .post('/:id/members', async (c) => {
    const projectId = Number(c.req.param('id'));
    const body = (await c.req.json()) as { user_id?: string; role?: 'owner' | 'member' };
    const result = await dispatch(
      c,
      'manageMembers',
      { projectId, operation: 'add', userId: body.user_id, role: body.role },
      { projectId },
    );
    if (!result.ok) return actionError(c, result);
    const member = (result.data as { member: ProjectMemberRow }).member;
    const user = await getDb().users.getById(member.user_id);
    return c.json({ member: { ...member, nickname: user?.nickname ?? member.user_id } }, 201);
  })
  .patch('/:id/members/:userId', async (c) => {
    const projectId = Number(c.req.param('id'));
    const body = (await c.req.json()) as { role?: 'owner' | 'member' };
    const result = await dispatch(
      c,
      'manageMembers',
      { projectId, operation: 'update', userId: c.req.param('userId'), role: body.role },
      { projectId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { member: ProjectMemberRow });
  })
  .delete('/:id/members/:userId', async (c) => {
    const projectId = Number(c.req.param('id'));
    const result = await dispatch(
      c,
      'manageMembers',
      { projectId, operation: 'remove', userId: c.req.param('userId') },
      { projectId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json({ success: true });
  });

export default projects;
