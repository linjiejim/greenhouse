import { z } from 'zod';
import { isoTime } from './common.js';

export const CONVERSATION_KINDS = ['main', 'direct', 'chat', 'room'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const MESSAGE_ROLES = ['user', 'assistant', 'event'] as const;
export const MESSAGE_STATUSES = ['complete', 'streaming', 'stopped', 'failed'] as const;
export const MESSAGE_MAX = 32_000;

export const conversationSchema = z.object({
  id: z.string(),
  kind: z.enum(CONVERSATION_KINDS),
  title: z.string(),
  /** The Agent that answers; null in a room. */
  agent_id: z.string().nullable(),
  /** A chat's chosen model; null follows the Agent. */
  model: z.string().nullable(),
  origin: z.string(),
  read_only: z.boolean(),
  last_seq: z.number().int(),
  /** The reader's own state. */
  last_read_seq: z.number().int(),
  unread: z.number().int(),
  pinned: z.boolean(),
  archived: z.boolean(),
  muted: z.boolean(),
  /** An Agent is answering right now. */
  working: z.boolean(),
  pending_requests: z.number().int(),
  last_activity_at: isoTime,
  created_at: isoTime,
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationMemberSchema = z.object({
  member_id: z.string(),
  role: z.enum(['owner', 'member']),
  last_read_seq: z.number().int(),
});

export const conversationDetailSchema = conversationSchema.extend({
  members: z.array(conversationMemberSchema),
  /** Agents present besides the answering one (rooms, Agents pulled in). */
  agent_ids: z.array(z.string()),
  digest: z.string(),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const conversationListQuerySchema = z.object({
  kind: z.enum(CONVERSATION_KINDS).optional(),
  q: z.string().trim().max(100).optional(),
  archived: z.enum(['true', 'false']).default('false'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const createConversationInputSchema = z.discriminatedUnion('kind', [
  /** The one Agent thread with an Agent; returns the existing one when there is one. */
  z.object({ kind: z.literal('direct'), agent_id: z.string() }),
  /** A new chat with its own context; the main Agent answers unless another is named. */
  z.object({
    kind: z.literal('chat'),
    agent_id: z.string().optional(),
    title: z.string().trim().max(120).optional(),
    model: z.string().trim().max(160).optional(),
    /** Page context brought by the page assistant. */
    context: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('room'),
    title: z.string().trim().max(120).optional(),
    member_ids: z.array(z.string()).max(50).default([]),
    agent_ids: z.array(z.string()).max(10).default([]),
  }),
]);
export type CreateConversationInput = z.input<typeof createConversationInputSchema>;

export const updateConversationInputSchema = z
  .object({
    title: z.string().trim().max(120),
    model: z.string().trim().max(160).nullable(),
    pinned: z.boolean(),
    archived: z.boolean(),
    muted: z.boolean(),
  })
  .partial();
export type UpdateConversationInput = z.infer<typeof updateConversationInputSchema>;

export const messageStepSchema = z.object({
  tool: z.string(),
  summary: z.string(),
  status: z.enum(['done', 'failed']),
  duration_ms: z.number().int().optional(),
});

export const messageSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  seq: z.number().int(),
  role: z.enum(MESSAGE_ROLES),
  author_member_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  content: z.string(),
  blocks: z.array(z.unknown()),
  attachments: z.array(z.string()),
  quote: z.object({ message_id: z.string(), text: z.string() }).nullable(),
  mentions: z.array(z.string()),
  citations: z.array(z.object({ kind: z.string(), id: z.string(), title: z.string(), url: z.string().optional() })),
  steps: z.array(messageStepSchema),
  reasoning: z.string().nullable(),
  /** What an event row records: a hand-off, a decision, someone joining. */
  event: z.record(z.string(), z.unknown()).nullable(),
  run_id: z.string().nullable(),
  status: z.enum(MESSAGE_STATUSES),
  edited_at: isoTime.nullable(),
  created_at: isoTime,
});
export type Message = z.infer<typeof messageSchema>;

/** Newest first by default; `after` catches up from a sequence number (after a reconnect). */
export const messageListQuerySchema = z.object({
  cursor: z.string().optional(),
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const sendMessageInputSchema = z.object({
  content: z.string().max(MESSAGE_MAX),
  /** File ids; the files must be the sender's or already in this conversation. */
  attachments: z.array(z.string()).max(10).default([]),
  quote: z.object({ message_id: z.string(), text: z.string().max(2000) }).optional(),
  /** Handles of Agents (`main`, `agent:<id>`) or member ids named with @. */
  mentions: z.array(z.string()).max(20).default([]),
  /** A skill run from the composer with `/`. */
  skill: z.object({ skill_id: z.string(), variables: z.record(z.string(), z.string()).default({}) }).optional(),
});
export type SendMessageInput = z.input<typeof sendMessageInputSchema>;

export const sendMessageResultSchema = z.object({
  message: messageSchema,
  /** The turn that will answer: started now, or queued behind the one already running. */
  run_id: z.string().nullable(),
  queued: z.boolean(),
});
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>;

export const readInputSchema = z.object({ seq: z.number().int().min(0) });
