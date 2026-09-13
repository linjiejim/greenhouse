/**
 * Platform administration routes — /api/admin/platform
 *
 * GET    /catalog                         — 应用 Manifest 与 capability catalog
 * GET    /roles                           — 角色、授权、绑定与实体策略
 * POST   /roles                           — 创建自定义角色
 * PATCH  /roles/:id                       — 更新自定义角色
 * DELETE /roles/:id                       — 删除自定义角色
 * PUT    /roles/:id/capabilities          — 替换自定义角色 capability
 * PUT    /roles/:id/bindings              — 替换自定义角色用户绑定
 * PUT    /roles/:id/entity-policies/:appId/:entityId — 写入角色实体策略
 * GET    /users/:userId/effective         — 查看用户最终权限
 * PUT    /users/:userId/overrides         — 写入用户 allow/deny
 * DELETE /users/:userId/overrides         — 清除用户覆盖
 * PUT    /users/:userId/entity-policies/:appId/:entityId — 写入用户实体覆盖
 * GET    /audit                           — 最近平台动作审计
 * GET    /oauth/clients                   — OAuth 客户端列表（public + machine，secret hash 不外发）
 * PATCH  /oauth/clients/:id               — 启用/禁用 OAuth 客户端并撤权
 * DELETE /oauth/clients/:id               — 删除客户端（级联撤销 grant/token）
 * GET    /oauth/clients/:id/audit         — 该客户端的 MCP 调用审计（api_audit_log）
 * POST   /oauth/machine-clients           — 创建 client_credentials 机器客户端（返回一次性 secret）
 * POST   /oauth/machine-clients/:id/rotate-secret — 轮换 secret（返回一次性新 secret）
 */

import { Hono } from 'hono';
import {
  capabilityMatches,
  isCapabilityPattern,
  isStableId,
  validateEntityPolicy,
  resolveEntityPolicy,
  type CapabilityEffect,
} from '@greenhouse/platform-kernel';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { getAuthUser, requireSuper } from '../auth/middleware.js';
import { humanActor } from '../platform/actor.js';
import { getPlatformRuntime, PLATFORM_ORG_ID } from '../platform/runtime.js';
import { PLATFORM_CONTROL_CAPABILITIES } from '../platform/bootstrap.js';
import {
  generateClientSecret,
  generateOAuthClientId,
  getMcpResourceUrl,
  hashOAuthCredential,
  normalizeOAuthScopes,
  parseStoredStringArray,
} from '../platform/oauth.js';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { PlatformOAuthClientRow } from '@greenhouse/db';

/** Secret hashes never leave the API, even to super admins. */
function formatOAuthClient(client: PlatformOAuthClientRow) {
  const { client_secret_hash: _redacted, ...rest } = client;
  return {
    ...rest,
    redirect_uris: parseStoredStringArray(client.redirect_uris),
    allowed_scopes: parseStoredStringArray(client.allowed_scopes),
    machine: client.token_endpoint_auth_method === 'client_secret_post',
  };
}

function knownCapabilities(): string[] {
  return [
    ...PLATFORM_CONTROL_CAPABILITIES,
    ...getPlatformRuntime()
      .listManifests()
      .flatMap((manifest) => manifest.capabilities),
  ];
}

function validateCapabilityCatalog(patterns: readonly string[]): string | undefined {
  const catalog = knownCapabilities();
  for (const pattern of patterns) {
    if (!isCapabilityPattern(pattern)) return `Invalid capability pattern: ${pattern}`;
    if (pattern !== '*' && !catalog.some((capability) => capabilityMatches(pattern, capability))) {
      return `Capability pattern does not match an active application: ${pattern}`;
    }
  }
  return undefined;
}

function manifestEntity(appId: string, entityId: string) {
  return getPlatformRuntime().getManifest(appId)?.entities[entityId];
}

function validateManifestEntityPolicy(
  entity: NonNullable<ReturnType<typeof manifestEntity>>,
  value: { scopes?: unknown; fields?: unknown },
) {
  const policy = validateEntityPolicy({ scopes: value.scopes, fields: value.fields });
  const unsupportedScope = policy.scopes.find(
    (scope) => !entity.accessScopes.some((supported) => supported === scope.kind),
  );
  if (unsupportedScope) {
    throw new Error(`Scope "${unsupportedScope.kind}" is not supported by entity ${entity.id}`);
  }
  const unknownField = Object.keys(policy.fields).find(
    (fieldId) => !Object.prototype.hasOwnProperty.call(entity.fields, fieldId),
  );
  if (unknownField) {
    throw new Error(`Field "${unknownField}" is not declared by entity ${entity.id}`);
  }
  const contradictoryField = Object.entries(policy.fields).find(
    ([, fieldPolicy]) => fieldPolicy.read === 'none' && (fieldPolicy.write || fieldPolicy.export),
  );
  if (contradictoryField) {
    throw new Error(`Field "${contradictoryField[0]}" cannot be writable or exportable when read access is none`);
  }
  return policy;
}

const platformAdminRoutes = new Hono<AppEnv>()
  .use('*', requireSuper())
  .get('/catalog', async (c) => {
    const releases = await getDb().platform.listAppReleases();
    return c.json({
      applications: getPlatformRuntime().listManifests(),
      releases: releases.map(({ parsedManifest: _parsedManifest, ...release }) => release),
    });
  })
  .get('/roles', async (c) => {
    const roles = await getDb().platform.listRoles(PLATFORM_ORG_ID);
    const roleIds = roles.map((role) => role.id);
    const [capabilities, bindings, entityPolicies, userOverrides, users] = await Promise.all([
      getDb().platform.listRoleCapabilities(roleIds),
      getDb().platform.listRoleBindings(roleIds),
      getDb().platform.listRoleEntityPolicies(roleIds),
      getDb().platform.listUserCapabilityOverrides(PLATFORM_ORG_ID),
      getDb().users.list(),
    ]);
    const userEntityPolicies = await getDb().platform.listUserEntityPolicyOverrides(PLATFORM_ORG_ID);
    return c.json({
      roles,
      capabilities,
      bindings,
      entityPolicies,
      userOverrides,
      userEntityPolicies,
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        status: user.status,
      })),
    });
  })
  .post('/roles', async (c) => {
    const actor = getAuthUser(c);
    const body = (await c.req.json()) as { code?: string; name?: string; description?: string };
    if (!body.code || !isStableId(body.code) || !body.name?.trim()) {
      return c.json({ error: 'code must be a stable ID and name is required' }, 400);
    }
    try {
      const role = await getDb().platform.createRole({
        org_id: PLATFORM_ORG_ID,
        code: body.code,
        name: body.name.trim(),
        description: body.description,
        created_by: actor.id,
      });
      return c.json({ role }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unable to create role' }, 409);
    }
  })
  .patch('/roles/:id', async (c) => {
    const role = await getDb().platform.getRole(c.req.param('id'));
    if (!role) return c.json({ error: 'Role not found' }, 404);
    if (role.system_protected) return c.json({ error: 'System-protected roles cannot be edited' }, 409);
    const body = (await c.req.json()) as {
      name?: string;
      description?: string;
      status?: 'active' | 'disabled';
    };
    const updated = await getDb().platform.updateRole(role.id, body);
    return c.json({ role: updated });
  })
  .delete('/roles/:id', async (c) => {
    const role = await getDb().platform.getRole(c.req.param('id'));
    if (!role) return c.json({ error: 'Role not found' }, 404);
    if (role.system_protected) return c.json({ error: 'System-protected roles cannot be deleted' }, 409);
    return c.json({ success: await getDb().platform.deleteRole(role.id) });
  })
  .put('/roles/:id/capabilities', async (c) => {
    const role = await getDb().platform.getRole(c.req.param('id'));
    if (!role) return c.json({ error: 'Role not found' }, 404);
    if (role.system_protected) {
      return c.json({ error: 'Use user overrides instead of editing protected baseline roles' }, 409);
    }
    const body = (await c.req.json()) as { capabilities?: string[] };
    if (!Array.isArray(body.capabilities)) return c.json({ error: 'capabilities must be an array' }, 400);
    const validationError = validateCapabilityCatalog(body.capabilities);
    if (validationError) return c.json({ error: validationError }, 400);
    await getDb().platform.replaceRoleCapabilities(role.id, body.capabilities, getAuthUser(c).id);
    return c.json({ success: true });
  })
  .put('/roles/:id/bindings', async (c) => {
    const role = await getDb().platform.getRole(c.req.param('id'));
    if (!role) return c.json({ error: 'Role not found' }, 404);
    if (role.system_protected) {
      return c.json({ error: 'Protected role bindings are synchronized from the account role' }, 409);
    }
    const body = (await c.req.json()) as { userIds?: string[] };
    if (!Array.isArray(body.userIds)) return c.json({ error: 'userIds must be an array' }, 400);
    const users = await Promise.all(body.userIds.map((userId) => getDb().users.getById(userId)));
    if (users.some((user) => !user)) return c.json({ error: 'One or more users do not exist' }, 400);
    await getDb().platform.replaceRoleBindings(role.id, body.userIds, getAuthUser(c).id);
    return c.json({ success: true });
  })
  .put('/roles/:id/entity-policies/:appId/:entityId', async (c) => {
    const role = await getDb().platform.getRole(c.req.param('id'));
    if (!role) return c.json({ error: 'Role not found' }, 404);
    if (role.system_protected) {
      return c.json({ error: 'Protected baseline entity policies cannot be edited' }, 409);
    }
    const appId = c.req.param('appId');
    const entityId = c.req.param('entityId');
    const entity = manifestEntity(appId, entityId);
    if (!entity) return c.json({ error: 'Manifest entity not found' }, 404);
    try {
      const body = (await c.req.json()) as { scopes?: unknown; fields?: unknown };
      const policy = validateManifestEntityPolicy(entity, body);
      await getDb().platform.upsertRoleEntityPolicy(role.id, {
        app_id: appId,
        module_id: entity.module,
        entity_id: entityId,
        scopes: policy.scopes,
        field_policies: policy.fields,
      });
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid entity policy' }, 400);
    }
  })
  .get('/users/:userId/effective', async (c) => {
    const user = await getDb().users.getById(c.req.param('userId'));
    if (!user) return c.json({ error: 'User not found' }, 404);
    const actor = humanActor(user);
    const permissions = [];
    for (const manifest of getPlatformRuntime().listManifests()) {
      for (const capability of manifest.capabilities) {
        permissions.push({
          appId: manifest.id,
          ...(await getPlatformRuntime().authorize(actor, capability)),
        });
      }
    }
    const overrides = await getDb().platform.listUserCapabilityOverrides(PLATFORM_ORG_ID, user.id);
    const entityPolicies = [];
    for (const manifest of getPlatformRuntime().listManifests()) {
      for (const entity of Object.values(manifest.entities)) {
        const snapshot = await getDb().platform.getEntityPolicySnapshot({
          orgId: PLATFORM_ORG_ID,
          userId: user.id,
          appId: manifest.id,
          entityId: entity.id,
        });
        entityPolicies.push({
          appId: manifest.id,
          moduleId: entity.module,
          entityId: entity.id,
          policy: resolveEntityPolicy(snapshot.rolePolicies, snapshot.userOverride),
          override: snapshot.userOverride,
        });
      }
    }
    return c.json({
      user: { id: user.id, nickname: user.nickname, role: user.role },
      permissions,
      overrides,
      entityPolicies,
    });
  })
  .put('/users/:userId/overrides', async (c) => {
    const user = await getDb().users.getById(c.req.param('userId'));
    if (!user) return c.json({ error: 'User not found' }, 404);
    const body = (await c.req.json()) as {
      capability?: string;
      effect?: CapabilityEffect;
      reason?: string;
    };
    if (!body.capability || (body.effect !== 'allow' && body.effect !== 'deny')) {
      return c.json({ error: 'capability and effect are required' }, 400);
    }
    const validationError = validateCapabilityCatalog([body.capability]);
    if (validationError) return c.json({ error: validationError }, 400);
    const override = await getDb().platform.setUserCapabilityOverride({
      org_id: PLATFORM_ORG_ID,
      user_id: user.id,
      capability: body.capability,
      effect: body.effect,
      reason: body.reason,
      granted_by: getAuthUser(c).id,
    });
    return c.json({ override });
  })
  .delete('/users/:userId/overrides', async (c) => {
    const capability = c.req.query('capability');
    if (!capability) return c.json({ error: 'capability query parameter is required' }, 400);
    return c.json({
      success: await getDb().platform.clearUserCapabilityOverride(PLATFORM_ORG_ID, c.req.param('userId'), capability),
    });
  })
  .put('/users/:userId/entity-policies/:appId/:entityId', async (c) => {
    const user = await getDb().users.getById(c.req.param('userId'));
    if (!user) return c.json({ error: 'User not found' }, 404);
    const appId = c.req.param('appId');
    const entityId = c.req.param('entityId');
    const entity = manifestEntity(appId, entityId);
    if (!entity) return c.json({ error: 'Manifest entity not found' }, 404);
    try {
      const body = (await c.req.json()) as {
        effect?: CapabilityEffect;
        scopes?: unknown;
        fields?: unknown;
        reason?: string;
      };
      if (body.effect !== 'allow' && body.effect !== 'deny') {
        return c.json({ error: 'effect must be allow or deny' }, 400);
      }
      const policy =
        body.effect === 'deny'
          ? validateEntityPolicy({ scopes: [], fields: {} })
          : validateManifestEntityPolicy(entity, {
              scopes: body.scopes ?? [],
              fields: body.fields ?? {},
            });
      const override = await getDb().platform.setUserEntityPolicyOverride({
        org_id: PLATFORM_ORG_ID,
        user_id: user.id,
        effect: body.effect,
        policy: {
          app_id: appId,
          module_id: entity.module,
          entity_id: entityId,
          scopes: policy.scopes,
          field_policies: policy.fields,
        },
        reason: body.reason,
        granted_by: getAuthUser(c).id,
      });
      return c.json({ override });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid entity policy' }, 400);
    }
  })
  .delete('/users/:userId/entity-policies/:appId/:entityId', async (c) => {
    const user = await getDb().users.getById(c.req.param('userId'));
    if (!user) return c.json({ error: 'User not found' }, 404);
    if (!manifestEntity(c.req.param('appId'), c.req.param('entityId'))) {
      return c.json({ error: 'Manifest entity not found' }, 404);
    }
    return c.json({
      success: await getDb().platform.clearUserEntityPolicyOverride(
        PLATFORM_ORG_ID,
        c.req.param('userId'),
        c.req.param('appId'),
        c.req.param('entityId'),
      ),
    });
  })
  .get('/audit', async (c) => {
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json({ events: await getDb().platform.listAuditEvents(PLATFORM_ORG_ID, limit) });
  })
  .get('/oauth/clients', async (c) => {
    const [clients, grants] = await Promise.all([
      getDb().platformOAuth.listClients(),
      getDb().platformOAuth.listActiveGrantPrincipals(),
    ]);
    const grantedByClient = new Map<string, string[]>();
    for (const g of grants) {
      const ids = grantedByClient.get(g.client_id) ?? [];
      if (!ids.includes(g.user_id)) ids.push(g.user_id);
      grantedByClient.set(g.client_id, ids);
    }
    return c.json({
      clients: clients.map((client) => ({
        ...formatOAuthClient(client),
        granted_user_ids: grantedByClient.get(client.id) ?? [],
      })),
    });
  })
  .post('/oauth/machine-clients', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { client_name?: string; bound_user_id?: string; scopes?: string[] }
      | undefined;
    const clientName = body?.client_name?.trim();
    if (!clientName || clientName.length > 120) {
      return c.json({ error: 'client_name is required (max 120 chars)' }, 400);
    }
    if (!body?.bound_user_id) return c.json({ error: 'bound_user_id is required' }, 400);
    const boundUser = await getDb().users.getById(body.bound_user_id);
    if (!boundUser || boundUser.status !== 'active') {
      return c.json({ error: 'Bound user not found or not active' }, 400);
    }
    if (boundUser.role !== 'super' && boundUser.role !== 'team') {
      return c.json({ error: 'Bound user must be internal (super or team)' }, 400);
    }
    let scopes;
    try {
      scopes = normalizeOAuthScopes((body.scopes ?? []).join(' '));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid scopes' }, 400);
    }

    const clientId = generateOAuthClientId();
    const clientSecret = generateClientSecret();
    const client = await getDb().platformOAuth.registerMachineClient({
      id: clientId,
      client_name: clientName,
      client_secret_hash: hashOAuthCredential(clientSecret),
      bound_user_id: body.bound_user_id,
      allowed_scopes: JSON.stringify(scopes),
      created_by: getAuthUser(c).id,
    });
    await getDb().platformOAuth.upsertGrant({
      user_id: body.bound_user_id,
      client_id: clientId,
      resource: getMcpResourceUrl(),
      scopes: JSON.stringify(scopes),
    });
    await getDb().platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: getAuthUser(c).id,
      actorType: 'human',
      requestId: humanActor(getAuthUser(c), c).requestId,
      clientId,
      resource: { appId: 'platform', entityId: 'oauthClient', recordId: clientId },
      actionId: 'createOAuthMachineClient',
      capability: 'platform.oauth.manageAll',
      result: 'success',
      summary: { bound_user_id: body.bound_user_id, scopes },
    });
    return c.json(
      {
        client: formatOAuthClient(client),
        client_id: clientId,
        client_secret: clientSecret,
        warning: 'Save the client_secret now — it will not be shown again.',
      },
      201,
    );
  })
  .post('/oauth/machine-clients/:id/rotate-secret', async (c) => {
    const clientSecret = generateClientSecret();
    const client = await getDb().platformOAuth.rotateClientSecret(c.req.param('id'), hashOAuthCredential(clientSecret));
    if (!client) return c.json({ error: 'Machine client not found' }, 404);
    await getDb().platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: getAuthUser(c).id,
      actorType: 'human',
      requestId: humanActor(getAuthUser(c), c).requestId,
      clientId: client.id,
      resource: { appId: 'platform', entityId: 'oauthClient', recordId: client.id },
      actionId: 'rotateOAuthClientSecret',
      capability: 'platform.oauth.manageAll',
      result: 'success',
      summary: {},
    });
    return c.json({
      client: formatOAuthClient(client),
      client_secret: clientSecret,
      warning: 'Save the new client_secret now — the old secret is invalid immediately.',
    });
  })
  .delete('/oauth/clients/:id', async (c) => {
    const client = await getDb().platformOAuth.getClient(c.req.param('id'));
    if (!client) return c.json({ error: 'OAuth client not found' }, 404);
    await getDb().platformOAuth.deleteClient(client.id);
    await getDb().platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: getAuthUser(c).id,
      actorType: 'human',
      requestId: humanActor(getAuthUser(c), c).requestId,
      clientId: client.id,
      resource: { appId: 'platform', entityId: 'oauthClient', recordId: client.id },
      actionId: 'deleteOAuthClient',
      capability: 'platform.oauth.manageAll',
      result: 'success',
      summary: { client_name: client.client_name },
    });
    return c.json({ ok: true, deleted: client.id });
  })
  .get('/oauth/clients/:id/audit', async (c) => {
    const client = await getDb().platformOAuth.getClient(c.req.param('id'));
    if (!client) return c.json({ error: 'OAuth client not found' }, 404);
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const since = c.req.query('since') || undefined;
    const [records, total] = await Promise.all([
      getDb().apiAudit.list({ app_id: client.id, since, limit, offset }),
      getDb().apiAudit.count({ app_id: client.id, since }),
    ]);
    return c.json({
      records: records.map((r) => ({ ...r, meta: safeJsonParse(r.meta) })),
      total,
      has_more: offset + limit < total,
    });
  })
  .patch('/oauth/clients/:id', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { status?: 'active' | 'disabled' } | undefined;
    if (body?.status !== 'active' && body?.status !== 'disabled') {
      return c.json({ error: 'status must be active or disabled' }, 400);
    }
    const client = await getDb().platformOAuth.setClientStatus(c.req.param('id'), body.status);
    if (!client) return c.json({ error: 'OAuth client not found' }, 404);
    // Disabling cascades grant/token revocation; re-enabling a machine client
    // must restore its (single, admin-defined) grant or token issuance stays
    // dead. Public-client grants stay revoked — users re-consent themselves.
    if (
      body.status === 'active' &&
      client.token_endpoint_auth_method === 'client_secret_post' &&
      client.bound_user_id
    ) {
      await getDb().platformOAuth.upsertGrant({
        user_id: client.bound_user_id,
        client_id: client.id,
        resource: getMcpResourceUrl(),
        scopes: client.allowed_scopes,
      });
    }
    await getDb().platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: getAuthUser(c).id,
      actorType: 'human',
      requestId: humanActor(getAuthUser(c), c).requestId,
      clientId: client.id,
      resource: { appId: 'platform', entityId: 'oauthClient', recordId: client.id },
      actionId: body.status === 'disabled' ? 'disableOAuthClient' : 'enableOAuthClient',
      capability: 'platform.oauth.manageAll',
      result: 'success',
      summary: { status: body.status },
    });
    return c.json({ client: formatOAuthClient(client) });
  });

export default platformAdminRoutes;
