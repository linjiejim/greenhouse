/**
 * Project Query tool — read-only project/task access for cloud tool proxy.
 *
 * This splits safe project reads from the mixed read/write project_manager tool
 * so Desktop Local Agent can use project data without exposing mutations.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';

const projectQuerySchema = z.object({
  action: z.enum(['list', 'get', 'tasks', 'query_tasks', 'summary']).describe('Read-only project query action.'),
  project_id: z.number().optional().describe('Project ID for get/tasks/summary.'),
  task_id: z.number().optional().describe('Task ID for querying one task when supported.'),
  search: z.string().optional().describe('Search keyword.'),
  status: z.string().optional().describe('Project/task status filter.'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignee_id: z.string().optional().describe('Task assignee filter.'),
  limit: z.number().min(1).max(100).optional().describe('Max results, default 20.'),
});

type ProjectQueryInput = z.infer<typeof projectQuerySchema>;

export interface ProjectQueryContext {
  userId: string;
  userRole: string;
}

function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'project_query',
  name: 'Project Query',
  brief: 'Read projects and tasks',
  description: `Read-only project and task query tool. Actions: list, get, tasks, query_tasks, summary. Respects project visibility and membership rules; private projects are only returned to members or super users.`,
  category: 'team',
  is_global: true,
  icon: 'FolderKanban',
  sort_order: 26,
  surface: { proxy: 'read', mcp: true },
};

export function createProjectQueryTool(db: DatabaseProvider, ctx: ProjectQueryContext) {
  return tool({
    description: meta.description,
    inputSchema: projectQuerySchema,
    execute: async (input: ProjectQueryInput) => {
      const users = await db.users.list();
      const userMap = new Map(users.filter((u) => u.status === 'active').map((u) => [u.id, u.nickname]));

      if (input.action === 'list') {
        const projects = await db.projects.listProjects({
          status: input.status as any,
          priority: input.priority,
          search: input.search,
          limit: input.limit ?? 20,
          userId: ctx.userId,
          userRole: ctx.userRole,
        });
        const rows = await Promise.all(
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
              stats,
              progress_percent: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
            };
          }),
        );
        return { action: input.action, total: rows.length, projects: rows };
      }

      if (input.action === 'get' || input.action === 'tasks' || input.action === 'summary') {
        if (!input.project_id) return { action: input.action, error: 'project_id is required' };
        const project = await db.projects.getProjectById(input.project_id);
        if (!project) return { action: input.action, error: `Project #${input.project_id} not found` };
        if (project.visibility === 'private' && ctx.userRole !== 'super') {
          const isMember = await db.projects.isMember(input.project_id, ctx.userId);
          if (!isMember) return { action: input.action, error: `Project #${input.project_id} not found` };
        }
        const tasks = await db.projects.listTasks(input.project_id);
        const stats = await db.projects.getProjectStats(input.project_id);
        const mappedTasks = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          assignee: userMap.get(t.assignee_id ?? '') ?? t.assignee_id ?? 'unassigned',
          parent_id: t.parent_id,
          start_date: t.start_date,
          due_date: t.due_date,
          estimated_hours: t.estimated_hours,
          tags: parseTags(t.tags),
        }));
        return {
          action: input.action,
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
          stats,
          progress_percent: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
          tasks: mappedTasks,
        };
      }

      if (input.action === 'query_tasks') {
        if (!input.project_id) return { action: input.action, error: 'project_id is required' };
        const project = await db.projects.getProjectById(input.project_id);
        if (!project) return { action: input.action, error: `Project #${input.project_id} not found` };
        if (project.visibility === 'private' && ctx.userRole !== 'super') {
          const isMember = await db.projects.isMember(input.project_id, ctx.userId);
          if (!isMember) return { action: input.action, error: `Project #${input.project_id} not found` };
        }
        const tasks = await db.projects.listTasks(input.project_id, {
          status: input.status as any,
          assignee_id: input.assignee_id,
          limit: input.limit ?? 20,
        });
        const filtered = input.search
          ? tasks.filter((t) => t.title.toLowerCase().includes(input.search!.toLowerCase()))
          : tasks;
        return {
          action: input.action,
          total: filtered.length,
          tasks: filtered.map((t) => ({
            id: t.id,
            project_id: t.project_id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            assignee: userMap.get(t.assignee_id ?? '') ?? t.assignee_id ?? 'unassigned',
            due_date: t.due_date,
            tags: parseTags(t.tags),
          })),
        };
      }

      return { error: `Unknown action: ${input.action}` };
    },
  });
}

export const projectQueryTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'internal' },
  create: (ctx) => createProjectQueryTool(ctx.db, { userId: ctx.userId, userRole: ctx.userRole }),
});
