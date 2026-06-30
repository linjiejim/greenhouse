/**
 * Project Mutation tool — bounded project/task writes for the cloud proxy.
 *
 * This separates write operations from project_query and only exposes small,
 * auditable mutations. The /api/agent proxy requires confirm:true before this
 * tool can execute.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';

const projectMutationSchema = z.object({
  action: z
    .enum(['project.create', 'project.update', 'task.create', 'task.update'])
    .describe('Bounded mutation action.'),
  project_id: z.number().optional().describe('Project id for project.update/task.create.'),
  task_id: z.number().optional().describe('Task id for task.update.'),
  title: z.string().optional().describe('Project/task title.'),
  description: z.string().optional().describe('Markdown description.'),
  status: z
    .enum([
      'planning',
      'active',
      'on_hold',
      'completed',
      'archived',
      'todo',
      'in_progress',
      'in_review',
      'done',
      'cancelled',
    ])
    .optional()
    .describe('Project or task status.'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  owner_id: z.string().optional().describe('Project owner user id.'),
  visibility: z.enum(['public', 'private']).optional().describe('Project visibility.'),
  parent_id: z.number().optional().describe('Parent task id for subtasks.'),
  assignee_id: z.string().optional().describe('Task assignee user id.'),
  start_date: z.string().optional().describe('YYYY-MM-DD.'),
  end_date: z.string().optional().describe('Project end date or task due date, YYYY-MM-DD.'),
  due_date: z.string().optional().describe('Task due date, YYYY-MM-DD.'),
  estimated_hours: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

type ProjectMutationInput = z.infer<typeof projectMutationSchema>;

export interface ProjectMutationContext {
  userId: string;
  userRole: string;
}

async function assertProjectWritable(db: DatabaseProvider, projectId: number, ctx: ProjectMutationContext) {
  const project = await db.projects.getProjectById(projectId);
  if (!project) return { error: `Project #${projectId} not found` } as const;
  if (ctx.userRole === 'super') return { project } as const;
  if (project.owner_id === ctx.userId || project.created_by === ctx.userId) return { project } as const;
  const isMember = await db.projects.isMember(projectId, ctx.userId);
  if (!isMember) return { error: `Project #${projectId} not found` } as const;
  return { project } as const;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'project_mutation',
  name: 'Project Mutation',
  brief: 'Create/update projects and tasks with confirmation',
  description: `Controlled project/task mutation tool. Actions: project.create, project.update, task.create, task.update.

Every call requires explicit user confirmation via the cloud proxy (confirm:true) and is audited. Always read the project first with project_query, summarize the intended changes, and wait for user approval before calling. Project/task writes reuse the project repository and enforce project visibility/membership checks.`,
  category: 'team',
  is_global: true,
  icon: 'FolderPen',
  sort_order: 27,
  surface: { proxy: 'write', mcp: true },
};

export function createProjectMutationTool(db: DatabaseProvider, ctx: ProjectMutationContext) {
  return tool({
    description: meta.description,
    inputSchema: projectMutationSchema,
    execute: async (input: ProjectMutationInput) => {
      try {
        if (input.action === 'project.create') {
          if (!input.title) return { action: input.action, error: 'title is required' };
          const project = await db.projects.createProject({
            title: input.title,
            description: input.description,
            status:
              (input.status as 'planning' | 'active' | 'on_hold' | 'completed' | 'archived' | undefined) ?? 'planning',
            priority: input.priority,
            owner_id: input.owner_id || ctx.userId,
            visibility: input.visibility,
            start_date: input.start_date,
            end_date: input.end_date,
            created_by: ctx.userId,
          });
          return {
            action: input.action,
            status: 'created',
            project: { id: project.id, title: project.title, status: project.status, owner_id: project.owner_id },
          };
        }

        if (input.action === 'project.update') {
          if (!input.project_id) return { action: input.action, error: 'project_id is required' };
          const writable = await assertProjectWritable(db, input.project_id, ctx);
          if ('error' in writable) return { action: input.action, error: writable.error };
          const project = await db.projects.updateProject(
            input.project_id,
            {
              title: input.title,
              description: input.description,
              status: input.status as 'planning' | 'active' | 'on_hold' | 'completed' | 'archived' | undefined,
              priority: input.priority,
              owner_id: input.owner_id,
              visibility: input.visibility,
              start_date: input.start_date,
              end_date: input.end_date,
            },
            ctx.userId,
          );
          if (!project) return { action: input.action, error: `Project #${input.project_id} not found` };
          return {
            action: input.action,
            status: 'updated',
            project: { id: project.id, title: project.title, status: project.status, priority: project.priority },
          };
        }

        if (input.action === 'task.create') {
          if (!input.project_id) return { action: input.action, error: 'project_id is required' };
          if (!input.title) return { action: input.action, error: 'title is required' };
          const writable = await assertProjectWritable(db, input.project_id, ctx);
          if ('error' in writable) return { action: input.action, error: writable.error };
          const task = await db.projects.createTask({
            project_id: input.project_id,
            parent_id: input.parent_id,
            title: input.title,
            description: input.description,
            status: (input.status as 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | undefined) ?? 'todo',
            priority: input.priority,
            assignee_id: input.assignee_id,
            start_date: input.start_date,
            due_date: input.due_date ?? input.end_date,
            estimated_hours: input.estimated_hours,
            tags: input.tags,
            created_by: ctx.userId,
          });
          return {
            action: input.action,
            status: 'created',
            task: { id: task.id, project_id: task.project_id, title: task.title, status: task.status },
          };
        }

        if (!input.task_id) return { action: input.action, error: 'task_id is required' };
        const existing = await db.projects.getTaskById(input.task_id);
        if (!existing) return { action: input.action, error: `Task #${input.task_id} not found` };
        const writable = await assertProjectWritable(db, existing.project_id, ctx);
        if ('error' in writable) return { action: input.action, error: writable.error };
        const task = await db.projects.updateTask(
          input.task_id,
          {
            title: input.title,
            description: input.description,
            status: input.status as 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | undefined,
            priority: input.priority,
            assignee_id: input.assignee_id,
            parent_id: input.parent_id,
            start_date: input.start_date,
            due_date: input.due_date ?? input.end_date,
            estimated_hours: input.estimated_hours,
            tags: input.tags,
          },
          ctx.userId,
        );
        if (!task) return { action: input.action, error: `Task #${input.task_id} not found` };
        return {
          action: input.action,
          status: 'updated',
          task: { id: task.id, project_id: task.project_id, title: task.title, status: task.status },
        };
      } catch (err) {
        return { action: input.action, error: toErrorMessage(err) };
      }
    },
  });
}

export const projectMutationTool = defineTool({ meta, kind: 'lazy' });
