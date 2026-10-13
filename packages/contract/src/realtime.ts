import { z } from 'zod';
import { COMPUTER_STATES } from './computers.js';
import { conversationSchema, messageSchema, messageStepSchema } from './conversations.js';

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
  z.object({ type: z.literal('message.updated'), data: z.object({ message: messageSchema }) }),
  /**
   * A message left the transcript (an edit or a regenerate replaced the replies after it). Its
   * sequence number is never given out again; deltas that still arrive for it are dropped.
   */
  z.object({
    type: z.literal('message.deleted'),
    data: z.object({ conversation_id: z.string(), message_id: z.string() }),
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
  /** My computer of this Agent started, stopped or failed: refetch it. */
  z.object({
    type: z.literal('computer.updated'),
    data: z.object({ agent_id: z.string(), state: z.enum(COMPUTER_STATES) }),
  }),
  /** My vault changed, or an Agent used it: refetch the item (null: all of them) and the log. */
  z.object({ type: z.literal('vault.updated'), data: z.object({ item_id: z.string().nullable() }) }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/** The socket closes with this code when the token is missing or no longer good: refresh, then reconnect. */
export const REALTIME_SIGN_IN_AGAIN = 4401;

export const helloSchema = z.object({ type: z.literal('hello'), data: z.object({ token: z.string().min(1) }) });
