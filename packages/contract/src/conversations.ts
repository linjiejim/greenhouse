import { z } from 'zod';
import { agentAvatarSchema } from './agents.js';
import { isoTime } from './common.js';
import { memberSummarySchema } from './members.js';

export const CONVERSATION_KINDS = ['main', 'direct', 'chat', 'room'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const MESSAGE_ROLES = ['user', 'assistant', 'event'] as const;
export const MESSAGE_STATUSES = ['complete', 'streaming', 'stopped', 'failed'] as const;
export const MESSAGE_MAX = 32_000;
export const FEEDBACK_COMMENT_MAX = 500;
export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 20_000;
export const NOTE_STATUSES = ['open', 'done'] as const;

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

/** Page references are resolved by the server with the asker's current permissions. */
export const pageContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('doc'), id: z.string().max(100) }).strict(),
  z.object({ kind: z.literal('record'), id: z.string().max(100) }).strict(),
  z.object({ kind: z.literal('run'), id: z.string().max(100) }).strict(),
  z.object({ kind: z.literal('agent'), id: z.string().max(100) }).strict(),
  z.object({ kind: z.literal('app'), id: z.string().max(100), page_id: z.string().max(100).optional() }).strict(),
  z.object({ kind: z.literal('page'), name: z.string().max(80) }).strict(),
]);
export type PageContext = z.infer<typeof pageContextSchema>;

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
    context: pageContextSchema.optional(),
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
  recovered: z.boolean().optional(),
});

export const REACTION_EMOJIS = ['👍', '✅', '🙏', '❤️', '👀', '🎉'] as const;
export const todoItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  status: z.enum(['pending', 'active', 'done', 'blocked', 'skipped']),
});
export type TodoItem = z.infer<typeof todoItemSchema>;
export const messageSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  seq: z.number().int(),
  role: z.enum(MESSAGE_ROLES),
  author_member_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  content: z.string(),
  reactions: z.array(z.object({ agent_id: z.string(), emoji: z.enum(REACTION_EMOJIS) })).optional(),
  blocks: z.array(z.unknown()),
  attachments: z.array(z.string()),
  quote: z.object({ message_id: z.string(), text: z.string() }).nullable(),
  mentions: z.array(z.string()),
  /** The skill the member ran with `/`: the version that ran and the values filled in. */
  skill: z
    .object({ skill_id: z.string(), version: z.string().nullable(), variables: z.record(z.string(), z.string()) })
    .nullable(),
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

/** 👍 is 1, 👎 is -1. */
export const ratingSchema = z.union([z.literal(1), z.literal(-1)]);

/** A message as a page lists it: with the reader's own rating. Realtime events carry plain messages. */
export const messageItemSchema = messageSchema.extend({ my_rating: ratingSchema.nullable() });
export type MessageItem = z.infer<typeof messageItemSchema>;

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
  /**
   * The rich blocks this screen draws (RICH_CAPABILITIES in @greenhouse/types/rich-output);
   * unknown names are ignored. Left out, replies use only the five blocks every client draws.
   */
  rich_blocks: z.array(z.string().max(40)).max(20).optional(),
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

/** 👍 / 👎 on a reply from an Agent; 0 takes it back. The comment says why. */
export const feedbackInputSchema = z.object({
  rating: z.union([ratingSchema, z.literal(0)]),
  comment: z.string().trim().max(FEEDBACK_COMMENT_MAX).optional(),
});
export type FeedbackInput = z.input<typeof feedbackInputSchema>;

export const feedbackSchema = z.object({ rating: z.union([ratingSchema, z.literal(0)]), comment: z.string() });
export type Feedback = z.infer<typeof feedbackSchema>;

/** New text for my last message; the replies after it are removed and it is answered again. */
export const editMessageInputSchema = z.object({ content: z.string().max(MESSAGE_MAX) });
export type EditMessageInput = z.infer<typeof editMessageInputSchema>;

/** After an edit or a regenerate: what left the transcript and the turn that answers again. */
export const regenerateResultSchema = z.object({
  /** Oldest first; everyone in the conversation also gets `message.deleted` for each. */
  deleted_message_ids: z.array(z.string()),
  /** The turn that answers again: started now, or null when it waits behind another. */
  run_id: z.string().nullable(),
  queued: z.boolean(),
});
export type RegenerateResult = z.infer<typeof regenerateResultSchema>;

export const editMessageResultSchema = regenerateResultSchema.extend({ message: messageSchema });
export type EditMessageResult = z.infer<typeof editMessageResultSchema>;

/** A person in a conversation. */
export const conversationPersonSchema = memberSummarySchema.extend({
  role: z.enum(['owner', 'member']),
  last_read_seq: z.number().int(),
  joined_at: isoTime,
});

/** An Agent in a conversation: the one that answers it, or one somebody brought into the room. */
export const conversationAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  avatar: agentAvatarSchema,
  owner_id: z.string(),
});

export const conversationMembersSchema = z.object({
  members: z.array(conversationPersonSchema),
  agents: z.array(conversationAgentSchema),
});
export type ConversationMembers = z.infer<typeof conversationMembersSchema>;

/** Rooms only. Anyone in the room may add people; an Agent can be added only by its owner. */
export const addMembersInputSchema = z
  .object({
    member_ids: z.array(z.string()).max(50).default([]),
    /** Handles (`main`, `agent:<id>`) or ids of my own Agents. */
    agent_ids: z.array(z.string()).max(10).default([]),
  })
  .refine((input) => input.member_ids.length + input.agent_ids.length > 0, {
    message: 'Add at least one person or Agent.',
  });
export type AddMembersInput = z.input<typeof addMembersInputSchema>;

/** A shared note of a conversation (CONV-24): anyone in the conversation reads and writes it. */
export const noteSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.enum(NOTE_STATUSES),
  pinned: z.boolean(),
  /** Who wrote it first: a member, or an Agent. */
  author_member_id: z.string().nullable(),
  author_agent_id: z.string().nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type Note = z.infer<typeof noteSchema>;

const noteFields = {
  title: z.string().trim().max(NOTE_TITLE_MAX),
  body: z.string().max(NOTE_BODY_MAX),
  status: z.enum(NOTE_STATUSES),
  pinned: z.boolean(),
};

export const createNoteInputSchema = z
  .object({
    title: noteFields.title.default(''),
    body: noteFields.body.default(''),
    status: noteFields.status.default('open'),
    pinned: noteFields.pinned.default(false),
  })
  .refine((input) => !!(input.title || input.body.trim()), { message: 'Write a title or some text.' });
export type CreateNoteInput = z.input<typeof createNoteInputSchema>;

export const updateNoteInputSchema = z.object(noteFields).partial();
export type UpdateNoteInput = z.infer<typeof updateNoteInputSchema>;
