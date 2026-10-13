import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, updatedAt } from './_columns.js';
import { members } from './identity.js';

export type AgentAvatar = {
  plant?: string;
  mood?: string;
  tint?: string;
  [key: string]: unknown;
};
export type AgentPublication = {
  /** Knowledge folders the public Agent may read with its owner's rights. */
  folderIds?: string[];
  computer?: boolean;
  /** Replies per member per day; 0 means unlimited. */
  dailyCap?: number;
};

export const agents = pgTable(
  'agents',
  {
    id: id(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** Every member has exactly one main Agent; its handle is `main`, whatever its name. */
    isMain: boolean('is_main').notNull().default(false),
    name: text('name').notNull(),
    /** Lower-cased, trimmed name used for uniqueness and @mentions. */
    nameKey: text('name_key').notNull(),
    role: text('role').notNull().default(''),
    avatar: json<AgentAvatar>('avatar', {}),
    currentVersion: integer('current_version').notNull().default(1),
    visibility: text('visibility', { enum: ['private', 'public'] })
      .notNull()
      .default('private'),
    publishedVersion: integer('published_version'),
    /** Set by an admin to stop a public Agent. */
    pausedAt: at('paused_at'),
    publication: json<AgentPublication>('publication', {}),
    templateKey: text('template_key'),
    lastActiveAt: at('last_active_at'),
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agents_one_main_key')
      .on(t.ownerId)
      .where(sql`${t.isMain}`),
    uniqueIndex('agents_owner_name_key')
      .on(t.ownerId, t.nameKey)
      .where(sql`${t.archivedAt} IS NULL`),
    index('agents_owner_idx').on(t.ownerId),
    index('agents_visibility_idx').on(t.visibility),
  ],
);

/** Immutable manifest: every save appends a version. */
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** Canonical JSON text, stored as hashed. */
    manifest: text('manifest').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    changeNote: text('change_note').notNull().default(''),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_versions_version_key').on(t.agentId, t.version)],
);

export const MEMORY_STATUSES = ['active', 'dormant', 'archived', 'superseded'] as const;

export const agentMemories = pgTable(
  'agent_memories',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** Only the title enters the prompt; the content is read on demand. */
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    category: text('category').notNull().default('fact'),
    status: text('status', { enum: MEMORY_STATUSES }).notNull().default('active'),
    pinned: boolean('pinned').notNull().default(false),
    source: text('source').notNull().default('agent'),
    supersededBy: text('superseded_by'),
    sourceConversationId: text('source_conversation_id'),
    lastUsedAt: at('last_used_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('agent_memories_agent_idx').on(t.agentId, t.status)],
);

export const COMPUTER_STATES = ['stopped', 'starting', 'running', 'failed'] as const;
export type ComputerState = (typeof COMPUTER_STATES)[number];

/** Each Agent has one computer, a sandbox with a home that outlives restarts. */
export const agentComputers = pgTable(
  'agent_computers',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    /** The sandbox provider instance that runs it. */
    providerId: text('provider_id').notNull(),
    /** The adapter's own name for it (container, sandbox id). */
    sandboxRef: text('sandbox_ref').notNull(),
    state: text('state', { enum: COMPUTER_STATES }).notNull().default('stopped'),
    stateReason: text('state_reason'),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    version: integer('version').notNull().default(0),
    lastActiveAt: at('last_active_at'),
    lastStartedAt: at('last_started_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('agent_computers_agent_key').on(t.agentId), index('agent_computers_state_idx').on(t.state)],
);

/** A background process on a computer that wakes its Agent when it ends. */
export const computerWatches = pgTable(
  'computer_watches',
  {
    id: id(),
    computerId: text('computer_id')
      .notNull()
      .references(() => agentComputers.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    memberId: text('member_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    /** The process id the computer gave it. */
    jobRef: text('job_ref').notNull(),
    name: text('name').notNull().default(''),
    status: text('status', { enum: ['watching', 'notified', 'gone'] })
      .notNull()
      .default('watching'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('computer_watches_job_key').on(t.computerId, t.jobRef),
    index('computer_watches_status_idx').on(t.status),
  ],
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type AgentComputer = typeof agentComputers.$inferSelect;
export type ComputerWatch = typeof computerWatches.$inferSelect;
