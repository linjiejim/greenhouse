import { z } from 'zod';
import { isoTime } from './common.js';

/** A schedule belongs to an Agent; each firing starts a background run with the same brief. */
export const scheduleSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  name: z.string(),
  brief: z.string(),
  quiet: z.boolean().default(false),
  computer: z.boolean().default(false),
  domains: z.array(z.string()).default([]),
  continue_after: z.boolean().default(false),
  /** Five fields: minute hour day month weekday. */
  cron: z.string(),
  timezone: z.string(),
  status: z.enum(['active', 'paused']),
  next_run_at: isoTime.nullable(),
  last_run_at: isoTime.nullable(),
  last_run_id: z.string().nullable(),
  last_status: z.string().nullable(),
  run_count: z.number().int(),
  created_at: isoTime,
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const scheduleListQuerySchema = z.object({ agent: z.string().optional() });

export const createScheduleInputSchema = z.object({
  quiet: z.boolean().default(false),
  computer: z.boolean().default(false),
  domains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/),
    )
    .max(20)
    .default([]),
  continue_after: z.boolean().default(false),
  /** An Agent id or handle (`main`). */
  agent_id: z.string(),
  name: z.string().trim().min(1).max(80),
  brief: z.string().trim().min(1).max(2000),
  cron: z.string().trim().min(9).max(100),
  /** IANA name; defaults to the member's own. */
  timezone: z.string().max(64).optional(),
});
export type CreateScheduleInput = z.input<typeof createScheduleInputSchema>;

export const updateScheduleInputSchema = z
  .object({
    quiet: z.boolean(),
    computer: z.boolean(),
    domains: createScheduleInputSchema.shape.domains,
    continue_after: z.boolean(),
    name: z.string().trim().min(1).max(80),
    brief: z.string().trim().min(1).max(2000),
    cron: z.string().trim().min(9).max(100),
    timezone: z.string().max(64),
  })
  .partial();
export type UpdateScheduleInput = z.infer<typeof updateScheduleInputSchema>;
