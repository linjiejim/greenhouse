import { auditTarget, toolTarget } from './activity.js';
import { projectChanges } from './recent-changes.js';
import { projectObjectRef } from './object-refs.js';
import manifest from '../manifest.js';
import {
  defineExtension,
  extensionPath,
  requireInternal,
  getPlatformRuntime,
  delegatedAgentActor,
} from '@greenhouse/api/extension-kit';
import { createServices } from './services.js';
import routes from './routes.js';
import { projectsRegistration } from './platform/application.js';
import { projectQueryTool } from './tools/project-query.js';
import { projectMutationTool } from './tools/project-mutation.js';

export default defineExtension({
  ...manifest,
  discriminators: { fileLinkTargets: ['task'] },
  services: createServices,
  activity: [
    {
      auditCapabilities: ['projects.activity'],
      toolModules: { project_mutation: 'projects' },
      actionEntities: { project: 'project', task: 'task', comment: 'task' },
      auditShapes: { 'projects:addComment': { verb: 'comment', entity: 'task' } },
      toolShapes: { project_mutation: { 'comment.add': { verb: 'comment', entity: 'task' } } },
      targets: { project: auditTarget, task: auditTarget, comment: auditTarget },
      toolTargets: { project_mutation: toolTarget },
    },
  ],
  recentChanges: [{ id: 'projects', load: projectChanges }],
  objectRefs: [
    { type: 'project', resolve: projectObjectRef },
    { type: 'task', resolve: projectObjectRef },
  ],
  resetTables: ['task_comments', 'tasks', 'project_members', 'projects'],
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  seeds: [
    {
      dir: extensionPath(import.meta.url, '../seeds'),
      tables: ['projects', 'project_members', 'tasks', 'task_comments', 'audit_events'],
    },
  ],
  tools: [projectQueryTool, projectMutationTool],
  routes: [{ path: '/api/projects', app: routes, guards: [requireInternal()] }],
  applications: [
    {
      ...projectsRegistration,
      teamCapabilities: ['projects.*'],
      platformTools: { query: ['project_query'], command: ['project_mutation'] },
    },
  ],
  featurePoints: [
    {
      key: 'projects',
      title: 'Projects',
      description: 'Project and task management.',
      icon: 'ClipboardList',
      kind: 'app',
      group: 'apps',
      appId: 'projects',
      capabilityPrefix: 'projects.*',
      toolIds: ['project_query', 'project_mutation'],
    },
  ],
  mcpGroups: ['projects'],
  entityKinds: [{ kind: 'project', route: '#/projects/:id' }],
  automationTools: [{ id: 'project_mutation', labelKey: 'ext.projects.automationTool', tier: 'write', order: 70 }],
  hubContext: [
    { group: 'projects', description: 'Projects and their tasks', toolIds: ['project_query', 'project_mutation'] },
  ],
  searchSources: [
    {
      kind: 'project',
      search: async ({ query, limit, userId }) => {
        const result = await getPlatformRuntime().dispatch({
          actor: delegatedAgentActor({ userId }),
          appId: 'projects',
          actionId: 'listProjects',
          payload: { search: query, limit },
        });
        if (!result.ok) return [];
        return (
          result.data as { projects: Array<{ id: string; title: string; status: string; priority: string }> }
        ).projects.map((row) => ({
          ref: { kind: 'project' as const, id: row.id },
          title: row.title,
          subtitle: [row.status, row.priority].filter(Boolean).join(' · ') || undefined,
        }));
      },
    },
  ],
});
