import { z } from 'zod';
import { isoTime } from './common.js';

export const metricsQuerySchema = z.object({ weeks: z.coerce.number().int().min(1).max(12).default(8) });
export const adoptInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('download'),
      file_id: z.string().max(100).optional(),
      message_id: z.string().max(100).optional(),
    })
    .strict()
    .refine((value) => !!value.file_id !== !!value.message_id, 'Name one artifact or reply.'),
  z.object({ kind: z.literal('citation'), message_id: z.string().max(100) }).strict(),
]);
export type AdoptInput = z.infer<typeof adoptInputSchema>;
export const weeklyMetricSchema = z.object({
  week_start: isoTime,
  week_end: isoTime,
  active_members: z.number(),
  adopted_outputs: z.number(),
  adopted_per_active_member: z.number().nullable(),
  new_members: z.number(),
  activated_members: z.number(),
  activation_rate: z.number().nullable(),
  decision_latency_minutes: z.number().nullable(),
  background_finished: z.number(),
  background_succeeded: z.number(),
  background_success_rate: z.number().nullable(),
  cards: z.number(),
  cards_per_active_member_day: z.number().nullable(),
  approval_rate: z.number().nullable(),
  tier3_share: z.number().nullable(),
  cache_hit_rate: z.number().nullable(),
  event_wakeups: z.number(),
});
export type WeeklyMetric = z.infer<typeof weeklyMetricSchema>;
export const metricsSchema = z.object({ weeks: z.array(weeklyMetricSchema) });
export type Metrics = z.infer<typeof metricsSchema>;
