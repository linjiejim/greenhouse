/**
 * `project_mutation` hands back the in-app link of what it wrote, so the reply can
 * cite it verbatim and clients show an object chip that opens it (a task written
 * in chat opens its task sheet on the phone). The platform dispatch is stubbed:
 * what it guards has its own coverage in projects-platform.db.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseObjectUrl } from '@greenhouse/types/object-refs';

vi.mock('../../platform/projects/agent-adapter.js', () => ({
  dispatchProjectAgentAction: async (_ctx: unknown, action: string, payload: Record<string, unknown>) => {
    if (action === 'createTask' || action === 'updateTask') {
      return {
        ok: true,
        data: {
          task: {
            id: 'tsk_01JABCDEFGHJKMNPQRSTVWXYZ0',
            project_id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0',
            title: payload.title ?? 'T',
            status: 'todo',
          },
        },
      };
    }
    return {
      ok: true,
      data: {
        project: {
          id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0',
          title: 'P',
          status: 'planning',
          owner_id: 'u1',
          priority: 'normal',
        },
      },
    };
  },
}));

const { createProjectMutationTool, projectMutationTool } = await import('../project-mutation.js');

const opts = { toolCallId: 't', messages: [] } as never;

describe('project_mutation links', () => {
  it('returns a task link that parses as that task', async () => {
    const tool = createProjectMutationTool({ userId: 'u1' });
    const created = (await tool.execute!(
      { action: 'task.create', project_id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0', title: 'Ship' },
      opts,
    )) as {
      task: { url: string };
    };
    expect(created.task.url).toBe('#/projects/prj_01JABCDEFGHJKMNPQRSTVWXYZ0?task=tsk_01JABCDEFGHJKMNPQRSTVWXYZ0');
    expect(parseObjectUrl(created.task.url)).toEqual({
      type: 'task',
      id: 'tsk_01JABCDEFGHJKMNPQRSTVWXYZ0',
      projectId: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0',
    });

    const updated = (await tool.execute!(
      { action: 'task.update', task_id: 'tsk_01JABCDEFGHJKMNPQRSTVWXYZ0', status: 'done' },
      opts,
    )) as {
      task: { url: string };
    };
    expect(updated.task.url).toBe(created.task.url);
  });

  it('returns a project link', async () => {
    const tool = createProjectMutationTool({ userId: 'u1' });
    const created = (await tool.execute!({ action: 'project.create', title: 'P' }, opts)) as {
      project: { url: string };
    };
    expect(parseObjectUrl(created.project.url)).toEqual({ type: 'project', id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0' });
  });

  it('tells the model to cite the link verbatim', () => {
    expect(projectMutationTool.meta.description).toContain('verbatim');
  });
});
