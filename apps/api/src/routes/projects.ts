/**
 * Project Management routes — /api/projects
 *
 * GET    /api/projects                    — 项目列表（含进度统计）
 * POST   /api/projects                    — 创建项目
 * GET    /api/projects/:id                — 项目详情（含任务树）
 * PATCH  /api/projects/:id                — 更新项目
 * DELETE /api/projects/:id                — 删除项目
 * GET    /api/projects/:id/tasks          — 任务列表
 * POST   /api/projects/:id/tasks          — 创建任务
 * PATCH  /api/projects/tasks/:taskId      — 更新任务
 * DELETE /api/projects/tasks/:taskId      — 删除任务
 * PATCH  /api/projects/tasks-reorder      — 批量排序（支持跨项目移动）
 * PATCH  /api/projects/tasks/:taskId/move  — 移动任务到其他项目
 * GET    /api/projects/tasks/:taskId/comments — 获取评论
 * POST   /api/projects/tasks/:taskId/comments — 添加评论
 * DELETE /api/projects/comments/:commentId    — 删除评论
 * GET    /api/projects/:id/activities     — 变更记录
 * GET    /api/projects/:id/members        — 项目成员列表
 * POST   /api/projects/:id/members        — 添加成员
 * PATCH  /api/projects/:id/members/:userId — 更新成员角色
 * DELETE /api/projects/:id/members/:userId — 移除成员
 * GET    /api/projects/gantt             — 全局甘特图数据（所有项目 + 任务树）
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { ProjectStatus, Priority, TaskStatus, ProjectVisibility, ProjectMemberRole } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';

// ─── Helper: enrich with user nicknames ──────────────────

async function getUserMap() {
  const users = await getDb().users.list();
  return new Map(users.map((u) => [u.id, u]));
}

// ─── Global Gantt ────────────────────────────────────────

const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1'];

const projects = new Hono<AppEnv>()
  /** GET /gantt — all projects with task trees for global gantt view */
  .get('/gantt', async (c) => {
    const user = getAuthUser(c);
    const statusFilter = c.req.query('status'); // comma-separated, e.g. "active,planning"
    const allowedStatuses = statusFilter ? statusFilter.split(',').map((s) => s.trim()) : undefined;

    const [allProjects, userMap] = await Promise.all([
      getDb().projects.listProjects({ limit: 200, userId: user.id, userRole: user.role }),
      getUserMap(),
    ]);

    // Filter by status if provided, otherwise exclude archived
    const filtered = allowedStatuses
      ? allProjects.filter((p) => allowedStatuses.includes(p.status))
      : allProjects.filter((p) => p.status !== 'archived');

    const enriched = await Promise.all(
      filtered.map(async (p, idx) => {
        const [tasks, stats] = await Promise.all([
          getDb().projects.listTasks(p.id),
          getDb().projects.getProjectStats(p.id),
        ]);

        // Build task tree
        const taskMap = new Map(
          tasks.map((t) => [
            t.id,
            {
              ...t,
              assignee_nickname: userMap.get(t.assignee_id ?? '')?.nickname ?? t.assignee_id,
              children: [] as any[],
            },
          ]),
        );
        const rootTasks: any[] = [];
        for (const task of taskMap.values()) {
          if (task.parent_id && taskMap.has(task.parent_id)) {
            taskMap.get(task.parent_id)!.children.push(task);
          } else {
            rootTasks.push(task);
          }
        }

        return {
          id: p.id,
          title: p.title,
          description: p.description,
          status: p.status,
          priority: p.priority,
          owner_id: p.owner_id,
          owner_nickname: userMap.get(p.owner_id)?.nickname ?? p.owner_id,
          start_date: p.start_date,
          end_date: p.end_date,
          color: p.color || PROJECT_COLORS[idx % PROJECT_COLORS.length],
          tasks: rootTasks,
          stats,
          progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
        };
      }),
    );

    return c.json({ projects: enriched });
  })
  // ─── Tasks batch operations (before /:id to avoid route conflict) ──

  /** PATCH /tasks-reorder — batch reorder tasks (supports cross-project move) */
  .patch('/tasks-reorder', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json()) as {
      updates: Array<{ id: number; sort_order: number; project_id?: number }>;
    };
    if (!body.updates?.length) return c.json({ error: 'updates array required' }, 400);

    // Separate moves (project_id change) from simple reorders
    const moves = body.updates.filter((u) => u.project_id !== undefined);
    const reorders = body.updates.map((u) => ({ id: u.id, sort_order: u.sort_order }));

    // Handle project_id changes first
    for (const mv of moves) {
      await getDb().projects.updateTask(mv.id, { project_id: mv.project_id }, user.id);
    }

    // Then reorder
    await getDb().projects.reorderTasks(reorders);
    return c.json({ success: true });
  })
  /** PATCH /tasks/:taskId/move — move task to another project */
  .patch('/tasks/:taskId/move', async (c) => {
    const user = getAuthUser(c);
    const taskId = parseInt(c.req.param('taskId'), 10);
    if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);

    const body = (await c.req.json()) as { project_id: number };
    if (!body.project_id) return c.json({ error: 'project_id is required' }, 400);

    // Verify target project exists
    const targetProject = await getDb().projects.getProjectById(body.project_id);
    if (!targetProject) return c.json({ error: 'Target project not found' }, 404);

    const updated = await getDb().projects.updateTask(taskId, { project_id: body.project_id }, user.id);
    if (!updated) return c.json({ error: 'Task not found' }, 404);

    return c.json({ task: updated });
  })
  // ─── Projects CRUD ───────────────────────────────────────

  /** GET / — list projects with progress stats */
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const status = c.req.query('status') as ProjectStatus | undefined;
    const priority = c.req.query('priority') as Priority | undefined;
    const search = c.req.query('search') || undefined;
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const opts = { status, priority, search, limit, offset, userId: user.id, userRole: user.role };
    const [list, total, userMap] = await Promise.all([
      getDb().projects.listProjects(opts),
      getDb().projects.countProjects(opts),
      getUserMap(),
    ]);

    // Enrich with stats and user info
    const enriched = await Promise.all(
      list.map(async (p) => {
        const stats = await getDb().projects.getProjectStats(p.id);
        return {
          ...p,
          owner_nickname: userMap.get(p.owner_id)?.nickname ?? p.owner_id,
          visibility: p.visibility,
          stats,
          progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
        };
      }),
    );

    return c.json({ total, projects: enriched });
  })
  /** POST / — create project */
  .post('/', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json()) as {
      title: string;
      description?: string;
      status?: ProjectStatus;
      priority?: Priority;
      owner_id?: string;
      start_date?: string;
      end_date?: string;
      color?: string;
      visibility?: ProjectVisibility;
    };

    if (!body.title?.trim()) return c.json({ error: 'Title is required' }, 400);

    const project = await getDb().projects.createProject({
      title: body.title.trim(),
      description: body.description,
      status: body.status,
      priority: body.priority,
      owner_id: body.owner_id || user.id,
      start_date: body.start_date,
      end_date: body.end_date,
      color: body.color,
      visibility: body.visibility,
      created_by: user.id,
    });

    return c.json({ project }, 201);
  })
  /** GET /:id — project detail with task tree */
  .get('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const project = await getDb().projects.getProjectById(id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Visibility check: private projects only for super or members
    if (project.visibility === 'private' && user.role !== 'super') {
      const isMember = await getDb().projects.isMember(id, user.id);
      if (!isMember) return c.json({ error: 'Project not found' }, 404);
    }

    const [tasks, stats, userMap, members] = await Promise.all([
      getDb().projects.listTasks(id),
      getDb().projects.getProjectStats(id),
      getUserMap(),
      getDb().projects.getMembers(id),
    ]);

    // Build task tree
    const taskMap = new Map(
      tasks.map((t) => [
        t.id,
        { ...t, assignee_nickname: userMap.get(t.assignee_id ?? '')?.nickname ?? t.assignee_id, children: [] as any[] },
      ]),
    );
    const rootTasks: any[] = [];
    for (const task of taskMap.values()) {
      if (task.parent_id && taskMap.has(task.parent_id)) {
        taskMap.get(task.parent_id)!.children.push(task);
      } else {
        rootTasks.push(task);
      }
    }

    return c.json({
      project: {
        ...project,
        owner_nickname: userMap.get(project.owner_id)?.nickname ?? project.owner_id,
      },
      tasks: rootTasks,
      stats,
      progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
      members: members.map((m) => ({
        ...m,
        nickname: userMap.get(m.user_id)?.nickname ?? m.user_id,
      })),
    });
  })
  /** PATCH /:id — update project */
  .patch('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const body = (await c.req.json()) as {
      title?: string;
      description?: string;
      status?: ProjectStatus;
      priority?: Priority;
      owner_id?: string;
      start_date?: string | null;
      end_date?: string | null;
      color?: string | null;
      visibility?: ProjectVisibility;
    };

    const updated = await getDb().projects.updateProject(id, body, user.id);
    if (!updated) return c.json({ error: 'Project not found' }, 404);

    return c.json({ project: updated });
  })
  /** DELETE /:id — delete project */
  .delete('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const deleted = await getDb().projects.deleteProject(id);
    if (!deleted) return c.json({ error: 'Project not found' }, 404);

    return c.json({ success: true });
  })
  // ─── Tasks CRUD ──────────────────────────────────────────

  /** GET /:id/tasks — list tasks for a project */
  .get('/:id/tasks', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    if (isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);

    const status = c.req.query('status') as TaskStatus | undefined;
    const assignee_id = c.req.query('assignee_id') || undefined;

    const tasks = await getDb().projects.listTasks(projectId, { status, assignee_id });
    const userMap = await getUserMap();

    const enriched = tasks.map((t) => ({
      ...t,
      assignee_nickname: userMap.get(t.assignee_id ?? '')?.nickname ?? t.assignee_id,
      tags: JSON.parse(t.tags || '[]'),
    }));

    return c.json({ tasks: enriched });
  })
  /** POST /:id/tasks — create task */
  .post('/:id/tasks', async (c) => {
    const user = getAuthUser(c);
    const projectId = parseInt(c.req.param('id'), 10);
    if (isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);

    // Verify project exists
    const project = await getDb().projects.getProjectById(projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const body = (await c.req.json()) as {
      title: string;
      description?: string;
      parent_id?: number;
      status?: TaskStatus;
      priority?: Priority;
      task_type?: string;
      assignee_id?: string;
      start_date?: string;
      due_date?: string;
      estimated_hours?: number;
      tags?: string[];
      dependencies?: number[];
    };

    if (!body.title?.trim()) return c.json({ error: 'Title is required' }, 400);

    const task = await getDb().projects.createTask({
      project_id: projectId,
      parent_id: body.parent_id,
      title: body.title.trim(),
      description: body.description,
      status: body.status,
      priority: body.priority,
      task_type: body.task_type,
      assignee_id: body.assignee_id,
      start_date: body.start_date,
      due_date: body.due_date,
      estimated_hours: body.estimated_hours,
      tags: body.tags,
      dependencies: body.dependencies,
      created_by: user.id,
    });

    return c.json({ task }, 201);
  })
  /** PATCH /tasks/:taskId — update task */
  .patch('/tasks/:taskId', async (c) => {
    const user = getAuthUser(c);
    const taskId = parseInt(c.req.param('taskId'), 10);
    if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);

    const body = (await c.req.json()) as {
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: Priority;
      task_type?: string;
      assignee_id?: string | null;
      parent_id?: number | null;
      project_id?: number;
      start_date?: string | null;
      due_date?: string | null;
      sort_order?: number;
      estimated_hours?: number | null;
      tags?: string[];
      dependencies?: number[];
    };

    const updated = await getDb().projects.updateTask(taskId, body, user.id);
    if (!updated) return c.json({ error: 'Task not found' }, 404);

    return c.json({ task: updated });
  })
  /** DELETE /tasks/:taskId — delete task */
  .delete('/tasks/:taskId', async (c) => {
    const taskId = parseInt(c.req.param('taskId'), 10);
    if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);

    const deleted = await getDb().projects.deleteTask(taskId);
    if (!deleted) return c.json({ error: 'Task not found' }, 404);

    return c.json({ success: true });
  })
  /* tasks-reorder moved above /:id routes to avoid Hono route conflict */

  // ─── Comments ────────────────────────────────────────────

  /** GET /tasks/:taskId/comments — list comments */
  .get('/tasks/:taskId/comments', async (c) => {
    const taskId = parseInt(c.req.param('taskId'), 10);
    if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);

    const comments = await getDb().projects.getComments(taskId);
    const userMap = await getUserMap();

    const enriched = comments.map((cm) => ({
      ...cm,
      user_nickname: userMap.get(cm.user_id)?.nickname ?? cm.user_id,
    }));

    return c.json({ comments: enriched });
  })
  /** POST /tasks/:taskId/comments — add comment */
  .post('/tasks/:taskId/comments', async (c) => {
    const user = getAuthUser(c);
    const taskId = parseInt(c.req.param('taskId'), 10);
    if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);

    const body = (await c.req.json()) as { content: string };
    if (!body.content?.trim()) return c.json({ error: 'Content is required' }, 400);

    const comment = await getDb().projects.addComment({
      task_id: taskId,
      user_id: user.id,
      content: body.content.trim(),
    });

    return c.json({ comment }, 201);
  })
  /** DELETE /comments/:commentId — delete comment */
  .delete('/comments/:commentId', async (c) => {
    const commentId = parseInt(c.req.param('commentId'), 10);
    if (isNaN(commentId)) return c.json({ error: 'Invalid ID' }, 400);

    const deleted = await getDb().projects.deleteComment(commentId);
    if (!deleted) return c.json({ error: 'Comment not found' }, 404);

    return c.json({ success: true });
  })
  // ─── Activities ──────────────────────────────────────────

  /** GET /:id/activities — project activity log */
  .get('/:id/activities', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    if (isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);

    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const activities = await getDb().projects.getActivities(projectId, limit, offset);
    const userMap = await getUserMap();

    const enriched = activities.map((a) => ({
      ...a,
      user_nickname: userMap.get(a.user_id)?.nickname ?? a.user_id,
    }));

    return c.json({ activities: enriched });
  })
  // ─── Users list for assignment ───────────────────────────

  /** GET /meta/users — list internal users for task assignment */
  .get('/meta/users', async (c) => {
    const users = await getDb().users.list();
    return c.json({
      users: users.filter((u) => u.status === 'active').map((u) => ({ id: u.id, nickname: u.nickname, role: u.role })),
    });
  })
  // ─── Members ───────────────────────────────────────────────

  /** GET /:id/members — list project members */
  .get('/:id/members', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    if (isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);

    const [members, userMap] = await Promise.all([getDb().projects.getMembers(projectId), getUserMap()]);

    return c.json({
      members: members.map((m) => ({
        ...m,
        nickname: userMap.get(m.user_id)?.nickname ?? m.user_id,
      })),
    });
  })
  /** POST /:id/members — add member */
  .post('/:id/members', async (c) => {
    const user = getAuthUser(c);
    const projectId = parseInt(c.req.param('id'), 10);
    if (isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);

    const body = (await c.req.json()) as { user_id: string; role?: ProjectMemberRole };
    if (!body.user_id) return c.json({ error: 'user_id is required' }, 400);

    const member = await getDb().projects.addMember({
      project_id: projectId,
      user_id: body.user_id,
      role: body.role,
      added_by: user.id,
    });

    const userMap = await getUserMap();
    return c.json(
      {
        member: { ...member, nickname: userMap.get(member.user_id)?.nickname ?? member.user_id },
      },
      201,
    );
  })
  /** PATCH /:id/members/:userId — update member role */
  .patch('/:id/members/:userId', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const userId = c.req.param('userId');
    if (isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);

    const body = (await c.req.json()) as { role: ProjectMemberRole };
    if (!body.role) return c.json({ error: 'role is required' }, 400);

    const updated = await getDb().projects.updateMemberRole(projectId, userId, body.role);
    if (!updated) return c.json({ error: 'Member not found' }, 404);

    return c.json({ member: updated });
  })
  /** DELETE /:id/members/:userId — remove member */
  .delete('/:id/members/:userId', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const userId = c.req.param('userId');
    if (isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);

    const deleted = await getDb().projects.removeMember(projectId, userId);
    if (!deleted) return c.json({ error: 'Member not found' }, 404);

    return c.json({ success: true });
  });

export default projects;
