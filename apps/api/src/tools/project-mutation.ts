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
import { defineTool, type ToolMeta } from './define.js';
import { dispatchProjectAgentAction } from '../platform/projects/agent-adapter.js';

const projectMutationSchema = z.object({
  action: z
    .enum(['project.create', 'project.update', 'task.create', 'task.update', 'comment.add'])
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
  content: z.string().optional().describe('Comment content for comment.add.'),
});

type ProjectMutationInput = z.infer<typeof projectMutationSchema>;

export interface ProjectMutationContext {
  userId: string;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'project_mutation',
  name: 'Project Mutation',
  brief: 'Create/update projects and tasks with confirmation',
  description: `Controlled project/task mutation tool. Actions: project.create, project.update, task.create, task.update, comment.add (task_id + content).

A finished project is status=completed, an abandoned one is archived — deletion is deliberately absent. When closing or updating a task, record the conclusion (task.update description or comment.add) so query_tasks listings stay informative.

Every call requires explicit user confirmation via the cloud proxy (confirm:true) and is audited. Always read the project first with project_query, summarize the intended changes, and wait for user approval before calling. Project/task writes reuse the project repository and enforce project visibility/membership checks.`,
  category: 'team',
  is_global: true,
  surface: { proxy: 'write', mcp: 'projects' },
  icon: 'FolderPen',
  sort_order: 27,
};

export function createProjectMutationTool(ctx: ProjectMutationContext) {
  return tool({
    description: meta.description,
    inputSchema: projectMutationSchema,
    execute: async (input: ProjectMutationInput) => {
      try {
        if (input.action === 'project.create') {
          if (!input.title) return { action: input.action, error: 'title is required' };
          const result = await dispatchProjectAgentAction(ctx, 'createProject', {
            title: input.title,
            description: input.description,
            status:
              (input.status as 'planning' | 'active' | 'on_hold' | 'completed' | 'archived' | undefined) ?? 'planning',
            priority: input.priority,
            ownerId: input.owner_id || ctx.userId,
            visibility: input.visibility,
            startDate: input.start_date,
            endDate: input.end_date,
          });
          if (!result.ok) return { action: input.action, error: result.message };
          const project = result.data as { project: { id: number; title: string; status: string; owner_id: string } };
          return {
            action: input.action,
            status: 'created',
            project: {
              id: project.project.id,
              title: project.project.title,
              status: project.project.status,
              owner_id: project.project.owner_id,
            },
          };
        }

        if (input.action === 'project.update') {
          if (!input.project_id) return { action: input.action, error: 'project_id is required' };
          const result = await dispatchProjectAgentAction(
            ctx,
            'updateProject',
            {
              projectId: input.project_id,
              updates: {
                title: input.title,
                description: input.description,
                status: input.status as 'planning' | 'active' | 'on_hold' | 'completed' | 'archived' | undefined,
                priority: input.priority,
                owner_id: input.owner_id,
                visibility: input.visibility,
                start_date: input.start_date,
                end_date: input.end_date,
              },
            },
            { projectId: input.project_id },
          );
          if (!result.ok) return { action: input.action, error: result.message };
          const project = (
            result.data as {
              project: { id: number; title: string; status: string; priority: string };
            }
          ).project;
          return {
            action: input.action,
            status: 'updated',
            project: { id: project.id, title: project.title, status: project.status, priority: project.priority },
          };
        }

        if (input.action === 'task.create') {
          if (!input.project_id) return { action: input.action, error: 'project_id is required' };
          if (!input.title) return { action: input.action, error: 'title is required' };
          const result = await dispatchProjectAgentAction(
            ctx,
            'createTask',
            {
              projectId: input.project_id,
              parentId: input.parent_id,
              title: input.title,
              description: input.description,
              status:
                (input.status as 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | undefined) ?? 'todo',
              priority: input.priority,
              assigneeId: input.assignee_id,
              startDate: input.start_date,
              dueDate: input.due_date ?? input.end_date,
              estimatedHours: input.estimated_hours,
              tags: input.tags,
            },
            { projectId: input.project_id },
          );
          if (!result.ok) return { action: input.action, error: result.message };
          const task = (
            result.data as {
              task: { id: number; project_id: number; title: string; status: string };
            }
          ).task;
          return {
            action: input.action,
            status: 'created',
            task: { id: task.id, project_id: task.project_id, title: task.title, status: task.status },
          };
        }

        if (input.action === 'comment.add') {
          if (!input.task_id) return { action: input.action, error: 'task_id is required' };
          if (!input.content) return { action: input.action, error: 'content is required' };
          const result = await dispatchProjectAgentAction(
            ctx,
            'addComment',
            { taskId: input.task_id, content: input.content },
            { taskId: input.task_id },
          );
          if (!result.ok) return { action: input.action, error: result.message };
          const comment = (
            result.data as {
              comment: { id: number; task_id: number; created_at: string };
            }
          ).comment;
          return {
            action: input.action,
            status: 'created',
            comment: { id: comment.id, task_id: comment.task_id, created_at: comment.created_at },
          };
        }

        if (!input.task_id) return { action: input.action, error: 'task_id is required' };
        const result = await dispatchProjectAgentAction(
          ctx,
          'updateTask',
          {
            taskId: input.task_id,
            updates: {
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
          },
          { taskId: input.task_id },
        );
        if (!result.ok) return { action: input.action, error: result.message };
        const task = (
          result.data as {
            task: { id: number; project_id: number; title: string; status: string };
          }
        ).task;
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
