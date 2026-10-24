/**
 * Access: roles and what they grant, plus per-member feature / tool grants.
 *
 * Tables: roles, role_members, role_capabilities, role_entity_policies, user_grants
 *
 * Single organization: there is no organizations table and no org_id. The
 * platform kernel still carries an `orgId` on ActorContext (its interface is
 * unchanged); the host passes the constant `default`.
 *
 * Precedence is role allow > default deny. Capabilities and entity policies are
 * declared by core and extension manifests; CRM evaluates role entity policies
 * (own / assigned / all + field policies) through `db.platform`.
 */

import { boolean, index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, json, oneOf, updatedAt } from './_columns.js';
import { users } from './identity.js';

export const ROLE_STATUSES = ['active', 'disabled'] as const;

export const roles = pgTable(
  'roles',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: ROLE_STATUSES }).notNull().default('active'),
    system_protected: boolean('system_protected').notNull().default(false),
    created_by: text('created_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_roles_code').on(table.code),
    index('idx_roles_status').on(table.status),
    oneOf('chk_roles_status', table.status, ROLE_STATUSES),
  ],
);

export const roleMembers = pgTable(
  'role_members',
  {
    role_id: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assigned_by: text('assigned_by'),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.role_id, table.user_id] }),
    index('idx_role_members_user').on(table.user_id),
  ],
);

export const roleCapabilities = pgTable(
  'role_capabilities',
  {
    role_id: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    assigned_by: text('assigned_by'),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.role_id, table.capability] }),
    index('idx_role_capabilities_capability').on(table.capability),
  ],
);

export const roleEntityPolicies = pgTable(
  'role_entity_policies',
  {
    id: id(),
    role_id: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    app_id: text('app_id').notNull(),
    module_id: text('module_id').notNull(),
    entity_id: text('entity_id').notNull(),
    /** `EntityScope[]` from @greenhouse/platform-kernel. */
    scopes: json<unknown[]>('scopes', []),
    /** `Record<field, FieldPolicy>` from @greenhouse/platform-kernel. */
    field_policies: json<Record<string, unknown>>('field_policies', {}),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_role_entity_policies').on(table.role_id, table.app_id, table.entity_id),
    index('idx_role_entity_policies_resource').on(table.app_id, table.module_id, table.entity_id),
  ],
);

export const USER_GRANT_KINDS = ['feature', 'tool'] as const;

/**
 * Per-member switches a super flips in Settings → Users → Permissions:
 * `kind='feature'` is a FEATURE_FLAGS key (enabled may be false = explicit
 * opt-out of a default-on flag); `kind='tool'` is an opt-in tool id (a row
 * means assigned).
 */
export const userGrants = pgTable(
  'user_grants',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: USER_GRANT_KINDS }).notNull(),
    key: text('key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: json<Record<string, unknown>>('config', {}),
    granted_by: text('granted_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.user_id, table.kind, table.key] }),
    index('idx_user_grants_key').on(table.kind, table.key),
    oneOf('chk_user_grants_kind', table.kind, USER_GRANT_KINDS),
  ],
);

export type PlatformRoleRow = typeof roles.$inferSelect;
export type PlatformRoleStatus = PlatformRoleRow['status'];
export type PlatformRoleBindingRow = typeof roleMembers.$inferSelect;
export type PlatformRoleCapabilityRow = typeof roleCapabilities.$inferSelect;
export type PlatformRoleEntityPolicyRow = typeof roleEntityPolicies.$inferSelect;
export type UserGrantRow = typeof userGrants.$inferSelect;
export type UserGrantKind = UserGrantRow['kind'];
