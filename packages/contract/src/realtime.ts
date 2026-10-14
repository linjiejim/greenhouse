import { z } from 'zod';
import { COMPUTER_STATES } from './computers.js';
import { conversationSchema, messageSchema, messageStepSchema } from './conversations.js';
import { COMMENT_TARGETS, docPresenceSchema } from './knowledge.js';

/**
 * Events on the one WebSocket, `/api/ws`: `{ type, data }`. The first frame a client sends is
 * `{ type: 'hello', data: { token } }`; the server answers `ready` or closes.
 */
export const realtimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), data: z.object({ member_id: z.string() }) }),
  z.object({ type: z.literal('message.created'), data: z.object({ message: messageSchema }) }),
  /**
   * Text appended to a streaming reply at `offset` (its length before this text). A client
   * that fetched the partial reply mid-stream splices from there.
   */
  z.object({
    type: z.literal('message.delta'),
    data: z.object({
      conversation_id: z.string(),
      message_id: z.string(),
      text: z.string(),
      offset: z.number().int().min(0),
    }),
  }),
  /** A tool step started or settled in a streaming reply. */
  z.object({
    type: z.literal('message.step'),
    data: z.object({
      conversation_id: z.string(),
      message_id: z.string(),
      step: messageStepSchema.extend({ id: z.string(), status: z.enum(['running', 'done', 'failed']) }),
    }),
  }),
  /** Resume the same reply from a completed boundary; discard its unfinished live suffix. */
  z.object({
    type: z.literal('message.resumed'),
    data: z.object({ conversation_id: z.string(), message_id: z.string(), offset: z.number().int().min(0) }),
  }),
  z.object({ type: z.literal('message.updated'), data: z.object({ message: messageSchema }) }),
  /**
   * A message left the transcript (an edit or a regenerate replaced the replies after it). Its
   * sequence number is never given out again; deltas that still arrive for it are dropped.
   */
  z.object({
    type: z.literal('message.deleted'),
    data: z.object({ conversation_id: z.string(), message_id: z.string() }),
  }),
  /**
   * Messages after `after_seq` changed and their event could not reach this socket (it was too
   * big to pass between server processes): catch up with `GET …/messages?after=<after_seq>`.
   */
  z.object({
    type: z.literal('conversation.resync'),
    data: z.object({ conversation_id: z.string(), after_seq: z.number().int().min(0) }),
  }),
  /** Fields that changed. Empty `changes`: its people or Agents changed, so refetch it. */
  z.object({
    type: z.literal('conversation.updated'),
    data: z.object({ conversation_id: z.string(), changes: conversationSchema.partial() }),
  }),
  /** Someone in a room read up to `last_read_seq` (read receipts, CONV-06). Rooms only. */
  z.object({
    type: z.literal('read.updated'),
    data: z.object({ conversation_id: z.string(), member_id: z.string(), last_read_seq: z.number().int() }),
  }),
  /** A shared note was added, changed or deleted: refetch the notes of this conversation. */
  z.object({
    type: z.literal('notes.updated'),
    data: z.object({ conversation_id: z.string(), note_id: z.string() }),
  }),
  z.object({
    type: z.literal('run.updated'),
    data: z.object({ run_id: z.string(), status: z.string(), conversation_id: z.string().nullable() }),
  }),
  z.object({
    type: z.literal('request.updated'),
    data: z.object({ request_id: z.string(), status: z.string(), conversation_id: z.string().nullable() }),
  }),
  z.object({
    type: z.literal('notification.created'),
    data: z.object({ notification_id: z.string(), kind: z.string(), title: z.string() }),
  }),
  /** Some of my notifications were read (on another screen, or by reading their conversation): refetch them. */
  z.object({ type: z.literal('notification.read'), data: z.object({ notification_ids: z.array(z.string()) }) }),
  /** My computer of this Agent started, stopped or failed: refetch it. */
  z.object({
    type: z.literal('computer.updated'),
    data: z.object({ agent_id: z.string(), state: z.enum(COMPUTER_STATES) }),
  }),
  /** My vault changed, or an Agent used it: refetch the item (null: all of them) and the log. */
  z.object({ type: z.literal('vault.updated'), data: z.object({ item_id: z.string().nullable() }) }),
  /** A doc I have open was saved, renamed, moved, archived or restored. */
  z.object({
    type: z.literal('doc.updated'),
    data: z.object({
      doc_id: z.string(),
      version: z.number().int(),
      title: z.string(),
      updated_by: z.string().nullable(),
      archived: z.boolean(),
    }),
  }),
  /** Who has a doc I have open, and who is editing it. */
  z.object({
    type: z.literal('doc.presence'),
    data: z.object({ doc_id: z.string(), items: z.array(docPresenceSchema) }),
  }),
  /**
   * Records of a base I can see changed: each with its revisions now. A cached record at an older
   * revision or computed revision, or one not cached, is out of date; an empty list means many
   * changed (or which ones is not mine to know: a custom role sees only some records).
   */
  z.object({
    type: z.literal('records.changed'),
    data: z.object({
      base_id: z.string(),
      table_id: z.string(),
      records: z.array(
        z.object({ id: z.string(), revision: z.number().int(), computed_revision: z.number().int().optional() }),
      ),
    }),
  }),
  /** A base's name, data tables, fields, views or shares changed: refetch it. */
  z.object({ type: z.literal('base.updated'), data: z.object({ base_id: z.string() }) }),
  /** A comment was added, edited or deleted on something I have open: refetch its comments. */
  z.object({
    type: z.literal('comments.updated'),
    data: z.object({ target_type: z.enum(COMMENT_TARGETS), target_id: z.string(), comment_id: z.string() }),
  }),
  /**
   * Something in the knowledge base I can see was made, renamed, moved, reordered, saved, shared,
   * archived or restored: refetch the knowledge lists on screen. It names nothing.
   */
  z.object({ type: z.literal('knowledge.changed'), data: z.object({}) }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/** The socket closes with this code when the token is missing or no longer good: refresh, then reconnect. */
export const REALTIME_SIGN_IN_AGAIN = 4401;

export const helloSchema = z.object({ type: z.literal('hello'), data: z.object({ token: z.string().min(1) }) });
