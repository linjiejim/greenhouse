import { knowledgePrompt } from './prompt.js';
import { knowledgeTranscript } from './transcript.js';
import manifest from '../manifest.js';
import {
  defineExtension,
  extensionPath,
  requireInternal,
  getPlatformRuntime,
  delegatedAgentActor,
} from '@greenhouse/api/extension-kit';
import { createServices, services } from './services.js';
import routes from './routes.js';
import { knowledgeRegistration } from './platform/registration.js';
import { knowledgeQueryTool } from './tools/knowledge-query.js';
import { knowledgeMutationTool } from './tools/knowledge-mutation.js';
import { knowledgeDriveScope } from './drive.js';
import { knowledgeChanges } from './recent-changes.js';
import { knowledgeTarget, toolTarget } from './activity.js';
import { searchKnowledgeScopes } from './knowledge/search.js';
import { canRead, resolveKbAccess } from './knowledge/access.js';
import { documentSource } from './team-context.js';
import { startKnowledgeLiveUpdates } from './knowledge/live.js';
import { backfillKnowledgeTokens } from './knowledge/backfill.js';
import { dispatchKnowledgeOperation } from './platform/adapter.js';
import {
  listKnowledgeResources,
  readKnowledgeResource,
  KNOWLEDGE_RESOURCE_URI_TEMPLATE,
} from './platform/resources.js';
export { services } from './services.js';
export type { KnowledgeDoc } from './knowledge-base.js';
const template = {
  name: 'knowledge-document',
  title: 'Knowledge document',
  description: 'A team, personal, or explicitly shared knowledge document.',
  uriTemplate: KNOWLEDGE_RESOURCE_URI_TEMPLATE,
  mimeType: 'text/markdown',
};
let stopLive: (() => void) | undefined;
export default defineExtension({
  ...manifest,
  services: createServices,
  discriminators: {
    shareResources: ['kb_document'],
    fileLinkTargets: ['kb_document'],
    folderScopes: ['kb'],
    auditApps: ['knowledge'],
  },
  toolResults: [knowledgeTranscript],
  agentContext: { toolIds: ['knowledge_query'], promptFragment: () => knowledgePrompt },
  tools: [knowledgeQueryTool, knowledgeMutationTool],
  routes: [{ path: '/api/knowledge', app: routes, guards: [requireInternal()] }],
  applications: [
    {
      ...knowledgeRegistration,
      teamCapabilities: ['knowledge.*'],
      platformTools: { query: ['knowledge_query'], command: ['knowledge_mutation'] },
    },
  ],
  featurePoints: [
    {
      key: 'knowledge',
      title: 'Knowledge',
      description: 'Team and personal knowledge base, retrieval, and editing.',
      icon: 'BookOpen',
      kind: 'app',
      group: 'apps',
      appId: 'knowledge',
      capabilityPrefix: 'knowledge.*',
      toolIds: ['knowledge_query', 'knowledge_mutation'],
    },
  ],
  mcpGroups: ['knowledge'],
  entityKinds: [{ kind: 'kb_doc', route: '#/knowledge/doc/:id' }],
  driveScopes: [knowledgeDriveScope],
  teamContextSources: [documentSource],
  workspaceSettings: [
    {
      key: 'team_context.conventions',
      group: 'team_context',
      label: 'Team conventions',
      description: 'Published team documents selected as conventions',
      type: 'json',
      maxLength: 2000,
    },
    {
      key: 'team_context.glossary',
      group: 'team_context',
      label: 'Glossary',
      description: 'Published team document selected as glossary',
      type: 'string',
      maxLength: 200,
    },
  ],
  settingValueValidators: [
    (key, value) => {
      const valid = (s: unknown): s is string => typeof s === 'string' && /^[^\s/]{1,200}$/u.test(s.trim());
      if (key === 'team_context.conventions') {
        if (!Array.isArray(value) || value.some((id) => !valid(id)))
          return { ok: false, error: 'team_context.conventions must be a list of knowledge document ids' };
        const ids = [...new Set((value as string[]).map((id) => id.trim()))];
        return ids.length > 10
          ? { ok: false, error: 'team_context.conventions takes at most 10 documents' }
          : { ok: true, value: ids };
      }
      if (key === 'team_context.glossary')
        return valid(value)
          ? { ok: true, value: value.trim() }
          : { ok: false, error: 'team_context.glossary must be a knowledge document id' };
      return null;
    },
  ],
  mcpResources: [
    {
      toolIds: ['knowledge_query'],
      list: async (ctx) => {
        const result = await dispatchKnowledgeOperation(
          ctx.actor,
          'listDocuments',
          { transport: 'mcp-resource' },
          async () => ({ ok: true, data: await listKnowledgeResources(ctx.db, ctx.userId) }),
        );
        return result.ok ? result.data : [];
      },
      templates: async (ctx) => {
        const result = await dispatchKnowledgeOperation(
          ctx.actor,
          'listDocuments',
          { transport: 'mcp-resource-template' },
          async () => ({ ok: true, data: [template] }),
        );
        return result.ok ? result.data : [];
      },
      read: async (uri, ctx) => {
        const result = await dispatchKnowledgeOperation(
          ctx.actor,
          'readDocument',
          { uri, transport: 'mcp-resource' },
          async () => {
            const content = await readKnowledgeResource(ctx.db, ctx.userId, uri);
            return content
              ? { ok: true, data: content }
              : { ok: false, code: 'NOT_FOUND', message: 'Resource not found' };
          },
        );
        return result.ok ? result.data : undefined;
      },
    },
  ],
  searchSources: [
    {
      kind: 'kb_doc',
      search: async ({ db, userId, query, limit }) => {
        if (!(await getPlatformRuntime().authorize(delegatedAgentActor({ userId }), 'knowledge.library.read')).allowed)
          return [];
        return (await searchKnowledgeScopes(db, userId, query, 'all', limit)).map((hit) => ({
          ref: { kind: 'kb_doc' as const, id: hit.id, slug: hit.slug },
          title: hit.title,
          subtitle: hit.summary || undefined,
        }));
      },
    },
  ],
  objectRefs: [
    {
      type: 'doc',
      resolve: async (ref, r) => {
        if (ref.type !== 'doc' || !(await r.capability('knowledge.library.read'))) return { title: null };
        const doc =
          ref.slug !== undefined
            ? await services(r.db).knowledgeBase.get(ref.slug, 'shared')
            : await services(r.db).knowledgeBase.getById(ref.id);
        if (!doc || doc.status === 'archived' || !canRead(await resolveKbAccess(r.db, doc, r.user.id)))
          return { title: null };
        return {
          title: doc.title.length > 200 ? `${doc.title.slice(0, 199)}…` : doc.title,
          ...(ref.slug !== undefined ? { id: doc.id } : {}),
        };
      },
    },
  ],
  recentChanges: [{ id: 'knowledge', load: knowledgeChanges }],
  activity: [
    {
      toolModules: { knowledge_mutation: 'knowledge' },
      actionEntities: { knowledge: 'document' },
      toolWrites: { knowledge_mutation: { entity: 'document' } },
      targets: {
        document: async (ctx, row) =>
          row.app_id === 'knowledge' && row.record_id ? knowledgeTarget(ctx, row.record_id) : null,
      },
      auditShape: (row, summary) =>
        row.app_id === 'knowledge' && summary.change === 'reorder' ? { verb: 'move', entity: 'document' } : null,
      toolTargets: { knowledge_mutation: toolTarget },
      writeLabels: {
        knowledge_mutation: async (db, userId, input) => {
          const args = input as {
            doc_id?: unknown;
          };
          if (typeof args?.doc_id !== 'string') return null;
          const doc = await services(db).knowledgeBase.get(args.doc_id, 'shared');
          return doc && canRead(await resolveKbAccess(db, doc, userId)) ? doc.title : null;
        },
      },
      writeRisks: {
        knowledge_mutation: (input) => {
          const args = input as {
            action?: unknown;
            scope?: unknown;
          };
          return args?.action === 'knowledge.create_doc' && args.scope === 'personal' ? 'r1' : null;
        },
      },
    },
  ],
  automationTools: [{ id: 'knowledge_mutation', labelKey: 'ext.knowledge.automationTool', tier: 'write', order: 60 }],
  retiredToolAliases: { team_knowledge: ['knowledge_query'], personal_knowledge: ['knowledge_query'] },
  hubContext: [
    {
      group: 'knowledge',
      description: 'Knowledge base: team and personal documents',
      toolIds: ['knowledge_query', 'knowledge_mutation'],
    },
  ],
  resetTables: ['kb_versions', 'kb_documents'],
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  seeds: [{ dir: extensionPath(import.meta.url, '../seeds'), tables: ['kb_documents', 'kb_versions'] }],
  commands: ['knowledge', 'kb'].map((name) => ({
    name,
    usage: `${name} reindex | import <dir>`,
    run: async (args) => (await import('./cli.js')).run(args),
  })),
  onBoot: async ({ db }) => {
    stopLive = startKnowledgeLiveUpdates(db);
    await backfillKnowledgeTokens(db);
  },
  onShutdown: () => {
    stopLive?.();
    stopLive = undefined;
  },
});
