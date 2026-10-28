import { getPlatformRuntime, type ObjectRefSource } from '@greenhouse/api/extension-kit';
import { projectResource, taskReadAuthorizer } from './platform/application.js';
import { services } from './services.js';
export const projectObjectRef: ObjectRefSource['resolve'] = async (ref, r) => {
  const hidden = { title: null };
  const clip = (title: string) => (title.length > 200 ? `${title.slice(0, 199)}…` : title);
  switch (ref.type) {
    case 'project': {
      const result = await getPlatformRuntime().dispatch({
        actor: r.actor,
        appId: 'projects',
        actionId: 'getProject',
        payload: { projectId: ref.id },
        resource: projectResource('getProject', { projectId: ref.id }),
      });
      if (!result.ok) return hidden;
      const project = (result.data as { project?: { title?: unknown } }).project;
      return typeof project?.title === 'string' ? { title: clip(project.title) } : hidden;
    }
    case 'task': {
      if (!(await r.capability('projects.execution.read'))) return hidden;
      const task = await services(r.db).projects.getTaskById(ref.id);
      // The link names its project too; a task quoted under the wrong project is not this link.
      if (!task || task.project_id !== ref.projectId) return hidden;
      const context = { db: r.db };
      const readable = await taskReadAuthorizer(context, r.actor)(task);
      return readable ? { title: clip(task.title) } : hidden;
    }
    default:
      return hidden;
  }
};
