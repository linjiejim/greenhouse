/**
 * Project Manager tool — 对话式项目管理。
 *
 * 让 Agent 可以通过自然语言创建/查询/更新项目和任务。
 *
 * Actions:
 * - list_projects: 查询项目列表
 * - get_project: 获取项目详情+任务树
 * - create_project: 创建新项目
 * - update_project: 更新项目属性
 * - create_task: 创建任务
 * - update_task: 更新任务属性
 * - add_comment: 给任务添加评论
 * - query_tasks: 按条件查询任务
 * - project_summary: 生成项目进度报告
 */

import { tool } from 'ai';
import { toErrorMessage } from '@greenhouse/utils/error';
import { defineTool, type ToolMeta } from './define.js';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';

export interface ProjectManagerContext {
  userId: string;
  userRole: string;
}

const projectManagerSchema = z.object({
  action: z
    .enum([
      'list_projects',
      'get_project',
      'create_project',
      'update_project',
      'create_task',
      'update_task',
      'add_comment',
      'query_tasks',
      'project_summary',
    ])
    .describe('Action to perform'),

  // project params
  project_id: z.number().optional().describe('Project ID'),
  title: z.string().optional().describe('Title for project or task'),
  description: z.string().optional().describe('Description (Markdown)'),
  status: z
    .string()
    .optional()
    .describe(
      'Status (project: planning/active/on_hold/completed/archived; task: todo/in_progress/in_review/done/cancelled)',
    ),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Priority level'),
  owner_id: z.string().optional().describe('Project owner user ID'),
  start_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
  end_date: z.string().optional().describe('End date / due date (YYYY-MM-DD)'),

  // task params
  task_id: z.number().optional().describe('Task ID (for update_task / add_comment)'),
  parent_id: z.number().optional().describe('Parent task ID (for create_task)'),
  assignee_id: z.string().optional().describe('Assignee user ID'),
  due_date: z.string().optional().describe('Task due date (YYYY-MM-DD)'),
  estimated_hours: z.number().optional().describe('Estimated hours'),
  tags: z.array(z.string()).optional().describe('Task tags'),

  // comment params
  content: z.string().optional().describe('Comment content'),

  // query params
  search: z.string().optional().describe('Search keyword'),
  filter_status: z.string().optional().describe('Filter by status'),
  filter_assignee: z.string().optional().describe('Filter by assignee user ID'),
  limit: z.number().optional().describe('Max results (default: 20)'),
});

type ProjectManagerInput = z.infer<typeof projectManagerSchema>;

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'project_manager',
  name: 'Project Manager',
  brief: 'Create and manage projects & tasks',
  description: `Project and task management tool. Supports creating projects, adding tasks, assigning owners, tracking progress.
Operations: list_projects / get_project / create_project / create_task / update_task, etc.`,
  category: 'team',
  is_global: true,
  icon: 'FolderKanban',
  sort_order: 13,
};

export function createProjectManagerTool(db: DatabaseProvider, ctx: ProjectManagerContext) {
  return tool({
    description: meta.description,
    inputSchema: projectManagerSchema,
    execute: async (input: ProjectManagerInput) => {
      try {
        // Helper: get user nickname map
        const users = await db.users.list();
        const userMap = new Map(users.filter((u) => u.status === 'active').map((u) => [u.id, u.nickname]));
        const activeUsers = users.filter((u) => u.status === 'active').map((u) => ({ id: u.id, nickname: u.nickname }));

        switch (input.action) {
          case 'list_projects': {
            const projects = await db.projects.listProjects({
              status: input.filter_status as any,
              priority: input.priority,
              search: input.search,
              limit: input.limit ?? 20,
              userId: ctx.userId,
              userRole: ctx.userRole,
            });

            const enriched = await Promise.all(
              projects.map(async (p) => {
                const stats = await db.projects.getProjectStats(p.id);
                return {
                  id: p.id,
                  title: p.title,
                  status: p.status,
                  priority: p.priority,
                  owner: userMap.get(p.owner_id) ?? p.owner_id,
                  start_date: p.start_date,
                  end_date: p.end_date,
                  progress:
                    stats.total > 0
                      ? `${stats.done}/${stats.total} (${Math.round((stats.done / stats.total) * 100)}%)`
                      : '0 tasks',
                  stats,
                };
              }),
            );

            return { projects: enriched, total: enriched.length };
          }

          case 'get_project': {
            if (!input.project_id) return { error: 'project_id is required' };
            const project = await db.projects.getProjectById(input.project_id);
            if (!project) return { error: `Project #${input.project_id} not found` };

            // Visibility check
            if (project.visibility === 'private' && ctx.userRole !== 'super') {
              const isMember = await db.projects.isMember(input.project_id, ctx.userId);
              if (!isMember) return { error: `Project #${input.project_id} not found` };
            }

            const tasks = await db.projects.listTasks(input.project_id);
            const stats = await db.projects.getProjectStats(input.project_id);

            // Build tree
            const taskList = tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              assignee: userMap.get(t.assignee_id ?? '') ?? t.assignee_id ?? 'unassigned',
              parent_id: t.parent_id,
              due_date: t.due_date,
              start_date: t.start_date,
              estimated_hours: t.estimated_hours,
              tags: JSON.parse(t.tags || '[]'),
            }));

            return {
              project: {
                id: project.id,
                title: project.title,
                description: project.description,
                status: project.status,
                priority: project.priority,
                owner: userMap.get(project.owner_id) ?? project.owner_id,
                start_date: project.start_date,
                end_date: project.end_date,
              },
              tasks: taskList,
              stats,
              progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
            };
          }

          case 'create_project': {
            if (!input.title) return { error: 'title is required' };
            const project = await db.projects.createProject({
              title: input.title,
              description: input.description,
              status: (input.status as any) ?? 'planning',
              priority: input.priority,
              owner_id: input.owner_id || ctx.userId,
              start_date: input.start_date,
              end_date: input.end_date,
              created_by: ctx.userId,
            });
            return {
              success: true,
              message: `项目「${project.title}」创建成功`,
              project: { id: project.id, title: project.title, status: project.status },
            };
          }

          case 'update_project': {
            if (!input.project_id) return { error: 'project_id is required' };
            const updated = await db.projects.updateProject(
              input.project_id,
              {
                title: input.title,
                description: input.description,
                status: input.status as any,
                priority: input.priority,
                owner_id: input.owner_id,
                start_date: input.start_date,
                end_date: input.end_date,
              },
              ctx.userId,
            );
            if (!updated) return { error: `Project #${input.project_id} not found` };
            return {
              success: true,
              project: { id: updated.id, title: updated.title, status: updated.status, priority: updated.priority },
            };
          }

          case 'create_task': {
            if (!input.project_id) return { error: 'project_id is required' };
            if (!input.title) return { error: 'title is required' };

            const task = await db.projects.createTask({
              project_id: input.project_id,
              parent_id: input.parent_id,
              title: input.title,
              description: input.description,
              status: (input.status as any) ?? 'todo',
              priority: input.priority,
              assignee_id: input.assignee_id,
              start_date: input.start_date,
              due_date: input.due_date ?? input.end_date,
              estimated_hours: input.estimated_hours,
              tags: input.tags,
              created_by: ctx.userId,
            });
            return {
              success: true,
              message: `任务「${task.title}」创建成功`,
              task: {
                id: task.id,
                title: task.title,
                status: task.status,
                project_id: task.project_id,
                parent_id: task.parent_id,
              },
            };
          }

          case 'update_task': {
            if (!input.task_id) return { error: 'task_id is required' };
            const updated = await db.projects.updateTask(
              input.task_id,
              {
                title: input.title,
                description: input.description,
                status: input.status as any,
                priority: input.priority,
                assignee_id: input.assignee_id,
                start_date: input.start_date,
                due_date: input.due_date ?? input.end_date,
                estimated_hours: input.estimated_hours,
                tags: input.tags,
              },
              ctx.userId,
            );
            if (!updated) return { error: `Task #${input.task_id} not found` };
            return {
              success: true,
              task: {
                id: updated.id,
                title: updated.title,
                status: updated.status,
                priority: updated.priority,
                assignee: userMap.get(updated.assignee_id ?? '') ?? updated.assignee_id,
              },
            };
          }

          case 'add_comment': {
            if (!input.task_id) return { error: 'task_id is required' };
            if (!input.content) return { error: 'content is required' };
            const comment = await db.projects.addComment({
              task_id: input.task_id,
              user_id: ctx.userId,
              content: input.content,
            });
            return {
              success: true,
              comment: { id: comment.id, task_id: comment.task_id, created_at: comment.created_at },
            };
          }

          case 'query_tasks': {
            if (!input.project_id) return { error: 'project_id is required' };
            const tasks = await db.projects.listTasks(input.project_id, {
              status: input.filter_status as any,
              assignee_id: input.filter_assignee,
              limit: input.limit ?? 50,
            });

            const today = new Date().toISOString().split('T')[0];
            const enriched = tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              assignee: userMap.get(t.assignee_id ?? '') ?? t.assignee_id ?? 'unassigned',
              due_date: t.due_date,
              overdue: t.due_date && t.due_date < today && t.status !== 'done' && t.status !== 'cancelled',
              parent_id: t.parent_id,
            }));

            return { tasks: enriched, total: enriched.length, available_users: activeUsers };
          }

          case 'project_summary': {
            if (!input.project_id) return { error: 'project_id is required' };
            const project = await db.projects.getProjectById(input.project_id);
            if (!project) return { error: `Project #${input.project_id} not found` };

            const tasks = await db.projects.listTasks(input.project_id);
            const stats = await db.projects.getProjectStats(input.project_id);
            const activities = await db.projects.getActivities(input.project_id, 20);

            const today = new Date().toISOString().split('T')[0];
            const overdueTasks = tasks.filter(
              (t) => t.due_date && t.due_date < today && t.status !== 'done' && t.status !== 'cancelled',
            );

            // Group by assignee
            const byAssignee = new Map<string, { total: number; done: number }>();
            for (const t of tasks) {
              const name = userMap.get(t.assignee_id ?? '') ?? t.assignee_id ?? 'unassigned';
              const entry = byAssignee.get(name) ?? { total: 0, done: 0 };
              entry.total++;
              if (t.status === 'done') entry.done++;
              byAssignee.set(name, entry);
            }

            return {
              project: {
                title: project.title,
                status: project.status,
                start_date: project.start_date,
                end_date: project.end_date,
              },
              progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
              stats,
              overdue_tasks: overdueTasks.map((t) => ({
                id: t.id,
                title: t.title,
                due_date: t.due_date,
                assignee: userMap.get(t.assignee_id ?? '') ?? 'unassigned',
              })),
              by_assignee: Object.fromEntries(byAssignee),
              recent_activities: activities.slice(0, 10).map((a) => ({
                action: a.action,
                detail: a.detail,
                user: userMap.get(a.user_id) ?? a.user_id,
                time: a.created_at,
              })),
            };
          }

          default:
            return { error: `Unknown action: ${input.action}` };
        }
      } catch (err) {
        return { error: `Project manager error: ${toErrorMessage(err)}` };
      }
    },
  });
}

export const projectManagerTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'optional' },
  create: (ctx) => createProjectManagerTool(ctx.db, { userId: ctx.userId, userRole: ctx.userRole }),
});
