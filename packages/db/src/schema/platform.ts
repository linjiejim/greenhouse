/**
 * Drizzle schema — My Base Kernel v2 control plane (PostgreSQL).
 *
 * Tables:
 * - platform_organizations
 * - platform_roles / platform_role_bindings
 * - platform_role_capabilities / platform_role_entity_policies
 * - platform_user_capability_overrides / platform_user_entity_policy_overrides
 * - platform_user_workbench_preferences
 * - platform_app_releases
 * - platform_audit_events
 *
 * Existing business tables are intentionally unchanged. Applications migrate
 * into this control plane one at a time.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from './user.js';

export const platformOrganizations = pgTable(
  'platform_organizations',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_platform_organizations_code').on(table.code),
    index('idx_platform_organizations_status').on(table.status),
  ],
);

export const platformRoles = pgTable(
  'platform_roles',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => platformOrganizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    system_protected: boolean('system_protected').notNull().default(false),
    created_by: text('created_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_platform_roles_org_code').on(table.org_id, table.code),
    index('idx_platform_roles_org_status').on(table.org_id, table.status),
  ],
);

export const platformRoleBindings = pgTable(
  'platform_role_bindings',
  {
    role_id: text('role_id')
      .notNull()
      .references(() => platformRoles.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assigned_by: text('assigned_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.role_id, table.user_id] }),
    index('idx_platform_role_bindings_user').on(table.user_id),
  ],
);

export const platformRoleCapabilities = pgTable(
  'platform_role_capabilities',
  {
    role_id: text('role_id')
      .notNull()
      .references(() => platformRoles.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    assigned_by: text('assigned_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.role_id, table.capability] }),
    index('idx_platform_role_capabilities_capability').on(table.capability),
  ],
);

export const platformRoleEntityPolicies = pgTable(
  'platform_role_entity_policies',
  {
    id: text('id').primaryKey(),
    role_id: text('role_id')
      .notNull()
      .references(() => platformRoles.id, { onDelete: 'cascade' }),
    app_id: text('app_id').notNull(),
    module_id: text('module_id').notNull(),
    entity_id: text('entity_id').notNull(),
    scopes: text('scopes').notNull().default('[]'),
    field_policies: text('field_policies').notNull().default('{}'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_platform_role_entity_policy').on(table.role_id, table.app_id, table.entity_id),
    index('idx_platform_role_entity_policy_resource').on(table.app_id, table.module_id, table.entity_id),
  ],
);

export const platformUserCapabilityOverrides = pgTable(
  'platform_user_capability_overrides',
  {
    org_id: text('org_id')
      .notNull()
      .references(() => platformOrganizations.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    effect: text('effect', { enum: ['allow', 'deny'] }).notNull(),
    granted_by: text('granted_by'),
    reason: text('reason'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org_id, table.user_id, table.capability] }),
    index('idx_platform_user_capability_user').on(table.user_id, table.org_id),
    index('idx_platform_user_capability_capability').on(table.capability),
  ],
);

export const platformUserEntityPolicyOverrides = pgTable(
  'platform_user_entity_policy_overrides',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => platformOrganizations.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    app_id: text('app_id').notNull(),
    module_id: text('module_id').notNull(),
    entity_id: text('entity_id').notNull(),
    effect: text('effect', { enum: ['allow', 'deny'] }).notNull(),
    scopes: text('scopes').notNull().default('[]'),
    field_policies: text('field_policies').notNull().default('{}'),
    granted_by: text('granted_by'),
    reason: text('reason'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_platform_user_entity_policy').on(table.org_id, table.user_id, table.app_id, table.entity_id),
    index('idx_platform_user_entity_policy_resource').on(table.app_id, table.module_id, table.entity_id),
  ],
);

export const platformUserWorkbenchPreferences = pgTable(
  'platform_user_workbench_preferences',
  {
    org_id: text('org_id')
      .notNull()
      .references(() => platformOrganizations.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    preferences: text('preferences').notNull().default('{}'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org_id, table.user_id] }),
    index('idx_platform_workbench_preferences_user').on(table.user_id),
  ],
);

export const platformAppReleases = pgTable(
  'platform_app_releases',
  {
    id: text('id').primaryKey(),
    app_id: text('app_id').notNull(),
    version: text('version').notNull(),
    status: text('status', { enum: ['draft', 'active', 'retired'] })
      .notNull()
      .default('draft'),
    manifest: text('manifest').notNull(),
    manifest_hash: text('manifest_hash').notNull(),
    git_commit: text('git_commit'),
    created_by: text('created_by'),
    activated_at: timestamp('activated_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_platform_app_releases_version').on(table.app_id, table.version),
    uniqueIndex('uq_platform_app_releases_active')
      .on(table.app_id)
      .where(sql`${table.status} = 'active'`),
    index('idx_platform_app_releases_status').on(table.app_id, table.status),
  ],
);

export const platformAuditEvents = pgTable(
  'platform_audit_events',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id').notNull(),
    actor_id: text('actor_id').notNull(),
    actor_type: text('actor_type', { enum: ['human', 'agent', 'service', 'system', 'migration'] }).notNull(),
    on_behalf_of_user_id: text('on_behalf_of_user_id'),
    client_id: text('client_id'),
    request_id: text('request_id').notNull(),
    app_id: text('app_id').notNull(),
    module_id: text('module_id'),
    entity_id: text('entity_id'),
    record_id: text('record_id'),
    action_id: text('action_id').notNull(),
    capability: text('capability').notNull(),
    result: text('result', { enum: ['success', 'denied', 'error'] }).notNull(),
    summary: text('summary').notNull().default('{}'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_platform_audit_org_created').on(table.org_id, table.created_at),
    index('idx_platform_audit_actor_created').on(table.actor_id, table.created_at),
    index('idx_platform_audit_resource_created').on(table.app_id, table.entity_id, table.record_id, table.created_at),
    index('idx_platform_audit_request').on(table.request_id),
  ],
);

export type PlatformOrganizationRow = typeof platformOrganizations.$inferSelect;
export type PlatformRoleRow = typeof platformRoles.$inferSelect;
export type PlatformRoleStatus = PlatformRoleRow['status'];
export type PlatformRoleBindingRow = typeof platformRoleBindings.$inferSelect;
export type PlatformRoleCapabilityRow = typeof platformRoleCapabilities.$inferSelect;
export type PlatformRoleEntityPolicyRow = typeof platformRoleEntityPolicies.$inferSelect;
export type PlatformUserCapabilityOverrideRow = typeof platformUserCapabilityOverrides.$inferSelect;
export type PlatformCapabilityEffect = PlatformUserCapabilityOverrideRow['effect'];
export type PlatformUserEntityPolicyOverrideRow = typeof platformUserEntityPolicyOverrides.$inferSelect;
export type PlatformUserWorkbenchPreferencesRow = typeof platformUserWorkbenchPreferences.$inferSelect;
export type PlatformAppReleaseRow = typeof platformAppReleases.$inferSelect;
export type PlatformAppReleaseStatus = PlatformAppReleaseRow['status'];
export type PlatformAuditEventRow = typeof platformAuditEvents.$inferSelect;
