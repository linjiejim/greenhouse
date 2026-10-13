import { z } from 'zod';
import { isoTime } from './common.js';

export const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled'] as const;
export const RUN_SOURCES = ['conversation', 'schedule', 'automation', 'record', 'handoff', 'app'] as const;

/** A background run as the Runs page lists it. Replies (turns) are not listed. */
export const runSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  title: z.string(),
  status: z.enum(RUN_STATUSES),
  source: z.enum(RUN_SOURCES),
  source_id: z.string().nullable(),
  /** Where it reports. */
  conversation_id: z.string().nullable(),
  attempt: z.number().int(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  started_at: isoTime.nullable(),
  finished_at: isoTime.nullable(),
  created_at: isoTime,
});
export type RunView = z.infer<typeof runSchema>;

export const runStepSchema = z.object({
  id: z.string(),
  tool: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  attempt: z.number().int(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  duration_ms: z.number().int().nullable(),
  request_id: z.string().nullable(),
  started_at: isoTime.nullable(),
});

export const runEventSchema = z.object({
  seq: z.number().int(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  actor: z.string().nullable(),
  created_at: isoTime,
});

export const runDetailSchema = runSchema.extend({
  brief: z.string(),
  /** The report text of a finished run. */
  output: z.string().nullable(),
  steps: z.array(runStepSchema),
  events: z.array(runEventSchema),
});
export type RunDetail = z.infer<typeof runDetailSchema>;

export const runListQuerySchema = z.object({
  state: z.enum(['active', 'done', 'all']).default('all'),
  agent: z.string().optional(),
  source: z.enum(RUN_SOURCES).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
