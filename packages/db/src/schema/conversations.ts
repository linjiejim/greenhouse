import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, jsonOrNull, updatedAt } from './_columns.js';
import { agents } from './agents.js';
import { members } from './identity.js';

export const CONVERSATION_KINDS = ['main', 'direct', 'chat', 'room'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    kind: text('kind', { enum: CONVERSATION_KINDS }).notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** The Agent that answers; null for rooms. */
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    title: text('title').notNull().default(''),
    /** Model reference chosen for this conversation (`instance/model` or an alias). */
    model: text('model'),
    origin: text('origin').notNull().default('web'),
    /** Channel thread key (Feishu topic). */
    externalKey: text('external_key'),
    /** Page context brought by the page assistant. */
    context: jsonOrNull<Record<string, unknown>>('context'),
    readOnly: boolean('read_only').notNull().default(false),
    forkedFromMessageId: text('forked_from_message_id'),
    digest: text('digest').notNull().default(''),
    digestUptoSeq: integer('digest_upto_seq').notNull().default(0),
    lastSeq: integer('last_seq').notNull().default(0),
    lastActivityAt: at('last_activity_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('conversations_one_main_key')
      .on(t.ownerId)
      .where(sql`${t.kind} = 'main'`),
    uniqueIndex('conversations_one_direct_key')
      .on(t.ownerId, t.agentId)
      .where(sql`${t.kind} = 'direct'`),
    uniqueIndex('conversations_external_key').on(t.externalKey),
    index('conversations_owner_activity_idx').on(t.ownerId, t.lastActivityAt),
  ],
);

/** People in a conversation. Visibility is decided only by this table. */
export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] })
      .notNull()
      .default('member'),
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    mutedAt: at('muted_at'),
    archivedAt: at('archived_at'),
    addedBy: text('added_by'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.memberId] }),
    index('conversation_members_member_idx').on(t.memberId),
  ],
);

/** Agents present in a conversation besides its own (rooms, Agents pulled in). */
export const conversationAgents = pgTable(
  'conversation_agents',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    addedBy: text('added_by'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.agentId] })],
);

export type MessageStep = { tool: string; summary: string; status: 'done' | 'failed'; durationMs?: number };
export type MessageCitation = { kind: string; id: string; title: string; url?: string };

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Assigned under the conversation row lock; the order of the transcript. */
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'event'] }).notNull(),
    authorMemberId: text('author_member_id').references(() => members.id, { onDelete: 'set null' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    content: text('content').notNull().default(''),
    blocks: json<unknown[]>('blocks', []),
    attachments: json<string[]>('attachments', []),
    quote: jsonOrNull<{ messageId: string; text: string }>('quote'),
    mentions: json<string[]>('mentions', []),
    skill: jsonOrNull<{ skillId: string; variables?: Record<string, string> }>('skill'),
    /** The rich blocks the sender's screen draws; null when it did not say (the defaults apply). */
    richBlocks: jsonOrNull<string[]>('rich_blocks'),
    citations: json<MessageCitation[]>('citations', []),
    steps: json<MessageStep[]>('steps', []),
    reasoning: text('reasoning'),
    event: jsonOrNull<{ type: string; [key: string]: unknown }>('event'),
    runId: text('run_id'),
    status: text('status', { enum: ['complete', 'streaming', 'stopped', 'failed'] })
      .notNull()
      .default('complete'),
    editedAt: at('edited_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('messages_seq_key').on(t.conversationId, t.seq)],
);

export const messageFeedback = pgTable(
  'message_feedback',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    comment: text('comment').notNull().default(''),
    agentId: text('agent_id'),
    agentVersion: integer('agent_version'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.memberId] }), index('message_feedback_agent_idx').on(t.agentId)],
);

export const RECEIPT_STATUSES = ['queued', 'processing', 'answered', 'skipped', 'failed', 'canceled'] as const;

export const messageReceipts = pgTable(
  'message_receipts',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status', { enum: RECEIPT_STATUSES }).notNull().default('queued'),
    processedAt: at('processed_at'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.agentId] })],
);

export const conversationNotes = pgTable(
  'conversation_notes',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    authorMemberId: text('author_member_id'),
    authorAgentId: text('author_agent_id'),
    status: text('status', { enum: ['open', 'done'] })
      .notNull()
      .default('open'),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('conversation_notes_conversation_idx').on(t.conversationId)],
);

/** Single-writer queue: what arrives while a turn runs waits here for the engine. */
export const conversationInbox = pgTable(
  'conversation_inbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['event', 'continue', 'run_report', 'message', 'mention', 'handback'] }).notNull(),
    payload: json<Record<string, unknown>>('payload', {}),
    consumedAt: at('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('conversation_inbox_pending_idx')
      .on(t.conversationId, t.id)
      .where(sql`${t.consumedAt} IS NULL`),
  ],
);

export const handoffs = pgTable(
  'handoffs',
  {
    id: id(),
    /** The member whose rights the target Agent works with. */
    requestedBy: text('requested_by')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    sourceConversationId: text('source_conversation_id').notNull(),
    sourceAgentId: text('source_agent_id').notNull(),
    targetConversationId: text('target_conversation_id').notNull(),
    targetAgentId: text('target_agent_id').notNull(),
    runId: text('run_id'),
    chainKey: text('chain_key').notNull(),
    path: json<string[]>('path', []),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status', { enum: ['pending', 'running', 'replied', 'failed', 'canceled'] })
      .notNull()
      .default('pending'),
    reply: text('reply'),
    returnedAt: at('returned_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('handoffs_dedupe_key').on(t.dedupeKey), index('handoffs_chain_idx').on(t.chainKey)],
);

export const REQUEST_KINDS = ['approval', 'login', 'takeover', 'question', 'proposal'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'answered',
  'handed_back',
  'expired',
  'canceled',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** "Needs you": the one request model. Settles once, by compare-and-set from pending. */
export const requests = pgTable(
  'requests',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: REQUEST_KINDS }).notNull(),
    /** What is being decided, e.g. tool_write, agent_create, instructions_update, run_start. */
    subject: text('subject').notNull(),
    status: text('status', { enum: REQUEST_STATUSES }).notNull().default('pending'),
    conversationId: text('conversation_id'),
    runId: text('run_id'),
    stepId: text('step_id'),
    agentId: text('agent_id'),
    /** Never holds secrets. */
    payload: json<Record<string, unknown>>('payload', {}),
    result: jsonOrNull<Record<string, unknown>>('result'),
    expiresAt: at('expires_at'),
    decidedBy: text('decided_by'),
    decidedAt: at('decided_at'),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('requests_member_status_idx').on(t.memberId, t.status),
    index('requests_conversation_idx').on(t.conversationId),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type ConversationMember = typeof conversationMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageReceipt = typeof messageReceipts.$inferSelect;
export type ConversationNote = typeof conversationNotes.$inferSelect;
export type InboxItem = typeof conversationInbox.$inferSelect;
export type Handoff = typeof handoffs.$inferSelect;
export type NeedsYouRequest = typeof requests.$inferSelect;
