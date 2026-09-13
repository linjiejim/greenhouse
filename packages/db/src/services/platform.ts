/**
 * Platform control-plane service.
 *
 * This service owns persistence for Kernel v2 roles, user overrides, entity
 * policies, app release manifests, and immutable action audits. It does not
 * mutate existing feature flags or business-domain authorization.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  ApplicationManifest,
  ApplicationDefinition,
  DataScope,
  EntityPolicy,
  FieldPolicy,
  PlatformAuditEvent,
  RoleCapabilityGrant,
  UserCapabilityOverride,
  UserEntityPolicyOverride,
} from '@greenhouse/platform-kernel';
import { compileApp, isCapabilityPattern, isStableId, validateEntityPolicy } from '@greenhouse/platform-kernel';
import { DEFAULT_WORKBENCH_CONFIG, parseWorkbenchConfig, type WorkbenchConfig } from '@greenhouse/types/workbench';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';

import type { Db } from '../client.js';
import {
  platformAppReleases,
  platformAuditEvents,
  platformOrganizations,
  platformRoleBindings,
  platformRoleCapabilities,
  platformRoleEntityPolicies,
  platformRoles,
  platformUserCapabilityOverrides,
  platformUserEntityPolicyOverrides,
  platformUserWorkbenchPreferences,
} from '../schema/index.js';
import type {
  PlatformAppReleaseRow,
  PlatformAuditEventRow,
  PlatformCapabilityEffect,
  PlatformOrganizationRow,
  PlatformRoleBindingRow,
  PlatformRoleCapabilityRow,
  PlatformRoleEntityPolicyRow,
  PlatformRoleRow,
  PlatformRoleStatus,
  PlatformUserCapabilityOverrideRow,
  PlatformUserEntityPolicyOverrideRow,
  PlatformUserWorkbenchPreferencesRow,
} from '../schema/platform.js';
import type { UserRole } from '../schema/user.js';

export interface PlatformOrganizationInput {
  id: string;
  code: string;
  name: string;
}

export interface PlatformRoleInput {
  org_id: string;
  code: string;
  name: string;
  description?: string;
  system_protected?: boolean;
  created_by?: string;
}

export interface PlatformRoleUpdateInput {
  name?: string;
  description?: string;
  status?: PlatformRoleStatus;
}

export interface PlatformEntityPolicyInput {
  app_id: string;
  module_id: string;
  entity_id: string;
  scopes: readonly DataScope[];
  field_policies: Readonly<Record<string, FieldPolicy>>;
}

export interface PlatformAuthorizationSnapshot {
  roleGrants: RoleCapabilityGrant[];
  userOverrides: UserCapabilityOverride[];
}

export interface PlatformEntityPolicySnapshot {
  rolePolicies: EntityPolicy[];
  userOverride?: UserEntityPolicyOverride;
}

function parseJson<T>(value: string, fallback: T): T {
  return safeJsonParse(value, fallback) as T;
}

function parseStoredEntityPolicy(scopes: string, fields: string): EntityPolicy {
  return validateEntityPolicy({
    scopes: parseJson<unknown>(scopes, []),
    fields: parseJson<unknown>(fields, {}),
  });
}

function manifestPayload(manifest: ApplicationManifest): { json: string; hash: string } {
  const json = JSON.stringify(compileApp(manifest));
  return {
    json,
    hash: createHash('sha256').update(json).digest('hex'),
  };
}

function assertResourceIds(input: { app_id: string; module_id: string; entity_id: string }): void {
  for (const [label, value] of [
    ['app_id', input.app_id],
    ['module_id', input.module_id],
    ['entity_id', input.entity_id],
  ] as const) {
    if (!isStableId(value)) throw new Error(`${label} "${value}" is not a valid stable id`);
  }
}

function parseStoredManifest(row: PlatformAppReleaseRow): ApplicationManifest {
  const expectedHash = createHash('sha256').update(row.manifest).digest('hex');
  if (expectedHash !== row.manifest_hash) {
    throw new Error(`Application ${row.app_id}@${row.version}: manifest hash mismatch`);
  }
  const parsed = safeJsonParse(row.manifest, null);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Application ${row.app_id}@${row.version}: manifest JSON is invalid`);
  }
  const compiled = compileApp(parsed as ApplicationDefinition);
  if (compiled.id !== row.app_id || compiled.version !== row.version) {
    throw new Error(`Application ${row.app_id}@${row.version}: release metadata does not match the manifest`);
  }
  return compiled;
}

export function createPlatformService(db: Db) {
  const service = {
    async ensureOrganization(input: PlatformOrganizationInput): Promise<PlatformOrganizationRow> {
      const now = nowIso();
      const rows = await db
        .insert(platformOrganizations)
        .values({
          id: input.id,
          code: input.code,
          name: input.name,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: platformOrganizations.id,
          set: {
            code: input.code,
            name: input.name,
            updated_at: now,
          },
        })
        .returning();
      return rows[0]!;
    },

    async createRole(input: PlatformRoleInput): Promise<PlatformRoleRow> {
      const now = nowIso();
      const rows = await db
        .insert(platformRoles)
        .values({
          id: randomUUID(),
          org_id: input.org_id,
          code: input.code,
          name: input.name,
          description: input.description ?? '',
          system_protected: input.system_protected ?? false,
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    async ensureRole(input: PlatformRoleInput): Promise<PlatformRoleRow> {
      const now = nowIso();
      const rows = await db
        .insert(platformRoles)
        .values({
          id: randomUUID(),
          org_id: input.org_id,
          code: input.code,
          name: input.name,
          description: input.description ?? '',
          system_protected: input.system_protected ?? false,
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [platformRoles.org_id, platformRoles.code],
          set: {
            name: input.name,
            description: input.description ?? '',
            system_protected: input.system_protected ?? false,
            updated_at: now,
          },
        })
        .returning();
      return rows[0]!;
    },

    async getRole(id: string): Promise<PlatformRoleRow | undefined> {
      const rows = await db.select().from(platformRoles).where(eq(platformRoles.id, id)).limit(1);
      return rows[0];
    },

    async getRoleByCode(orgId: string, code: string): Promise<PlatformRoleRow | undefined> {
      const rows = await db
        .select()
        .from(platformRoles)
        .where(and(eq(platformRoles.org_id, orgId), eq(platformRoles.code, code)))
        .limit(1);
      return rows[0];
    },

    async updateRole(id: string, updates: PlatformRoleUpdateInput): Promise<PlatformRoleRow | undefined> {
      if (updates.status === 'disabled') {
        const rows = await db.select().from(platformRoles).where(eq(platformRoles.id, id)).limit(1);
        if (rows[0]?.system_protected) {
          throw new Error(`System-protected role ${rows[0].code} cannot be disabled`);
        }
      }
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) set.name = updates.name;
      if (updates.description !== undefined) set.description = updates.description;
      if (updates.status !== undefined) set.status = updates.status;
      const rows = await db.update(platformRoles).set(set).where(eq(platformRoles.id, id)).returning();
      return rows[0];
    },

    async listRoles(orgId: string): Promise<PlatformRoleRow[]> {
      return db.select().from(platformRoles).where(eq(platformRoles.org_id, orgId)).orderBy(platformRoles.code);
    },

    async deleteRole(id: string): Promise<boolean> {
      const role = await db.select().from(platformRoles).where(eq(platformRoles.id, id)).limit(1);
      if (!role[0] || role[0].system_protected) return false;
      const deleted = await db
        .delete(platformRoles)
        .where(eq(platformRoles.id, id))
        .returning({ id: platformRoles.id });
      return deleted.length > 0;
    },

    async bindRole(roleId: string, userId: string, assignedBy?: string): Promise<void> {
      await db
        .insert(platformRoleBindings)
        .values({
          role_id: roleId,
          user_id: userId,
          assigned_by: assignedBy ?? null,
          created_at: nowIso(),
        })
        .onConflictDoNothing({ target: [platformRoleBindings.role_id, platformRoleBindings.user_id] });
    },

    async replaceRoleBindings(roleId: string, userIds: readonly string[], assignedBy?: string): Promise<void> {
      const uniqueUserIds = [...new Set(userIds)].sort();
      await db.transaction(async (tx) => {
        await tx.delete(platformRoleBindings).where(eq(platformRoleBindings.role_id, roleId));
        if (uniqueUserIds.length > 0) {
          const now = nowIso();
          await tx.insert(platformRoleBindings).values(
            uniqueUserIds.map((userId) => ({
              role_id: roleId,
              user_id: userId,
              assigned_by: assignedBy ?? null,
              created_at: now,
            })),
          );
        }
      });
    },

    async syncLegacyRoleBinding(userId: string, role: UserRole, assignedBy?: string): Promise<void> {
      if (role !== 'super' && role !== 'team') {
        throw new Error(`Platform role binding requires an internal role, received "${role}"`);
      }
      const systemRoles = await db
        .select()
        .from(platformRoles)
        .where(and(eq(platformRoles.org_id, 'default'), inArray(platformRoles.code, ['super', 'team'])));
      if (systemRoles.length === 0) return;
      const target = systemRoles.find((item) => item.code === role);
      if (!target) throw new Error(`Platform system role "${role}" has not been bootstrapped`);

      await db.transaction(async (tx) => {
        await tx.delete(platformRoleBindings).where(
          and(
            eq(platformRoleBindings.user_id, userId),
            inArray(
              platformRoleBindings.role_id,
              systemRoles.map((item) => item.id),
            ),
          ),
        );
        await tx.insert(platformRoleBindings).values({
          role_id: target.id,
          user_id: userId,
          assigned_by: assignedBy ?? null,
          created_at: nowIso(),
        });
      });
    },

    async listRoleBindings(roleIds?: readonly string[]): Promise<PlatformRoleBindingRow[]> {
      if (roleIds && roleIds.length === 0) return [];
      const query = db.select().from(platformRoleBindings);
      if (!roleIds) return query.orderBy(platformRoleBindings.role_id, platformRoleBindings.user_id);
      return query
        .where(inArray(platformRoleBindings.role_id, [...roleIds]))
        .orderBy(platformRoleBindings.role_id, platformRoleBindings.user_id);
    },

    async replaceRoleCapabilities(roleId: string, capabilities: readonly string[], assignedBy?: string): Promise<void> {
      const uniqueCapabilities = [...new Set(capabilities)].sort();
      for (const capability of uniqueCapabilities) {
        if (!isCapabilityPattern(capability)) throw new Error(`Invalid capability pattern: ${capability}`);
      }
      await db.transaction(async (tx) => {
        await tx.delete(platformRoleCapabilities).where(eq(platformRoleCapabilities.role_id, roleId));
        if (uniqueCapabilities.length > 0) {
          const now = nowIso();
          await tx.insert(platformRoleCapabilities).values(
            uniqueCapabilities.map((capability) => ({
              role_id: roleId,
              capability,
              assigned_by: assignedBy ?? null,
              created_at: now,
            })),
          );
        }
      });
    },

    async listRoleCapabilities(roleIds?: readonly string[]): Promise<PlatformRoleCapabilityRow[]> {
      if (roleIds && roleIds.length === 0) return [];
      const query = db.select().from(platformRoleCapabilities);
      if (!roleIds) return query.orderBy(platformRoleCapabilities.role_id, platformRoleCapabilities.capability);
      return query
        .where(inArray(platformRoleCapabilities.role_id, [...roleIds]))
        .orderBy(platformRoleCapabilities.role_id, platformRoleCapabilities.capability);
    },

    async setUserCapabilityOverride(input: {
      org_id: string;
      user_id: string;
      capability: string;
      effect: PlatformCapabilityEffect;
      granted_by?: string;
      reason?: string;
    }): Promise<PlatformUserCapabilityOverrideRow> {
      if (!isCapabilityPattern(input.capability)) {
        throw new Error(`Invalid capability pattern: ${input.capability}`);
      }
      const now = nowIso();
      const rows = await db
        .insert(platformUserCapabilityOverrides)
        .values({
          org_id: input.org_id,
          user_id: input.user_id,
          capability: input.capability,
          effect: input.effect,
          granted_by: input.granted_by ?? null,
          reason: input.reason ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            platformUserCapabilityOverrides.org_id,
            platformUserCapabilityOverrides.user_id,
            platformUserCapabilityOverrides.capability,
          ],
          set: {
            effect: input.effect,
            granted_by: input.granted_by ?? null,
            reason: input.reason ?? null,
            updated_at: now,
          },
        })
        .returning();
      return rows[0]!;
    },

    async clearUserCapabilityOverride(orgId: string, userId: string, capability: string): Promise<boolean> {
      const deleted = await db
        .delete(platformUserCapabilityOverrides)
        .where(
          and(
            eq(platformUserCapabilityOverrides.org_id, orgId),
            eq(platformUserCapabilityOverrides.user_id, userId),
            eq(platformUserCapabilityOverrides.capability, capability),
          ),
        )
        .returning({ user_id: platformUserCapabilityOverrides.user_id });
      return deleted.length > 0;
    },

    async listUserCapabilityOverrides(orgId: string, userId?: string): Promise<PlatformUserCapabilityOverrideRow[]> {
      const query = db.select().from(platformUserCapabilityOverrides);
      return query
        .where(
          userId
            ? and(
                eq(platformUserCapabilityOverrides.org_id, orgId),
                eq(platformUserCapabilityOverrides.user_id, userId),
              )
            : eq(platformUserCapabilityOverrides.org_id, orgId),
        )
        .orderBy(platformUserCapabilityOverrides.user_id, platformUserCapabilityOverrides.capability);
    },

    async getAuthorizationSnapshot(userId: string, orgId: string): Promise<PlatformAuthorizationSnapshot> {
      const roleRows = await db
        .select({
          role_id: platformRoleCapabilities.role_id,
          capability: platformRoleCapabilities.capability,
        })
        .from(platformRoleBindings)
        .innerJoin(platformRoles, eq(platformRoles.id, platformRoleBindings.role_id))
        .innerJoin(platformRoleCapabilities, eq(platformRoleCapabilities.role_id, platformRoles.id))
        .where(
          and(
            eq(platformRoleBindings.user_id, userId),
            eq(platformRoles.org_id, orgId),
            eq(platformRoles.status, 'active'),
          ),
        );
      const overrideRows = await db
        .select()
        .from(platformUserCapabilityOverrides)
        .where(
          and(eq(platformUserCapabilityOverrides.user_id, userId), eq(platformUserCapabilityOverrides.org_id, orgId)),
        );

      return {
        roleGrants: roleRows.map((row) => ({
          source: 'role',
          roleId: row.role_id,
          capability: row.capability,
        })),
        userOverrides: overrideRows.map((row) => ({
          source: 'user',
          capability: row.capability,
          effect: row.effect,
        })),
      };
    },

    async upsertRoleEntityPolicy(roleId: string, input: PlatformEntityPolicyInput): Promise<void> {
      assertResourceIds(input);
      const policy = validateEntityPolicy({ scopes: input.scopes, fields: input.field_policies });
      const now = nowIso();
      await db
        .insert(platformRoleEntityPolicies)
        .values({
          id: randomUUID(),
          role_id: roleId,
          app_id: input.app_id,
          module_id: input.module_id,
          entity_id: input.entity_id,
          scopes: JSON.stringify(policy.scopes),
          field_policies: JSON.stringify(policy.fields),
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            platformRoleEntityPolicies.role_id,
            platformRoleEntityPolicies.app_id,
            platformRoleEntityPolicies.entity_id,
          ],
          set: {
            module_id: input.module_id,
            scopes: JSON.stringify(policy.scopes),
            field_policies: JSON.stringify(policy.fields),
            updated_at: now,
          },
        });
    },

    async listRoleEntityPolicies(roleIds?: readonly string[]): Promise<PlatformRoleEntityPolicyRow[]> {
      if (roleIds && roleIds.length === 0) return [];
      const query = db.select().from(platformRoleEntityPolicies);
      if (!roleIds) {
        return query.orderBy(
          platformRoleEntityPolicies.role_id,
          platformRoleEntityPolicies.app_id,
          platformRoleEntityPolicies.entity_id,
        );
      }
      return query
        .where(inArray(platformRoleEntityPolicies.role_id, [...roleIds]))
        .orderBy(
          platformRoleEntityPolicies.role_id,
          platformRoleEntityPolicies.app_id,
          platformRoleEntityPolicies.entity_id,
        );
    },

    async setUserEntityPolicyOverride(input: {
      org_id: string;
      user_id: string;
      effect: PlatformCapabilityEffect;
      policy: PlatformEntityPolicyInput;
      granted_by?: string;
      reason?: string;
    }): Promise<PlatformUserEntityPolicyOverrideRow> {
      assertResourceIds(input.policy);
      const policy = validateEntityPolicy({
        scopes: input.policy.scopes,
        fields: input.policy.field_policies,
      });
      const now = nowIso();
      const rows = await db
        .insert(platformUserEntityPolicyOverrides)
        .values({
          id: randomUUID(),
          org_id: input.org_id,
          user_id: input.user_id,
          app_id: input.policy.app_id,
          module_id: input.policy.module_id,
          entity_id: input.policy.entity_id,
          effect: input.effect,
          scopes: JSON.stringify(policy.scopes),
          field_policies: JSON.stringify(policy.fields),
          granted_by: input.granted_by ?? null,
          reason: input.reason ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            platformUserEntityPolicyOverrides.org_id,
            platformUserEntityPolicyOverrides.user_id,
            platformUserEntityPolicyOverrides.app_id,
            platformUserEntityPolicyOverrides.entity_id,
          ],
          set: {
            module_id: input.policy.module_id,
            effect: input.effect,
            scopes: JSON.stringify(policy.scopes),
            field_policies: JSON.stringify(policy.fields),
            granted_by: input.granted_by ?? null,
            reason: input.reason ?? null,
            updated_at: now,
          },
        })
        .returning();
      return rows[0]!;
    },

    async listUserEntityPolicyOverrides(
      orgId: string,
      userId?: string,
    ): Promise<PlatformUserEntityPolicyOverrideRow[]> {
      const conditions = [eq(platformUserEntityPolicyOverrides.org_id, orgId)];
      if (userId) conditions.push(eq(platformUserEntityPolicyOverrides.user_id, userId));
      return db
        .select()
        .from(platformUserEntityPolicyOverrides)
        .where(and(...conditions))
        .orderBy(
          platformUserEntityPolicyOverrides.user_id,
          platformUserEntityPolicyOverrides.app_id,
          platformUserEntityPolicyOverrides.entity_id,
        );
    },

    async clearUserEntityPolicyOverride(
      orgId: string,
      userId: string,
      appId: string,
      entityId: string,
    ): Promise<boolean> {
      const deleted = await db
        .delete(platformUserEntityPolicyOverrides)
        .where(
          and(
            eq(platformUserEntityPolicyOverrides.org_id, orgId),
            eq(platformUserEntityPolicyOverrides.user_id, userId),
            eq(platformUserEntityPolicyOverrides.app_id, appId),
            eq(platformUserEntityPolicyOverrides.entity_id, entityId),
          ),
        )
        .returning({ id: platformUserEntityPolicyOverrides.id });
      return deleted.length > 0;
    },

    async getEntityPolicySnapshot(input: {
      orgId: string;
      userId: string;
      appId: string;
      entityId: string;
    }): Promise<PlatformEntityPolicySnapshot> {
      const roleRows = await db
        .select({
          scopes: platformRoleEntityPolicies.scopes,
          field_policies: platformRoleEntityPolicies.field_policies,
        })
        .from(platformRoleBindings)
        .innerJoin(platformRoles, eq(platformRoles.id, platformRoleBindings.role_id))
        .innerJoin(platformRoleEntityPolicies, eq(platformRoleEntityPolicies.role_id, platformRoles.id))
        .where(
          and(
            eq(platformRoleBindings.user_id, input.userId),
            eq(platformRoles.org_id, input.orgId),
            eq(platformRoles.status, 'active'),
            eq(platformRoleEntityPolicies.app_id, input.appId),
            eq(platformRoleEntityPolicies.entity_id, input.entityId),
          ),
        );
      const overrideRows = await db
        .select()
        .from(platformUserEntityPolicyOverrides)
        .where(
          and(
            eq(platformUserEntityPolicyOverrides.org_id, input.orgId),
            eq(platformUserEntityPolicyOverrides.user_id, input.userId),
            eq(platformUserEntityPolicyOverrides.app_id, input.appId),
            eq(platformUserEntityPolicyOverrides.entity_id, input.entityId),
          ),
        )
        .limit(1);

      const override = overrideRows[0];
      return {
        rolePolicies: roleRows.map((row) => parseStoredEntityPolicy(row.scopes, row.field_policies)),
        userOverride: override
          ? {
              effect: override.effect,
              policy: parseStoredEntityPolicy(override.scopes, override.field_policies),
            }
          : undefined,
      };
    },

    async getUserWorkbenchPreferences(orgId: string, userId: string): Promise<WorkbenchConfig> {
      const rows = await db
        .select({ preferences: platformUserWorkbenchPreferences.preferences })
        .from(platformUserWorkbenchPreferences)
        .where(
          and(eq(platformUserWorkbenchPreferences.org_id, orgId), eq(platformUserWorkbenchPreferences.user_id, userId)),
        )
        .limit(1);
      return rows[0] ? parseWorkbenchConfig(rows[0].preferences) : { ...DEFAULT_WORKBENCH_CONFIG };
    },

    async setUserWorkbenchPreferences(
      orgId: string,
      userId: string,
      preferences: WorkbenchConfig,
    ): Promise<PlatformUserWorkbenchPreferencesRow> {
      const normalized = parseWorkbenchConfig(preferences);
      const now = nowIso();
      const rows = await db
        .insert(platformUserWorkbenchPreferences)
        .values({
          org_id: orgId,
          user_id: userId,
          preferences: JSON.stringify(normalized),
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [platformUserWorkbenchPreferences.org_id, platformUserWorkbenchPreferences.user_id],
          set: {
            preferences: JSON.stringify(normalized),
            updated_at: now,
          },
        })
        .returning();
      return rows[0]!;
    },

    /**
     * Serialize a read-modify-write of one user's JSON workbench blob.
     *
     * Agent calls, browser tabs and the Home editor can all update the same row.
     * A plain get + set loses whichever write arrives first. The transaction-level
     * advisory lock also covers the first write, when there is no row available
     * for `FOR UPDATE` yet, and remains compatible with the test harness savepoint.
     */
    async mutateUserWorkbenchPreferences(
      orgId: string,
      userId: string,
      mutate: (current: WorkbenchConfig) => WorkbenchConfig,
    ): Promise<WorkbenchConfig> {
      return db.transaction(async (tx) => {
        const lockKey = `platform-workbench:${orgId}:${userId}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const rows = await tx
          .select({ preferences: platformUserWorkbenchPreferences.preferences })
          .from(platformUserWorkbenchPreferences)
          .where(
            and(
              eq(platformUserWorkbenchPreferences.org_id, orgId),
              eq(platformUserWorkbenchPreferences.user_id, userId),
            ),
          )
          .limit(1);
        const current = rows[0] ? parseWorkbenchConfig(rows[0].preferences) : { ...DEFAULT_WORKBENCH_CONFIG };
        const normalized = parseWorkbenchConfig(mutate(current));
        const now = nowIso();
        await tx
          .insert(platformUserWorkbenchPreferences)
          .values({
            org_id: orgId,
            user_id: userId,
            preferences: JSON.stringify(normalized),
            created_at: now,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: [platformUserWorkbenchPreferences.org_id, platformUserWorkbenchPreferences.user_id],
            set: { preferences: JSON.stringify(normalized), updated_at: now },
          });
        return normalized;
      });
    },

    async publishAppRelease(input: {
      manifest: ApplicationManifest;
      git_commit?: string;
      created_by?: string;
    }): Promise<PlatformAppReleaseRow> {
      const payload = manifestPayload(input.manifest);
      const existing = await db
        .select()
        .from(platformAppReleases)
        .where(
          and(
            eq(platformAppReleases.app_id, input.manifest.id),
            eq(platformAppReleases.version, input.manifest.version),
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].manifest_hash !== payload.hash) {
          throw new Error(
            `Application ${input.manifest.id}@${input.manifest.version} already exists with a different manifest hash`,
          );
        }
        return existing[0];
      }

      const now = nowIso();
      const rows = await db
        .insert(platformAppReleases)
        .values({
          id: randomUUID(),
          app_id: input.manifest.id,
          version: input.manifest.version,
          manifest: payload.json,
          manifest_hash: payload.hash,
          git_commit: input.git_commit ?? null,
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    async activateAppRelease(id: string): Promise<PlatformAppReleaseRow | undefined> {
      return db.transaction(async (tx) => {
        const target = await tx.select().from(platformAppReleases).where(eq(platformAppReleases.id, id)).limit(1);
        if (!target[0]) return undefined;
        parseStoredManifest(target[0]);
        const now = nowIso();
        await tx
          .update(platformAppReleases)
          .set({ status: 'retired', updated_at: now })
          .where(and(eq(platformAppReleases.app_id, target[0].app_id), eq(platformAppReleases.status, 'active')));
        const rows = await tx
          .update(platformAppReleases)
          .set({ status: 'active', activated_at: now, updated_at: now })
          .where(eq(platformAppReleases.id, id))
          .returning();
        return rows[0];
      });
    },

    async listActiveAppReleases(): Promise<Array<PlatformAppReleaseRow & { parsedManifest: ApplicationManifest }>> {
      const rows = await db
        .select()
        .from(platformAppReleases)
        .where(eq(platformAppReleases.status, 'active'))
        .orderBy(platformAppReleases.app_id);
      return rows.map((row) => ({
        ...row,
        parsedManifest: parseStoredManifest(row),
      }));
    },

    async listAppReleases(
      appId?: string,
    ): Promise<Array<PlatformAppReleaseRow & { parsedManifest: ApplicationManifest }>> {
      const query = db.select().from(platformAppReleases);
      const rows = appId
        ? await query
            .where(eq(platformAppReleases.app_id, appId))
            .orderBy(platformAppReleases.app_id, desc(platformAppReleases.created_at))
        : await query.orderBy(platformAppReleases.app_id, desc(platformAppReleases.created_at));
      return rows.map((row) => ({
        ...row,
        parsedManifest: parseStoredManifest(row),
      }));
    },

    async recordAudit(event: PlatformAuditEvent): Promise<PlatformAuditEventRow> {
      const rows = await db
        .insert(platformAuditEvents)
        .values({
          id: event.id ?? randomUUID(),
          org_id: event.orgId,
          actor_id: event.actorId,
          actor_type: event.actorType,
          on_behalf_of_user_id: event.onBehalfOfUserId ?? null,
          client_id: event.clientId ?? null,
          request_id: event.requestId,
          app_id: event.resource.appId,
          module_id: event.resource.moduleId ?? null,
          entity_id: event.resource.entityId ?? null,
          record_id: event.resource.recordId ?? null,
          action_id: event.actionId,
          capability: event.capability,
          result: event.result,
          summary: JSON.stringify(event.summary ?? {}),
          created_at: event.createdAt ?? nowIso(),
        })
        .returning();
      return rows[0]!;
    },

    async listAuditEvents(orgId: string, limit = 100): Promise<PlatformAuditEventRow[]> {
      return db
        .select()
        .from(platformAuditEvents)
        .where(eq(platformAuditEvents.org_id, orgId))
        .orderBy(desc(platformAuditEvents.created_at))
        .limit(Math.min(Math.max(limit, 1), 500));
    },

    async listAuditEventsForApp(orgId: string, appId: string, limit = 100): Promise<PlatformAuditEventRow[]> {
      return db
        .select()
        .from(platformAuditEvents)
        .where(and(eq(platformAuditEvents.org_id, orgId), eq(platformAuditEvents.app_id, appId)))
        .orderBy(desc(platformAuditEvents.created_at))
        .limit(Math.min(Math.max(limit, 1), 500));
    },
  };
  return service;
}

export type PlatformService = ReturnType<typeof createPlatformService>;
