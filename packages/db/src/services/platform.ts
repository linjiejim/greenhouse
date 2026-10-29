import { assertDiscriminator } from '@greenhouse/types/discriminators';
/**
 * Platform control-plane service.
 *
 * Persistence for Kernel v2 roles (capabilities + entity policies + members)
 * and the immutable action audit. Single organization: every `orgId`
 * parameter is kept for the kernel's interface and ignored. Per-user
 * capability / entity-policy overrides and stored app releases were retired in
 * 3.0 — precedence is role allow > default deny, and the manifest golden-hash
 * test guards releases.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  DataScope,
  EntityPolicy,
  FieldPolicy,
  PlatformAuditEvent,
  RoleCapabilityGrant,
} from '@greenhouse/platform-kernel';
import { isCapabilityPattern, isStableId, validateEntityPolicy } from '@greenhouse/platform-kernel';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import {
  auditEvents as platformAuditEvents,
  roleMembers as platformRoleBindings,
  roleCapabilities as platformRoleCapabilities,
  roleEntityPolicies as platformRoleEntityPolicies,
  roles as platformRoles,
  users,
} from '../schema/index.js';
import type {
  PlatformRoleBindingRow,
  PlatformRoleCapabilityRow,
  PlatformRoleEntityPolicyRow,
  PlatformRoleRow,
  PlatformRoleStatus,
} from '../schema/access.js';
import type { PlatformAuditEventRow } from '../schema/audit.js';
import type { UserRole } from '../schema/identity.js';

export interface PlatformRoleInput {
  /** Ignored (single organization); kept so callers written for 1.x compile. */
  org_id?: string;
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
}

export interface PlatformEntityPolicySnapshot {
  rolePolicies: EntityPolicy[];
}

function parseStoredEntityPolicy(scopes: unknown, fields: unknown): EntityPolicy {
  return validateEntityPolicy({ scopes: scopes ?? [], fields: fields ?? {} });
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

export function createPlatformService(db: Db) {
  /**
   * The roles a member holds: their `role_members` rows, or — when they have none at all — the
   * protected system role their account names (an active `users.role` super → super, team →
   * team). Boot and `platform bootstrap` write those bindings, so this only covers the window
   * before the next sync (an account row copied by hand, a role set in SQL), where the member
   * was refused everything. A member moved to a narrower role still has that role's row, so the
   * fallback never widens them.
   */
  async function memberRoleIds(userId: string): Promise<string[]> {
    const bound = await db
      .select({ role_id: platformRoleBindings.role_id })
      .from(platformRoleBindings)
      .where(eq(platformRoleBindings.user_id, userId));
    if (bound.length > 0) return bound.map((row) => row.role_id);
    const system = await db
      .select({ role_id: platformRoles.id })
      .from(users)
      .innerJoin(platformRoles, and(eq(platformRoles.code, users.role), eq(platformRoles.system_protected, true)))
      .where(and(eq(users.id, userId), eq(users.status, 'active')));
    return system.map((row) => row.role_id);
  }

  const service = {
    async createRole(input: PlatformRoleInput): Promise<PlatformRoleRow> {
      const now = nowIso();
      const rows = await db
        .insert(platformRoles)
        .values({
          id: newId('role'),
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
          id: newId('role'),
          code: input.code,
          name: input.name,
          description: input.description ?? '',
          system_protected: input.system_protected ?? false,
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: platformRoles.code,
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

    async getRoleByCode(_orgId: string, code: string): Promise<PlatformRoleRow | undefined> {
      const rows = await db.select().from(platformRoles).where(eq(platformRoles.code, code)).limit(1);
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

    async listRoles(_orgId?: string): Promise<PlatformRoleRow[]> {
      return db.select().from(platformRoles).orderBy(platformRoles.code);
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
        .where(inArray(platformRoles.code, ['super', 'team']));
      if (systemRoles.length === 0) return;
      const target = systemRoles.find((item) => item.code === role);
      if (!target) throw new Error(`Platform system role "${role}" has not been bootstrapped`);

      await db.transaction(async (tx) => {
        // Concurrent first-admin boots may both repair this binding. Serialize
        // by user, and never restore a stale role after an account was changed.
        const [current] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId)).for('update');
        if (!current || current.role !== role) return;
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

    async getAuthorizationSnapshot(userId: string, _orgId?: string): Promise<PlatformAuthorizationSnapshot> {
      const roleIds = await memberRoleIds(userId);
      if (roleIds.length === 0) return { roleGrants: [] };
      const roleRows = await db
        .select({
          role_id: platformRoleCapabilities.role_id,
          capability: platformRoleCapabilities.capability,
        })
        .from(platformRoleCapabilities)
        .innerJoin(platformRoles, eq(platformRoles.id, platformRoleCapabilities.role_id))
        .where(and(inArray(platformRoleCapabilities.role_id, roleIds), eq(platformRoles.status, 'active')));

      return {
        roleGrants: roleRows.map((row) => ({
          source: 'role',
          roleId: row.role_id,
          capability: row.capability,
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
          id: newId('rolePolicy'),
          role_id: roleId,
          app_id: input.app_id,
          module_id: input.module_id,
          entity_id: input.entity_id,
          scopes: [...policy.scopes],
          field_policies: { ...policy.fields },
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
            scopes: [...policy.scopes],
            field_policies: { ...policy.fields },
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

    async getEntityPolicySnapshot(input: {
      /** Ignored (single organization). */
      orgId?: string;
      userId: string;
      appId: string;
      entityId: string;
    }): Promise<PlatformEntityPolicySnapshot> {
      const roleIds = await memberRoleIds(input.userId);
      if (roleIds.length === 0) return { rolePolicies: [] };
      const roleRows = await db
        .select({
          scopes: platformRoleEntityPolicies.scopes,
          field_policies: platformRoleEntityPolicies.field_policies,
        })
        .from(platformRoleEntityPolicies)
        .innerJoin(platformRoles, eq(platformRoles.id, platformRoleEntityPolicies.role_id))
        .where(
          and(
            inArray(platformRoleEntityPolicies.role_id, roleIds),
            eq(platformRoles.status, 'active'),
            eq(platformRoleEntityPolicies.app_id, input.appId),
            eq(platformRoleEntityPolicies.entity_id, input.entityId),
          ),
        );
      return {
        rolePolicies: roleRows.map((row) => parseStoredEntityPolicy(row.scopes, row.field_policies)),
      };
    },

    async recordAudit(event: PlatformAuditEvent): Promise<PlatformAuditEventRow> {
      assertDiscriminator('auditApps', event.resource.appId);
      const rows = await db
        .insert(platformAuditEvents)
        .values({
          id: event.id ?? newId('auditEvent'),
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
          summary: { ...(event.summary ?? {}) },
          created_at: event.createdAt ?? nowIso(),
        })
        .returning();
      return rows[0]!;
    },

    async listAuditEvents(_orgId: string, limit = 100): Promise<PlatformAuditEventRow[]> {
      return db
        .select()
        .from(platformAuditEvents)
        .orderBy(desc(platformAuditEvents.created_at))
        .limit(Math.min(Math.max(limit, 1), 500));
    },

    async listAuditEventsForApp(_orgId: string, appId: string, limit = 100): Promise<PlatformAuditEventRow[]> {
      return db
        .select()
        .from(platformAuditEvents)
        .where(eq(platformAuditEvents.app_id, appId))
        .orderBy(desc(platformAuditEvents.created_at))
        .limit(Math.min(Math.max(limit, 1), 500));
    },
  };
  return service;
}

export type PlatformService = ReturnType<typeof createPlatformService>;
