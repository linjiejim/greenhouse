/**
 * Project Query tool — read-only project/task access on every channel
 * (chat / proxy / MCP / workbench). Writes live in project_mutation.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { entityUrl } from '@greenhouse/types/entity-links';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { CITE_URL_INSTRUCTION } from './cite-url.js';
import { dispatchProjectAgentAction } from '../platform/projects/agent-adapter.js';

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
  description: `Read-only project and task query tool. Actions: list, get, tasks, query_tasks (returns available_users for assignment), summary (progress report: overdue tasks, per-assignee breakdown, recent activity). Respects project visibility and membership rules; private projects are only returned to members or super users. ${CITE_URL_INSTRUCTION}`,
  category: 'team',
  is_global: true,
  surface: { proxy: 'read', mcp: 'projects', workbench: true, unattendedReplaySafe: true },
  icon: 'FolderKanban',
  sort_order: 26,
};

export function createProjectQueryTool(db: DatabaseProvider, ctx: ProjectQueryContext) {
  return tool({
    description: meta.description,
    inputSchema: projectQuerySchema,
    execute: async (input: ProjectQueryInput) => {
      const users = await db.users.list();
      const userMap = new Map(users.filter((u) => u.status === 'active').map((u) => [u.id, u.nickname]));

      if (input.action === 'list') {
        const result = await dispatchProjectAgentAction(ctx, 'listProjects', {
          status: input.status as any,
          priority: input.priority,
          search: input.search,
          limit: input.limit ?? 20,
        });
        if (!result.ok) return { action: input.action, error: result.message };
        const projects = (
          result.data as {
            projects: Awaited<ReturnType<DatabaseProvider['projects']['listProjects']>>;
          }
        ).projects;
        const rows = await Promise.all(
          projects.map(async (p) => {
            const stats = await db.projects.getProjectStats(p.id);
            return {
              id: p.id,
              url: entityUrl({ kind: 'project', id: p.id }),
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

      if (input.action === 'summary') {
        // Progress report — ported from the retired project_manager's project_summary:
        // overdue radar, per-assignee load, and the recent activity trail.
        if (!input.project_id) return { action: input.action, error: 'project_id is required' };
        const [projectResult, tasksResult, activitiesResult, stats] = await Promise.all([
          dispatchProjectAgentAction(
            ctx,
            'getProject',
            { projectId: input.project_id },
            { projectId: input.project_id },
          ),
          dispatchProjectAgentAction(
            ctx,
            'listTasks',
            { projectId: input.project_id, limit: 500 },
            { projectId: input.project_id },
          ),
          dispatchProjectAgentAction(
            ctx,
            'listActivities',
            { projectId: input.project_id, limit: 20 },
            { projectId: input.project_id },
          ),
          db.projects.getProjectStats(input.project_id),
        ]);
        if (!projectResult.ok) return { action: input.action, error: projectResult.message };
        if (!tasksResult.ok) return { action: input.action, error: tasksResult.message };
        if (!activitiesResult.ok) return { action: input.action, error: activitiesResult.message };
        const project = (
          projectResult.data as {
            project: NonNullable<Awaited<ReturnType<DatabaseProvider['projects']['getProjectById']>>>;
          }
        ).project;
        const tasks = (
          tasksResult.data as {
            tasks: Awaited<ReturnType<DatabaseProvider['projects']['listTasks']>>;
          }
        ).tasks;
        const activities = (
          activitiesResult.data as {
            activities: Awaited<ReturnType<DatabaseProvider['projects']['getActivities']>>;
          }
        ).activities;

        const today = new Date().toISOString().split('T')[0]!;
        const overdueTasks = tasks.filter(
          (t) => t.due_date && t.due_date < today && t.status !== 'done' && t.status !== 'cancelled',
        );
        const byAssignee = new Map<string, { total: number; done: number }>();
        for (const t of tasks) {
          const name = userMap.get(t.assignee_id ?? '') ?? t.assignee_id ?? 'unassigned';
          const entry = byAssignee.get(name) ?? { total: 0, done: 0 };
          entry.total++;
          if (t.status === 'done') entry.done++;
          byAssignee.set(name, entry);
        }

        return {
          action: input.action,
          project: {
            id: project.id,
            url: entityUrl({ kind: 'project', id: project.id }),
            title: project.title,
            status: project.status,
            start_date: project.start_date,
            end_date: project.end_date,
          },
          progress_percent: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
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

      if (input.action === 'get' || input.action === 'tasks') {
        if (!input.project_id) return { action: input.action, error: 'project_id is required' };
        const [projectResult, tasksResult] = await Promise.all([
          dispatchProjectAgentAction(
            ctx,
            'getProject',
            { projectId: input.project_id },
            { projectId: input.project_id },
          ),
          dispatchProjectAgentAction(
            ctx,
            'listTasks',
            { projectId: input.project_id, limit: 500 },
            { projectId: input.project_id },
          ),
        ]);
        if (!projectResult.ok) return { action: input.action, error: projectResult.message };
        if (!tasksResult.ok) return { action: input.action, error: tasksResult.message };
        const project = (
          projectResult.data as {
            project: NonNullable<Awaited<ReturnType<DatabaseProvider['projects']['getProjectById']>>>;
          }
        ).project;
        const tasks = (
          tasksResult.data as {
            tasks: Awaited<ReturnType<DatabaseProvider['projects']['listTasks']>>;
          }
        ).tasks;
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
            url: entityUrl({ kind: 'project', id: project.id }),
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
        const activeUsers = users
          .filter((u) => u.status === 'active' && (u.role === 'team' || u.role === 'super'))
          .map((u) => ({ id: u.id, nickname: u.nickname }));
        const result = await dispatchProjectAgentAction(
          ctx,
          'listTasks',
          {
            projectId: input.project_id,
            status: input.status,
            assigneeId: input.assignee_id,
            limit: input.limit ?? 20,
          },
          { projectId: input.project_id },
        );
        if (!result.ok) return { action: input.action, error: result.message };
        const tasks = (
          result.data as {
            tasks: Awaited<ReturnType<DatabaseProvider['projects']['listTasks']>>;
          }
        ).tasks;
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
          available_users: activeUsers,
        };
      }

      return { error: `Unknown action: ${input.action}` };
    },
  });
}

export const projectQueryTool = defineTool({ meta, kind: 'lazy' });
