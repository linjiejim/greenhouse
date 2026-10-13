import { sql } from 'drizzle-orm';
import { index, integer, pgTable, primaryKey, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, updatedAt } from './_columns.js';

export const MEMBER_ROLES = ['admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const MEMBER_STATUSES = ['invited', 'active', 'reset_required', 'disabled'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export const MEMBER_MODULES = ['knowledge', 'tables', 'apps', 'computer'] as const;
export type MemberModule = (typeof MEMBER_MODULES)[number];
export type MemberModules = Partial<Record<MemberModule, boolean>>;
/** What a notification is about, as the member's delivery settings group it. */
export const NOTIFICATION_CATEGORIES = ['needs_you', 'replies', 'runs', 'other'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
/** Where a notification goes besides the in-app center, which always has it. */
export const DELIVERY_CHANNELS = ['email', 'feishu', 'wecom', 'push'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export type NotificationSettings = {
  /** Per category, the channels that deliver it; what is not set follows the defaults. */
  categories?: Partial<Record<NotificationCategory, Partial<Record<DeliveryChannel, boolean>>>>;
  /** Push and channel messages name their subject only when on; content of sensitive categories never leaves. */
  previews?: boolean;
};

export const members = pgTable(
  'members',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    avatarFileId: text('avatar_file_id'),
    role: text('role', { enum: MEMBER_ROLES }).notNull().default('member'),
    status: text('status', { enum: MEMBER_STATUSES }).notNull().default('invited'),
    passwordHash: text('password_hash'),
    /** Bumped on password change or disable; tokens and push devices compare it. */
    authVersion: integer('auth_version').notNull().default(0),
    locale: text('locale').notNull().default('zh'),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    theme: text('theme', { enum: ['system', 'light', 'dark'] })
      .notNull()
      .default('system'),
    /** "About me": every Agent of this member may read it. */
    about: text('about').notNull().default(''),
    modules: json<MemberModules>('modules', {}),
    notificationSettings: json<NotificationSettings>('notification_settings', {}),
    lastLoginAt: at('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('members_email_key').on(t.email), index('members_role_idx').on(t.role)],
);

export const groups = pgTable(
  'groups',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdBy: text('created_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('groups_name_key').on(t.name)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.memberId] }), index('group_members_member_idx').on(t.memberId)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    authVersion: integer('auth_version').notNull(),
    client: text('client', { enum: ['web', 'ios', 'android', 'extension', 'desktop', 'cli'] })
      .notNull()
      .default('web'),
    expiresAt: at('expires_at').notNull(),
    lastUsedAt: at('last_used_at'),
    /** Single use: set when rotated or revoked. */
    consumedAt: at('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('refresh_tokens_hash_key').on(t.tokenHash), index('refresh_tokens_member_idx').on(t.memberId)],
);

export const authLinks = pgTable(
  'auth_links',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['activate', 'reset'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    issuedAuthVersion: integer('issued_auth_version').notNull(),
    expiresAt: at('expires_at').notNull(),
    consumedAt: at('consumed_at'),
    revokedAt: at('revoked_at'),
    deliveryStatus: text('delivery_status', { enum: ['shown', 'emailed', 'failed'] })
      .notNull()
      .default('shown'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_links_hash_key').on(t.tokenHash),
    // At most one live link per member.
    uniqueIndex('auth_links_live_key')
      .on(t.memberId)
      .where(sql`${t.consumedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
);

export const SHARE_RESOURCES = ['folder', 'doc', 'file', 'base', 'form', 'app', 'agent'] as const;
export type ShareResource = (typeof SHARE_RESOURCES)[number];
export const SHARE_PRINCIPALS = ['member', 'group', 'workspace'] as const;
export type SharePrincipal = (typeof SHARE_PRINCIPALS)[number];

/** The only sharing table: every grant beyond an object's owner is a row here. */
export const shares = pgTable(
  'shares',
  {
    id: id(),
    resourceType: text('resource_type', { enum: SHARE_RESOURCES }).notNull(),
    resourceId: text('resource_id').notNull(),
    principalType: text('principal_type', { enum: SHARE_PRINCIPALS }).notNull(),
    /** Null when the principal is the whole workspace. */
    principalId: text('principal_id'),
    role: text('role').notNull(),
    customRoleId: text('custom_role_id'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('shares_grant_key').on(t.resourceType, t.resourceId, t.principalType, t.principalId).nullsNotDistinct(),
    index('shares_principal_idx').on(t.principalType, t.principalId),
  ],
);

/** A member's own pins (conversations, bases, apps, docs). */
export const pins = pgTable(
  'pins',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    targetType: text('target_type', { enum: ['conversation', 'base', 'app', 'doc'] }).notNull(),
    targetId: text('target_id').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.targetType, t.targetId] })],
);

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type AuthLink = typeof authLinks.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type Pin = typeof pins.$inferSelect;
