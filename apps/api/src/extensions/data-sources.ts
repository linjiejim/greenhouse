import { Hono } from 'hono';
import { tool } from 'ai';
import { z } from 'zod';
import { compileApp, type ApplicationDefinition } from '@greenhouse/platform-kernel';
import { createCrudRoutes, type ListResult, type ListParams } from '@greenhouse/crud/server';
import { getDb } from '@greenhouse/db';
import type { GreenhouseExtension } from './define.js';
import type { AppEnv } from '../app-env.js';
import { humanActor, delegatedAgentActor } from '../platform/actor.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import {
  dataActionId,
  dataListContract,
  executeDataOperation,
  runDataOperation,
  type DataOperation,
} from './data-runtime.js';
import type { DataRow, ExtensionDataSource } from './data-types.js';

/** Expand declarations into the same registries SDK 1 already uses. Never register globally here. */
export function deriveDataSources(input: GreenhouseExtension): GreenhouseExtension {
  if (!input.dataSources?.length) return input;
  const sources = input.dataSources.map((source) => ({
    ...source,
    featureFlag: source.featureFlag ?? input.featureFlags?.find((flag) => flag.key === input.id)?.key,
  }));
  const ext = { ...input, dataSources: sources };
  const append = (key: keyof GreenhouseExtension, values: unknown[]) => {
    (ext as Record<string, unknown>)[key] = [...((ext[key] as unknown[]) ?? []), ...values];
  };
  const entityIds = new Set<string>();
  const generatedToolIds = new Set((input.tools ?? []).map((tool) => tool.meta.id));
  const pages = [...(ext.surfaces?.pages ?? [])],
    nav = [...(ext.surfaces?.nav ?? [])];
  for (const source of sources) {
    for (const entityId of Object.keys(source.entities))
      if (!source.app.entities[entityId]) throw new Error(`Unknown data entity: ${entityId}`);
    const queryId = source.tools?.query?.id ?? `${ext.id}_query`,
      mutationId = source.tools?.mutation?.id ?? `${ext.id}_mutation`;
    const mcp = source.mcpGroup ?? ext.id;
    const actions: ApplicationDefinition['actions'] = {};
    const teamCapabilities: string[] = [],
      teamExportableEntities: string[] = [];
    const hasWrites = Object.values(source.entities).some(
      (e) => e.actions.create || e.actions.update || e.actions.delete,
    );
    for (const [entityId, entity] of Object.entries(source.app.entities)) {
      if (entityIds.has(entityId)) throw new Error(`Duplicate data entity: ${entityId}`);
      entityIds.add(entityId);
      const config = source.entities[entityId];
      if (!entity.fields.id) throw new Error(`Data entity ${entityId} requires an id field`);
      if (!config) throw new Error(`Missing data entity configuration: ${entityId}`);
      if (entity.module !== entityId) throw new Error(`Data entity ${entityId} must use its own module id`);
      for (const scope of entity.accessScopes) {
        if (!['all', 'own', 'collaborating'].includes(scope)) throw new Error(`Unsupported data scope: ${scope}`);
        if (scope === 'own' && (!config.ownerField || !entity.fields[config.ownerField]))
          throw new Error(`Data entity ${entityId} own scope needs ownerField`);
        if (scope === 'collaborating' && (!config.memberField || !entity.fields[config.memberField]))
          throw new Error(`Data entity ${entityId} collaborating scope needs memberField`);
      }
      for (const key of [config.peek.title, ...(config.peek.subtitle ? [config.peek.subtitle] : [])])
        if (!entity.fields[key]) throw new Error(`Unknown peek field: ${key}`);
      for (const [action, role] of Object.entries(config.actions)) {
        if (!['read', 'create', 'update', 'delete', 'export'].includes(action) || !['team', 'super'].includes(role))
          throw new Error(`Invalid data action: ${entityId}.${action}`);
        const capability = `${source.app.id}.${entityId}.${action}`;
        const read = action === 'read' || action === 'export';
        actions[dataActionId(entityId, action)] = {
          title: `${entity.title}: ${action}`,
          module: entity.module,
          entity: entityId,
          capability,
          kind: read ? 'query' : 'command',
          risk: read ? 'read' : action === 'delete' ? 'destructive' : 'low',
          audit: config.audit ?? 'writes',
          mcp: true,
        };
        if (role === 'team') teamCapabilities.push(capability);
        if (role === 'team' && action === 'export') teamExportableEntities.push(entityId);
      }
      const kind = `ext:${ext.id}:${entityId}` as const;
      if (!ext.entityKinds?.some((item) => item.kind === kind))
        append('entityKinds', [{ kind, route: `#/ext/${ext.id}/${entityId}/:id` }]);
      const endpoint = `/api/ext/${ext.id}/entities/${entityId}`;
      const rest = new Hono<AppEnv>();
      rest.onError((error, c) => {
        if ('status' in error && typeof error.status === 'number')
          return c.json({ error: error.message }, error.status as 400);
        if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
        throw error;
      });
      rest.use('*', async (c, next) => {
        const user = c.get('user');
        if (!user || !['super', 'team'].includes(user.role)) return c.json({ error: 'Forbidden' }, 403);
        await next();
      });
      rest.get('/:id/peek', async (c) => {
        const row = (await executeDataOperation(
          source,
          entityId,
          { action: 'get', id: c.req.param('id') },
          getDb(),
          humanActor(c.get('user')),
        )) as DataRow;
        return c.json({
          title: row[config.peek.title] ?? null,
          subtitle: config.peek.subtitle ? (row[config.peek.subtitle] ?? null) : null,
        });
      });
      rest.route(
        '/',
        createCrudRoutes(
          (c) => {
            const actor = humanActor(c.get('user')),
              db = getDb();
            const run = (operation: Parameters<typeof executeDataOperation>[2]) =>
              executeDataOperation(source, entityId, operation, db, actor);
            return {
              list: (params) => run({ action: 'list', params }) as Promise<ListResult<DataRow>>,
              get: (id) => run({ action: 'get', id }) as Promise<DataRow | null>,
              create: (data) => run({ action: 'create', data }) as Promise<DataRow>,
              update: (id, data) => run({ action: 'update', id, data }) as Promise<DataRow | null>,
              remove: (id) => run({ action: 'delete', id }) as Promise<boolean>,
            };
          },
          {
            ...dataListContract(entity),
            parseCreate: (raw) => z.record(z.string(), z.unknown()).parse(raw),
            parseUpdate: (raw) => z.record(z.string(), z.unknown()).parse(raw),
          },
        ),
      );
      append('routes', [{ path: endpoint, app: rest }]);
      if (Object.values(entity.fields).some((f) => f.searchable))
        append('searchSources', [
          {
            kind,
            search: async (ctx: import('../search/sources.js').SearchSourceContext) => {
              const result = (await executeDataOperation(
                source,
                entityId,
                { action: 'search', query: ctx.query, params: { limit: ctx.limit } },
                ctx.db,
                humanActor({ id: ctx.userId }),
              )) as ListResult<DataRow>;
              return result.items.map((row) => ({
                ref: { kind, id: row.id as string },
                title: String(row[config.peek.title] ?? row.id),
                ...(config.peek.subtitle ? { subtitle: String(row[config.peek.subtitle] ?? '') } : {}),
              }));
            },
          },
        ]);
      if (config.actions.export) {
        const type = `${ext.id}_${entityId}`;
        append('exportSources', [
          {
            type,
            schema: z.object({ type: z.literal(type) }),
            describe: `Export ${entity.title}`,
            load: async (_source: unknown, ctx: { userId: string }, db: import('@greenhouse/db').DatabaseProvider) => {
              const rows: DataRow[] = [];
              for (let skip = 0; ; skip += 1000) {
                const result = (await executeDataOperation(
                  source,
                  entityId,
                  { action: 'export', params: { skip, limit: 1000 } },
                  db,
                  delegatedAgentActor({ userId: ctx.userId }),
                )) as ListResult<DataRow>;
                rows.push(...result.items);
                if (!result.items.length || skip + result.items.length >= result.total) break;
              }
              const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
              return {
                rows,
                columns: keys.map((key) => ({ key, label: entity.fields[key].title })),
                defaultFilename: type,
                defaultSheetName: entity.title,
              };
            },
          },
        ]);
      }
      const pageId = `${ext.id}-${entityId}`;
      pages.push(
        {
          id: pageId,
          kind: 'entity-list',
          title: entity.title,
          entity: `${source.app.id}.${entityId}`,
          fallback_url: `#/ext/${ext.id}/${entityId}`,
        },
        {
          id: `${pageId}-detail`,
          kind: 'entity-detail',
          title: entity.title,
          entity: `${source.app.id}.${entityId}`,
          fallback_url: `#/ext/${ext.id}/${entityId}`,
        },
      );
      nav.push({ id: pageId, page: pageId, label: entity.title, icon: 'Database', placement: 'more' });
    }
    for (const toolId of [queryId, ...(hasWrites ? [mutationId] : [])]) {
      if (generatedToolIds.has(toolId))
        throw new Error(`Duplicate data tool: ${toolId}; choose distinct tool ids for each data source`);
      generatedToolIds.add(toolId);
    }
    const manifest = compileApp({ ...source.app, actions });
    append('applications', [
      {
        manifest,
        handlers: Object.fromEntries(
          Object.entries(actions).map(([id, action]) => [
            id,
            async (
              request: import('@greenhouse/platform-kernel').PlatformActionRequest,
              ctx: import('../platform/runtime.js').PlatformHandlerContext,
            ) => {
              if (ctx.operation) return ctx.operation();
              if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload))
                return { ok: false, code: 'INVALID_INPUT', message: 'Expected a data operation object' };
              const payload = request.payload as Partial<DataOperation>;
              const verb = action.capability.split('.').at(-1)!;
              const operation = verb === 'read' ? (payload.action ?? 'list') : verb;
              if (
                (verb === 'read' && !['list', 'get', 'search', 'aggregate'].includes(operation)) ||
                (verb !== 'read' && payload.action && payload.action !== verb)
              )
                return { ok: false, code: 'INVALID_INPUT', message: 'Operation does not match the registered action' };
              return runDataOperation(
                source,
                action.entity!,
                {
                  ...payload,
                  action: operation as DataOperation['action'],
                  id: payload.id === undefined ? request.resource?.recordId : String(payload.id),
                },
                ctx.db,
                request.actor,
              );
            },
          ]),
        ),
        teamCapabilities,
        teamExportableEntities,
        teamFieldPolicies: Object.fromEntries(
          Object.entries(source.app.entities).map(([id, entity]) => [
            id,
            Object.fromEntries(
              Object.entries(entity.fields).map(([key, field]) => [
                key,
                {
                  read:
                    field.classification === 'restricted'
                      ? 'none'
                      : field.classification === 'confidential'
                        ? 'masked'
                        : 'full',
                  write:
                    key !== 'id' &&
                    !['restricted', 'confidential'].includes(field.classification ?? '') &&
                    Boolean(
                      source.entities[id].actions.create === 'team' || source.entities[id].actions.update === 'team',
                    ),
                  export:
                    source.entities[id].actions.export === 'team' &&
                    !['restricted', 'confidential'].includes(field.classification ?? ''),
                },
              ]),
            ),
          ]),
        ),
        platformTools: { query: [queryId], command: hasWrites ? [mutationId] : [] },
      },
    ]);
    const toolIds = [queryId, ...(hasWrites ? [mutationId] : [])];
    append('featurePoints', [
      {
        key: source.app.id,
        title: source.app.title,
        description: source.app.description ?? source.app.title,
        icon: 'Database',
        kind: 'app',
        group: 'apps',
        appId: source.app.id,
        flag: source.featureFlag,
        capabilityPrefix: `${source.app.id}.*`,
        toolIds: [...(input.tools ?? []).map((t) => t.meta.id), ...toolIds],
      },
    ]);
    if (!(ext.mcpGroups ?? []).includes(mcp)) append('mcpGroups', [mcp]);
    append('tools', [
      makeDataTool(source, queryId, mcp, false),
      ...(hasWrites ? [makeDataTool(source, mutationId, mcp, true)] : []),
    ]);
    append('catalogSources', [
      {
        id: source.app.id,
        replaceDefaultSource: true,
        load: async (ctx: import('../hub-context/catalog.js').CatalogInput) => {
          if (!ctx.reachable.has(queryId)) return {};
          const entities = [];
          for (const [entityId, config] of Object.entries(source.entities)) {
            if (!config.actions.read) continue;
            try {
              const result = (await executeDataOperation(
                source,
                entityId,
                { action: 'aggregate', counts: ctx.counts, params: { limit: 1 } },
                ctx.db,
                ctx.actor,
              )) as { count: number | null };
              entities.push({
                id: `${source.app.id}.${entityId}`,
                name: source.app.entities[entityId].title,
                row_count: ctx.counts === false ? null : result.count,
              });
            } catch (error) {
              if (!(error instanceof Error && 'status' in error && error.status === 403)) throw error;
            }
          }
          const exports = [];
          for (const [entityId, config] of Object.entries(source.entities)) {
            if (
              config.actions.export &&
              entities.some((entity) => entity.id === `${source.app.id}.${entityId}`) &&
              (await getPlatformRuntime().authorize(ctx.actor, `${source.app.id}.${entityId}.export`)).allowed
            )
              exports.push({
                type: `${ext.id}_${entityId}`,
                describe: `Export ${source.app.entities[entityId].title}`,
              });
          }
          return {
            extensions: entities.length
              ? [
                  {
                    kind: 'extension',
                    id: ext.id,
                    name: ext.name,
                    description: ext.description ?? null,
                    record_kinds: entities.map((e) => `ext:${ext.id}:${e.id.split('.').pop()}`),
                    exports,
                    reach: [
                      {
                        tool: queryId,
                        access: 'read',
                        group: mcp,
                        how: 'Choose an entity and list, get, search or aggregate.',
                      },
                      ...(ctx.reachable.has(mutationId)
                        ? [
                            {
                              tool: mutationId,
                              access: 'write',
                              group: mcp,
                              how: 'Create, update or delete an entity record.',
                            },
                          ]
                        : []),
                    ],
                    entities,
                  },
                ]
              : [],
          };
        },
      },
    ]);
    append('activity', [
      {
        toolModules: { [mutationId]: ext.id },
        toolShapes: {
          [mutationId]: {
            create: { verb: 'create', entity: null },
            update: { verb: 'update', entity: null },
            delete: { verb: 'delete', entity: null },
          },
        },
        appModules: { [source.app.id]: ext.id },
        actionEntities: Object.fromEntries(Object.entries(actions).map(([id, action]) => [id, action.entity])),
        auditShapes: Object.fromEntries(
          Object.entries(actions)
            .filter(([, a]) => a.kind === 'command')
            .map(([id, a]) => [
              `${source.app.id}:${id}`,
              {
                entity: a.entity,
                verb: id.endsWith('Delete') ? 'delete' : id.endsWith('Create') ? 'create' : 'update',
              },
            ]),
        ),
      },
    ]);
  }
  ext.surfaces = { nav, pages };
  return ext;
}
function makeDataTool(
  source: ExtensionDataSource,
  id: string,
  mcp: string,
  mutation: boolean,
): import('../tools/define.js').ToolModule {
  const description = `${mutation ? 'Create, update or delete' : 'List, get, search or aggregate'} ${Object.entries(
    source.app.entities,
  )
    .map(([id, e]) => `${id} (${e.title})`)
    .join(', ')}. Use entity, filters, sort and limit; permissions and member scope apply.`;
  return {
    kind: 'lazy',
    meta: {
      id,
      name: source.app.title,
      brief: description,
      description,
      category: 'team',
      is_global: false,
      icon: 'Database',
      sort_order: 900,
      surface: { proxy: mutation ? 'write' : 'read', mcp, unattendedReplaySafe: !mutation },
    },
    createLazy: ({ db, userId }) =>
      tool({
        description,
        inputSchema: z.object({
          entity: z.string(),
          action: mutation
            ? z.enum(['create', 'update', 'delete'])
            : z.enum(['list', 'get', 'search', 'aggregate']).default('list'),
          id: z.union([z.string(), z.number()]).optional(),
          data: z.record(z.string(), z.unknown()).optional(),
          query: z.string().optional(),
          filters: z
            .array(
              z.object({
                key: z.string(),
                method: z.enum([
                  'eq',
                  'ne',
                  'like',
                  'ilike',
                  'in',
                  'nin',
                  'gt',
                  'gte',
                  'lt',
                  'lte',
                  'between',
                  'exists',
                ]),
                value: z.array(z.unknown()),
              }),
            )
            .optional(),
          sort: z.array(z.object({ key: z.string(), order: z.enum(['asc', 'desc']) })).optional(),
          limit: z.number().int().min(1).max(1000).optional(),
          skip: z.number().int().min(0).optional(),
        }),
        execute: async (input) => {
          try {
            return await executeDataOperation(
              source,
              input.entity,
              {
                action: input.action,
                id: input.id === undefined ? undefined : String(input.id),
                data: input.data,
                query: input.query,
                params: { filter: input.filters, sort: input.sort, limit: input.limit, skip: input.skip } as ListParams,
              },
              db,
              delegatedAgentActor({ userId }),
            );
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
  };
}
