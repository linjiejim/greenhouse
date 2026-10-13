import { z } from 'zod';
import { conversationSchema, messageSchema, messageStepSchema } from './conversations.js';

/**
 * Events on the one WebSocket, `/api/ws`: `{ type, data }`. The first frame a client sends is
 * `{ type: 'hello', data: { token } }`; the server answers `ready` or closes.
 */
export const realtimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), data: z.object({ member_id: z.string() }) }),
  z.object({ type: z.literal('message.created'), data: z.object({ message: messageSchema }) }),
  /** Text appended to a streaming reply. */
  z.object({
    type: z.literal('message.delta'),
    data: z.object({ conversation_id: z.string(), message_id: z.string(), text: z.string() }),
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
  z.object({
    type: z.literal('conversation.updated'),
    data: z.object({ conversation_id: z.string(), changes: conversationSchema.partial() }),
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
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export const helloSchema = z.object({ type: z.literal('hello'), data: z.object({ token: z.string().min(1) }) });
