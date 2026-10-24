/**
 * Platform control-plane service.
 *
 * Persistence for Kernel v2 roles (capabilities + entity policies + members)
 * and the immutable action audit. Single organization: every `orgId`
 * parameter is kept for the kernel's interface and ignored. Per-user
 * capability / entity-policy overrides and stored app releases were retired in
 * 3.0 — precedence is role allow > default deny, and the manifest golden-hash
 * test guards releases. The Home workbench layout lives in
 * `users.preferences.workbench`; the workbench methods here are its facade.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  DataScope,
  EntityPolicy,
  FieldPolicy,
  PlatformAuditEvent,
  RoleCapabilityGrant,
  UserCapabilityOverride,
  UserEntityPolicyOverride,
} from '@greenhouse/platform-kernel';
import { isCapabilityPattern, isStableId, validateEntityPolicy } from '@greenhouse/platform-kernel';
import { DEFAULT_WORKBENCH_CONFIG, parseWorkbenchConfig, type WorkbenchConfig } from '@greenhouse/types/workbench';
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
  userOverrides: UserCapabilityOverride[];
}

export interface PlatformEntityPolicySnapshot {
  rolePolicies: EntityPolicy[];
  userOverride?: UserEntityPolicyOverride;
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
      const roleRows = await db
        .select({
          role_id: platformRoleCapabilities.role_id,
          capability: platformRoleCapabilities.capability,
        })
        .from(platformRoleBindings)
        .innerJoin(platformRoles, eq(platformRoles.id, platformRoleBindings.role_id))
        .innerJoin(platformRoleCapabilities, eq(platformRoleCapabilities.role_id, platformRoles.id))
        .where(and(eq(platformRoleBindings.user_id, userId), eq(platformRoles.status, 'active')));

      return {
        roleGrants: roleRows.map((row) => ({
          source: 'role',
          roleId: row.role_id,
          capability: row.capability,
        })),
        userOverrides: [],
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
            eq(platformRoles.status, 'active'),
            eq(platformRoleEntityPolicies.app_id, input.appId),
            eq(platformRoleEntityPolicies.entity_id, input.entityId),
          ),
        );
      return {
        rolePolicies: roleRows.map((row) => parseStoredEntityPolicy(row.scopes, row.field_policies)),
      };
    },

    async getUserWorkbenchPreferences(_orgId: string, userId: string): Promise<WorkbenchConfig> {
      const rows = await db.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).limit(1);
      const stored = rows[0]?.preferences?.workbench;
      return stored ? parseWorkbenchConfig(stored) : { ...DEFAULT_WORKBENCH_CONFIG };
    },

    async setUserWorkbenchPreferences(
      _orgId: string,
      userId: string,
      preferences: WorkbenchConfig,
    ): Promise<WorkbenchConfig> {
      return service.mutateUserWorkbenchPreferences(_orgId, userId, () => preferences);
    },

    /**
     * Serialize a read-modify-write of one user's workbench layout. Agent
     * calls, browser tabs and the Home editor can all update it; the user row
     * lock makes concurrent writers queue instead of dropping each other's
     * change (other preference keys are preserved).
     */
    async mutateUserWorkbenchPreferences(
      _orgId: string,
      userId: string,
      mutate: (current: WorkbenchConfig) => WorkbenchConfig,
    ): Promise<WorkbenchConfig> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ preferences: users.preferences })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        const stored = rows[0]?.preferences ?? {};
        const current = stored.workbench ? parseWorkbenchConfig(stored.workbench) : { ...DEFAULT_WORKBENCH_CONFIG };
        const normalized = parseWorkbenchConfig(mutate(current));
        if (rows[0]) {
          await tx
            .update(users)
            .set({ preferences: { ...stored, workbench: normalized }, updated_at: nowIso() })
            .where(eq(users.id, userId));
        }
        return normalized;
      });
    },

    async recordAudit(event: PlatformAuditEvent): Promise<PlatformAuditEventRow> {
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
