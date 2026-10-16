import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, updatedAt } from './_columns.js';
import { agents } from './agents.js';

/**
 * Agent 邮箱 (AGNT-30): every Agent's own address, `<local_part>@<the workspace's Agent domain>`.
 * The domain is one setting of the `mail` capability, so changing it moves every address; the local
 * part is unique in the workspace. Made the first time the owner looks at it.
 */
export const agentMailboxes = pgTable(
  'agent_mailboxes',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Lower case: `greeny-k3v9`. */
    localPart: text('local_part').notNull(),
    /** Mail from active workspace members wakes the Agent; the owner's always does. */
    allowMembers: boolean('allow_members').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agent_mailboxes_agent_key').on(t.agentId),
    uniqueIndex('agent_mailboxes_local_part_key').on(t.localPart),
  ],
);

/** Addresses the owner let in besides themself and the members: their mail wakes the Agent. */
export const mailSenders = pgTable(
  'mail_senders',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Lower case. */
    address: text('address').notNull(),
    addedBy: text('added_by'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.address] })],
);

export const MAIL_DIRECTIONS = ['in', 'out'] as const;
export const MAIL_STATUSES = ['screened', 'delivered', 'sending', 'sent', 'failed'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];
export const MAIL_SCREEN_REASONS = ['sender', 'unverified', 'public_agent', 'archived'] as const;
export type MailScreenReason = (typeof MAIL_SCREEN_REASONS)[number];

export type StoredMailAddress = { address: string; name?: string };
export type StoredMailAttachment = {
  fileId: string | null;
  name: string;
  contentType: string;
  size: number;
  inline: boolean;
  contentId?: string;
  skipped?: 'too_large' | 'too_many' | 'unavailable';
};
export type StoredMailAuth = { spf: string; dkim: string; dmarc: string };

/**
 * An Agent's mail, received and sent. Incoming mail is untrusted: its HTML and attachments are
 * files (purpose `mail`, owned by the Agent's owner) in the storage service, its text is kept
 * bounded for reading and search. Received mail dedupes on the vendor's id per instance and Agent.
 */
export const mailMessages = pgTable(
  'mail_messages',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** The owner's member id when it was received or sent (logical: files and turns act as them). */
    ownerId: text('owner_id').notNull(),
    direction: text('direction', { enum: MAIL_DIRECTIONS }).notNull(),
    status: text('status', { enum: MAIL_STATUSES }).notNull(),
    screenReason: text('screen_reason', { enum: MAIL_SCREEN_REASONS }),
    /** The mail instance that received or sent it, and the vendor's id for it there. */
    providerId: text('provider_id'),
    providerMessageId: text('provider_message_id'),
    /** RFC 5322 threading, angle brackets included. */
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    references: json<string[]>('references', []),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    to: json<StoredMailAddress[]>('to', []),
    cc: json<StoredMailAddress[]>('cc', []),
    replyTo: json<StoredMailAddress[]>('reply_to', []),
    subject: text('subject').notNull().default(''),
    text: text('text').notNull().default(''),
    /** The HTML body as received, a file in the storage service; null for none. */
    htmlFileId: text('html_file_id'),
    attachments: json<StoredMailAttachment[]>('attachments', []),
    auth: json<StoredMailAuth>('auth', { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' }),
    /** SPF, DKIM or DMARC passed, aligned with the From address (decided when it arrived). */
    verified: boolean('verified').notNull().default(false),
    /** Where its card is: the Agent's thread (the main thread for the main Agent). */
    conversationId: text('conversation_id'),
    /** Outgoing: the approved call that sent it. */
    runId: text('run_id'),
    error: text('error'),
    /** When it woke the Agent; null when it did not (screened, or past the daily wake limit). */
    wokeAt: at('woke_at'),
    /** Received or sent. */
    at: at('at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mail_messages_received_key')
      .on(t.agentId, t.providerId, t.providerMessageId)
      .where(sql`${t.direction} = 'in'`),
    index('mail_messages_agent_idx').on(t.agentId, t.id),
    index('mail_messages_agent_status_idx').on(t.agentId, t.status),
  ],
);

export type AgentMailbox = typeof agentMailboxes.$inferSelect;
export type MailSender = typeof mailSenders.$inferSelect;
export type MailMessageRow = typeof mailMessages.$inferSelect;
