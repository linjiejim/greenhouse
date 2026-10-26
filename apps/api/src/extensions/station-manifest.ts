import type { DatabaseProvider } from '@greenhouse/db';
import {
  CLIENT_API_LEVEL,
  STATION_MANIFEST_VERSION,
  type PluginManifestEntry,
  type PluginEntitySchema,
  type EntityAction,
  type StationManifest,
} from '@greenhouse/types/plugins';
import { fieldPolicyFor } from '@greenhouse/platform-kernel';
import type { AuthUser } from '../auth/token.js';
import { userHasFeature } from '../auth/features.js';
import { buildUserAccessView } from '../platform/feature-points.js';
import { humanActor } from '../platform/actor.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import { dataContext, dataActionId } from './data-runtime.js';
import { EXTENSIONS } from './index.js';
import { runningAppVersion } from './compat.js';
import type { GreenhouseExtension } from './define.js';

export async function stationManifest(
  db: DatabaseProvider,
  user: AuthUser,
  extensions: readonly GreenhouseExtension[] = EXTENSIONS,
): Promise<StationManifest> {
  const access = await buildUserAccessView(db, (await db.users.getById(user.id))!);
  const actor = humanActor(user),
    runtime = getPlatformRuntime();
  const plugins: PluginManifestEntry[] = [];
  for (const ext of extensions) {
    const points = (ext.featurePoints ?? [])
      .map((p) => access.featurePoints.find((a) => a.key === p.key))
      .filter(Boolean);
    const flags = ext.featureFlags ?? [];
    const flagStates = await Promise.all(flags.map((f) => userHasFeature(user.id, user.role, f.key, db)));
    if (
      points.length &&
      !points.some((p) => p!.enabled && (p!.kind !== 'app' || p!.capabilities?.some((c) => c.allowed)))
    )
      continue;
    if (flags.length && !flagStates.some(Boolean)) continue;
    const entities: PluginEntitySchema[] = [];
    for (const source of ext.dataSources ?? []) {
      for (const [id, config] of Object.entries(source.entities)) {
        const definition = source.app.entities[id];
        const allowed: EntityAction[] = [];
        for (const action of Object.keys(config.actions) as EntityAction[]) {
          const manifest = runtime.getManifest(source.app.id);
          if (
            manifest &&
            (await runtime.authorize(actor, manifest.actions[dataActionId(id, action)].capability)).allowed
          )
            allowed.push(action);
        }
        if (!allowed.includes('read')) continue;
        const ctx = await dataContext(db, actor, source, id);
        if (!ctx.policy.scopes.length) continue;
        const fields = Object.entries(definition.fields)
          .filter(([key]) => fieldPolicyFor(ctx.policy, key).read !== 'none')
          .map(([key, field]) => ({
            key,
            title: field.title,
            kind:
              field.kind === 'decimal'
                ? ('number' as const)
                : field.kind === 'users' || field.kind === 'relations'
                  ? ('json' as const)
                  : field.kind,
            required: field.required,
            values: field.values ? [...field.values] : undefined,
            target: field.target ? `${source.app.id}.${field.target}` : undefined,
            searchable: fieldPolicyFor(ctx.policy, key).read === 'full' && field.searchable,
            sortable: fieldPolicyFor(ctx.policy, key).read === 'full' && field.sortable,
            filterable: fieldPolicyFor(ctx.policy, key).read === 'full' && field.filterable,
            writable:
              key !== 'id' &&
              fieldPolicyFor(ctx.policy, key).write &&
              (allowed.includes('create') || allowed.includes('update')),
          }));
        const visible = new Set(fields.map((f) => f.key));
        entities.push({
          id: `${source.app.id}.${id}`,
          title: definition.title,
          title_field: config.peek.title,
          subtitle_field: config.peek.subtitle,
          fields,
          views: (config.views ?? [{ id: 'default', columns: [...visible] }]).map((view) => ({
            ...view,
            columns: view.columns.filter((key) => visible.has(key)),
            filters: view.filters?.filter((key) => visible.has(key)),
          })),
          actions: allowed,
          endpoint: `/api/ext/${ext.id}/entities/${id}`,
          kind: `ext:${ext.id}:${id}`,
        });
      }
    }
    const pages = (ext.surfaces?.pages ?? []).filter((page) => {
      if (page.requireRole === 'super' && user.role !== 'super') return false;
      if (page.kind === 'settings-form' && page.parent === 'administration' && user.role !== 'super') return false;
      return !('entity' in page) || entities.some((entity) => entity.id === page.entity);
    });
    if (ext.dataSources?.length && !entities.length) continue;
    if (ext.surfaces?.pages.length && !pages.length && !ext.tools?.length) continue;
    plugins.push({
      id: ext.id,
      name: ext.name,
      description: ext.description ?? null,
      version: ext.version ?? '0.0.0',
      official: ext.official ?? false,
      client_min: ext.client_min,
      features: flags.filter((_, i) => flagStates[i]).map((f) => f.key),
      mcp_groups: [...(ext.mcpGroups ?? [])],
      nav: (ext.surfaces?.nav ?? []).filter((item) => pages.some((page) => page.id === item.page)),
      pages,
      entities,
      entity_kinds: (ext.entityKinds ?? []).filter(
        (kind) => !ext.dataSources?.length || entities.some((entity) => entity.kind === kind.kind),
      ),
    });
  }
  return {
    manifest_version: STATION_MANIFEST_VERSION,
    core: { version: runningAppVersion() ?? '0.0.0', client_api: CLIENT_API_LEVEL },
    plugins,
    extensions: plugins.map((plugin) => {
      const ext = extensions.find((e) => e.id === plugin.id)!;
      return { id: ext.id, name: ext.name, description: ext.description ?? null };
    }),
    entityKinds: plugins.flatMap((plugin) => plugin.entity_kinds),
  };
}
