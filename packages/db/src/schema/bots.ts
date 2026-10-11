/**
 * Drizzle schema — Bots: personal assistants with a shared computer (PostgreSQL).
 *
 * Tables: bots, bot_versions, bot_conversations, bot_conversation_members, bot_shared_notes,
 *         bot_requests, bot_inbox, bot_computers, vault_items, vault_access_log
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md.
 *
 * - A Bot is THE agent identity (docs/specs/20261007-agent-bot-convergence.md):
 *   a user-owned row (name, role, instructions, avatar, model, optional tool
 *   filter) that Chat sessions, automations and the Bots engine all run as.
 *   Every create / edit appends an immutable `bot_versions` manifest (what a
 *   pinned `bot:<id>@<v>` reference resolves to; the `self` proposal card and
 *   the drawer's history read it). A Bot is private to its owner: there is no
 *   sharing, review or clone (the retired `custom_profiles` governance went
 *   with migration 0014). `legacy_custom_id` keeps stored `custom:<id>[@v]`
 *   references resolvable.
 * - A conversation is a `sessions` row (channel `bots`) plus one
 *   `bot_conversations` row. A direct conversation belongs to exactly one owner
 *   Bot; inviting another Bot (the member, or a Bot's `team.add`) adds a guest
 *   member. Group conversations (`kind = 'group'`) were retired on 2026-10-09:
 *   the rows that exist are read-only history (migration 0015).
 * - `bot_requests` holds every "needs you" item (takeover, secure sign-in,
 *   approval, Bot-creation and task-start confirmations); cards bind to its id.
 * - `bot_inbox` is the durable queue behind the single-writer rule: only the
 *   holder of a conversation's ChatRun appends to its transcript, everything
 *   else queues here and is drained between Bot turns.
 * - `bot_computers` is the DB-authoritative lifecycle of each member's computer
 *   (container + volume on the org's Docker host); two blue/green API slots act
 *   on it through compare-and-set on `version`.
 * - Vault secrets are AES-256-GCM with AAD `vault:<user_id>:<item_id>:<field>`
 *   and are never returned by any read path.
 */

import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './user.js';
import { sessions } from './session.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

// ─── bots ─────────────────────────────────────────────────

export const bots = pgTable(
  'bots',
  {
    /** `bot_<hex>` — system-assigned. */
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Normalised name (NFKC, lower-case) — uniqueness key among a user's active Bots. */
    name_key: text('name_key').notNull(),
    /** One-line job title shown under the name ("Researcher"). */
    role: text('role').notNull().default(''),
    /** Long-lived rules / personality (the Bot's description). Sanitised before prompt injection. */
    instructions: text('instructions').notNull().default(''),
    /** Plant avatar JSON (`avatarConfigSchema`): `plant`, the nearest legacy `color`, the mood as `faceStyle`. */
    avatar: text('avatar').notNull().default('{}'),
    /** Model registry id; an unreachable model falls back to the deployment default. */
    model_id: text('model_id'),
    template_key: text('template_key'),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    /** One line on what the Bot is for (gallery, picker, `@` list). */
    description: text('description').notNull().default(''),
    /**
     * JSON array of tool ids the Bot may use, or NULL = the owner's whole allowed
     * set (what the built-in preset runs with). A list only ever narrows: it is
     * intersected with the owner's permissions at run time (resolveEffectiveTools).
     */
    tools: text('tools'),
    /**
     * JSON array of connector slugs (`mcp_servers.slug`) the Bot may reach
     * through `mcp_call`, or NULL = every connector the owner can use. Like
     * `tools` it only narrows; `[]` = none (spec 20261009-mcp-connectors D9).
     */
    connectors: text('connectors'),
    /** Per-turn step cap for Chat sessions and automations; NULL = the base preset's default. */
    max_steps: integer('max_steps'),
    // ── Versions (formerly custom_profiles) ──
    /** Latest immutable manifest (bot_versions.version) — what the owner edits and runs. */
    current_version: integer('current_version').notNull().default(1),
    /** The `custom_profiles.id` this Bot was migrated from; stored `custom:<id>[@v]` references resolve through it. */
    legacy_custom_id: integer('legacy_custom_id'),
    last_active_at: ts('last_active_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (table) => [
    index('idx_bots_user').on(table.user_id, table.status),
    uniqueIndex('uq_bots_user_name_active')
      .on(table.user_id, table.name_key)
      .where(sql`${table.status} = 'active'`),
    unique('uq_bots_legacy_custom_id').on(table.legacy_custom_id),
  ],
);

// ─── bot_versions ─────────────────────────────────────────

/**
 * Immutable executable manifests. Editing a Bot appends a row and advances
 * `bots.current_version`; there is intentionally no update / delete service.
 * `custom:<id>@<v>` references from before the convergence map onto the same
 * version numbers (the migration copied them one-to-one).
 */
export const botVersions = pgTable(
  'bot_versions',
  {
    id: serial('id').primaryKey(),
    bot_id: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    manifest_hash: text('manifest_hash').notNull(),
    change_log: text('change_log').notNull().default(''),
    name: text('name').notNull(),
    role: text('role').notNull().default(''),
    description: text('description').notNull().default(''),
    instructions: text('instructions').notNull().default(''),
    /** JSON array or NULL (= the owner's whole allowed set), as on `bots`. */
    tools: text('tools'),
    /** JSON array of connector slugs or NULL (= every connector the owner can use), as on `bots`. */
    connectors: text('connectors'),
    model_id: text('model_id'),
    max_steps: integer('max_steps'),
    /** Avatar JSON as on `bots`; hashed into `manifest_hash`, so stored values are never rewritten. */
    avatar: text('avatar').notNull().default('{}'),
    created_by: text('created_by'),
    created_at: ts('created_at').notNull(),
  },
  (table) => [
    unique('uq_bot_versions_bot_version').on(table.bot_id, table.version),
    index('idx_bot_versions_bot').on(table.bot_id),
    index('idx_bot_versions_created').on(table.created_at),
  ],
);

// ─── bot_conversations ────────────────────────────────────

export const botConversations = pgTable(
  'bot_conversations',
  {
    session_id: text('session_id')
      .primaryKey()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `group` = a retired group chat (read-only history); every new conversation is `direct`. */
    kind: text('kind', { enum: ['direct', 'group'] }).notNull(),
    /** Direct conversations only: the Bot whose DM this is (one DM per Bot). */
    owner_bot_id: text('owner_bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    /** Who answers an unaddressed message: a DM's owner (null once it is archived); a retired group's old coordinator. */
    lead_bot_id: text('lead_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    /** A retired group's title; DMs show the owner Bot's name. */
    title: text('title'),
    /** A retired group's rules (history only; no Bot reads them any more). */
    description: text('description').notNull().default(''),
    /**
     * Deprecated, always true (migration 0015): Bot-to-Bot hand-offs are always
     * allowed and nothing reads this column. Kept so old rows / clients stay valid.
     */
    allow_bot_chat: boolean('allow_bot_chat').notNull().default(true),
    /** Structured rolling summary (JSON text) covering messages up to digest_upto_seq. */
    digest: text('digest').notNull().default(''),
    digest_upto_seq: integer('digest_upto_seq').notNull().default(0),
    /** Boundary message id — an edit/delete below the boundary resets the digest. */
    digest_upto_message_id: text('digest_upto_message_id'),
    digest_updated_at: ts('digest_updated_at'),
    last_read_at: ts('last_read_at'),
    last_activity_at: ts('last_activity_at').notNull(),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (table) => [
    index('idx_bot_conversations_user').on(table.user_id, table.last_activity_at),
    uniqueIndex('uq_bot_conversations_owner_bot').on(table.owner_bot_id),
  ],
);

// ─── bot_conversation_members ─────────────────────────────

export const botConversationMembers = pgTable(
  'bot_conversation_members',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => botConversations.session_id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bot_id: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** owner = the DM's Bot; guest = invited into a DM; lead / member = a retired group's roster. */
    role: text('role', { enum: ['owner', 'lead', 'member', 'guest'] }).notNull(),
    position: integer('position').notNull().default(0),
    /** `user` or `bot:<id>`. */
    added_by: text('added_by').notNull().default('user'),
    joined_at: ts('joined_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_bot_conversation_members').on(table.session_id, table.bot_id),
    index('idx_bot_conversation_members_bot').on(table.bot_id),
  ],
);

// ─── bot_shared_notes ─────────────────────────────────────

export const botSharedNotes = pgTable(
  'bot_shared_notes',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => botConversations.session_id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** null = written by the user. */
    author_bot_id: text('author_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['open', 'done'] })
      .notNull()
      .default('open'),
    pinned: boolean('pinned').notNull().default(false),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (table) => [index('idx_bot_shared_notes_session').on(table.session_id, table.status)],
);

// ─── bot_requests ─────────────────────────────────────────

export const botRequests = pgTable(
  'bot_requests',
  {
    /** `brq_<hex>`. */
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    session_id: text('session_id')
      .notNull()
      .references(() => botConversations.session_id, { onDelete: 'cascade' }),
    bot_id: text('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    kind: text('kind', {
      enum: ['takeover', 'login', 'approval', 'bot_create', 'task_start', 'instructions_update'],
    }).notNull(),
    status: text('status', { enum: ['pending', 'resolved', 'denied', 'expired', 'canceled'] })
      .notNull()
      .default('pending'),
    /** Kind-specific, server-derived display/execution payload (JSON text). Never holds a secret. */
    payload: text('payload').notNull().default('{}'),
    /** What the decision produced (JSON text), e.g. the created Bot id. */
    result: text('result'),
    expires_at: ts('expires_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (table) => [
    index('idx_bot_requests_user_status').on(table.user_id, table.status),
    index('idx_bot_requests_session').on(table.session_id, table.status),
  ],
);

// ─── bot_inbox ────────────────────────────────────────────

export const botInbox = pgTable(
  'bot_inbox',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => botConversations.session_id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['event', 'continue', 'task_report', 'user_message'] }).notNull(),
    payload: text('payload').notNull().default('{}'),
    created_at: ts('created_at').notNull(),
    consumed_at: ts('consumed_at'),
  },
  (table) => [
    index('idx_bot_inbox_pending')
      .on(table.session_id, table.id)
      .where(sql`${table.consumed_at} IS NULL`),
  ],
);

// ─── bot_computers ────────────────────────────────────────

export const botComputers = pgTable('bot_computers', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Deployment namespace (keeps worktree/blue-green deployments apart on one daemon). */
  namespace: text('namespace').notNull(),
  container_name: text('container_name').notNull(),
  volume_name: text('volume_name').notNull(),
  state: text('state', { enum: ['absent', 'starting', 'running', 'stopping', 'error'] })
    .notNull()
    .default('absent'),
  /** Machine-readable reason for `error` (oom, exited, start_failed…) or the last stop (idle, lru…). */
  state_reason: text('state_reason'),
  /** Compare-and-set counter for every lifecycle transition. */
  version: integer('version').notNull().default(0),
  /** Who drives the screen and input right now. */
  lease_controller: text('lease_controller', { enum: ['bot', 'user'] })
    .notNull()
    .default('bot'),
  /** Bumped on every lease change; Bot observations taken under an older epoch are discarded. */
  lease_epoch: integer('lease_epoch').notNull().default(0),
  lease_since: ts('lease_since'),
  /** Refreshed every ~20 s by whichever API slot holds a live viewer socket. */
  viewer_heartbeat_at: ts('viewer_heartbeat_at'),
  last_active_at: ts('last_active_at').notNull(),
  last_started_at: ts('last_started_at'),
  image_id: text('image_id'),
  /** Last measured size of the home volume, bytes. */
  disk_bytes: bigint('disk_bytes', { mode: 'number' }),
  disk_measured_at: ts('disk_measured_at'),
  /** The member's own IANA timezone for the computer; null = the deployment default. Applied at the next start. */
  timezone: text('timezone'),
  created_at: ts('created_at').notNull(),
  updated_at: ts('updated_at').notNull(),
});

// ─── bot_process_watches ──────────────────────────────────

/**
 * A background process (gh-jobs) a Bot started on the member's computer and wants to hear
 * about when it ends: the computer's poller (apps/api …/computer/process-watches.ts) wakes
 * that Bot in that conversation once. Claimed with a conditional update (`watching` → …),
 * so of several API processes exactly one delivers the wake-up.
 */
export const botProcessWatches = pgTable(
  'bot_process_watches',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    session_id: text('session_id')
      .notNull()
      .references(() => botConversations.session_id, { onDelete: 'cascade' }),
    bot_id: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The gh-jobs id (`j` + 8 hex). */
    job_id: text('job_id').notNull(),
    /** Its label in the process list, for the wake-up note. */
    name: text('name').notNull(),
    /** watching → notified (the Bot was woken) or gone (the computer was wiped, the watch expired). */
    status: text('status', { enum: ['watching', 'notified', 'gone'] })
      .notNull()
      .default('watching'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_bot_process_watches_job').on(table.user_id, table.job_id),
    index('idx_bot_process_watches_watching')
      .on(table.user_id)
      .where(sql`${table.status} = 'watching'`),
  ],
);

// ─── bot_computer_backups ─────────────────────────────────

/**
 * An encrypted copy of a member's computer home (both uids) in the deployment's own
 * storage — local disk or an S3 bucket, never the computer's provider (apps/api
 * …/computer/backups.ts). Taken as an idle computer goes to sleep (at most every
 * BOTS_COMPUTER_BACKUP_HOURS) or on an administrator's request; restored into a new
 * computer when the member's previous one is gone (deleted, another provider or driver).
 *
 * `user_id` is a logical link to users, not a foreign key: the stored objects must be
 * deleted before the row, so a member's deletion goes through the computer runtime
 * (purge with wipe), and rows whose member is gone are swept with their objects.
 * One `running` row per member at most (the partial unique index): of several API
 * processes, one takes a member's backup.
 */
export const botComputerBackups = pgTable(
  'bot_computer_backups',
  {
    /** `bkp_<hex>`. */
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    status: text('status', { enum: ['running', 'complete', 'failed'] }).notNull(),
    /** idle = before the computer went to sleep; admin = Back up now. */
    reason: text('reason', { enum: ['idle', 'admin'] }).notNull(),
    /** Where the objects are (`<prefix>` + `<user>/<id>/<agent|browser>`). */
    store: text('store', { enum: ['local', 's3'] }).notNull(),
    /** The backup's own AES-256 key, sealed with the vault key (`gv1.<key id>.…`, AAD bound to user and id). */
    key_enc: text('key_enc').notNull(),
    /** Stream format version (backup-format.ts). */
    format: integer('format').notNull().default(1),
    /** The computer it was taken from: docker | e2b, and its container or sandbox. */
    driver: text('driver').notNull(),
    source_ref: text('source_ref').notNull(),
    /** Stored size (compressed, encrypted), set when complete. */
    bytes: bigint('bytes', { mode: 'number' }),
    error: text('error'),
    /** The last time it was put into a new computer. */
    restored_at: ts('restored_at'),
    created_at: ts('created_at').notNull(),
    completed_at: ts('completed_at'),
  },
  (table) => [
    index('idx_bot_computer_backups_user').on(table.user_id, table.created_at),
    uniqueIndex('uq_bot_computer_backups_running')
      .on(table.user_id)
      .where(sql`${table.status} = 'running'`),
  ],
);

// ─── vault_items ──────────────────────────────────────────

export const vaultItems = pgTable(
  'vault_items',
  {
    /** `vlt_<hex>`. */
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** JSON array of exact origins (`https://host[:port]`) or explicit `*.host` wildcards. */
    origins: text('origins').notNull().default('[]'),
    username_enc: text('username_enc'),
    /** Masked username for display / the model (`ji***@gmail.com`). */
    username_hint: text('username_hint').notNull().default(''),
    password_enc: text('password_enc'),
    totp_enc: text('totp_enc'),
    /** ask = every fill needs an in-chat approval; auto = fill without asking. */
    policy: text('policy', { enum: ['ask', 'auto'] })
      .notNull()
      .default('ask'),
    /** JSON array of origins the user chose "always allow on this site" for. */
    always_origins: text('always_origins').notNull().default('[]'),
    last_used_at: ts('last_used_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (table) => [index('idx_vault_items_user').on(table.user_id)],
);

// ─── vault_access_log ─────────────────────────────────────

export const vaultAccessLog = pgTable(
  'vault_access_log',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    item_id: text('item_id').references(() => vaultItems.id, { onDelete: 'set null' }),
    /** Label snapshot — survives the item's deletion. */
    item_label: text('item_label').notNull(),
    bot_id: text('bot_id'),
    session_id: text('session_id'),
    origin: text('origin').notNull(),
    action: text('action', { enum: ['fill_login', 'fill_totp', 'secure_login'] }).notNull(),
    outcome: text('outcome', { enum: ['filled', 'denied', 'origin_mismatch', 'failed'] }).notNull(),
    approval: text('approval', { enum: ['auto', 'once', 'always', 'user'] }),
    created_at: ts('created_at').notNull(),
  },
  (table) => [index('idx_vault_access_log_user').on(table.user_id, table.created_at)],
);

// ─── Row types ────────────────────────────────────────────

export type BotRow = typeof bots.$inferSelect;
export type BotVersionRow = typeof botVersions.$inferSelect;
export type BotConversationRow = typeof botConversations.$inferSelect;
export type BotConversationMemberRow = typeof botConversationMembers.$inferSelect;
export type BotSharedNoteRow = typeof botSharedNotes.$inferSelect;
export type BotRequestRow = typeof botRequests.$inferSelect;
export type BotRequestKind = BotRequestRow['kind'];
export type BotRequestStatus = BotRequestRow['status'];
export type BotInboxRow = typeof botInbox.$inferSelect;
export type BotInboxKind = BotInboxRow['kind'];
export type BotComputerRow = typeof botComputers.$inferSelect;
export type BotComputerState = BotComputerRow['state'];
export type BotProcessWatchRow = typeof botProcessWatches.$inferSelect;
export type BotProcessWatchStatus = BotProcessWatchRow['status'];
export type BotComputerBackupRow = typeof botComputerBackups.$inferSelect;
export type BotComputerBackupStatus = BotComputerBackupRow['status'];
export type VaultItemRow = typeof vaultItems.$inferSelect;
export type VaultAccessLogRow = typeof vaultAccessLog.$inferSelect;
