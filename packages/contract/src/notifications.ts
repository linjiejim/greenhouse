import { z } from 'zod';
import { isoTime } from './common.js';

export const notificationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  /** Opening a notification goes back to where it came from. */
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  request_id: z.string().nullable(),
  run_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  read_at: isoTime.nullable(),
  created_at: isoTime,
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z.object({
  unread: z.enum(['true', 'false']).default('false'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Mark some, or every, notification read. */
export const readNotificationsInputSchema = z.union([
  z.object({ ids: z.array(z.string()).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);

export const notificationSummarySchema = z.object({
  /** The one badge: how many things need the member. */
  needs_you: z.number().int(),
  unread: z.number().int(),
});
