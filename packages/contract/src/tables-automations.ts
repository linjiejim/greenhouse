import { z } from 'zod';
import { filterSchema } from './tables.js';
import { isoTime } from './common.js';

export const AUTOMATION_TRIGGERS = [
  'record_created',
  'record_updated',
  'record_matched',
  'schedule',
  'date_reached',
  'button',
] as const;
export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('notify'),
    members: z.array(z.string().min(1).max(64)).min(1).max(50),
    title: z.string().trim().min(1).max(200),
  }),
  z.object({ type: z.literal('webhook'), url: z.string().url().max(2000) }),
  z.object({
    type: z.literal('agent'),
    agent_id: z.string().min(1).max(64),
    brief: z.string().trim().min(1).max(4000),
    tools: z.enum(['none', 'same_base_read']).default('none'),
    output_field_id: z.string().max(64).optional(),
  }),
]);
export const automationConfigSchema = z.object({
  filter: filterSchema.optional(),
  fields: z.array(z.string().max(64)).max(50).default([]),
  interval_minutes: z.number().int().min(1).max(525600).optional(),
  date_field_id: z.string().max(64).optional(),
  actions: z.array(automationActionSchema).min(1).max(10),
});
export const automationInputSchema = z.object({
  table_id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  status: z.enum(['active', 'paused']).default('active'),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  config: automationConfigSchema,
});
export const automationUpdateSchema = automationInputSchema.extend({ revision: z.number().int().positive() });
export const automationSchema = automationInputSchema.extend({
  id: z.string(),
  base_id: z.string(),
  run_as: z.string(),
  revision: z.number().int(),
  next_fire_at: isoTime.nullable(),
  created_at: isoTime,
});
export const automationRunSchema = z.object({
  id: z.string(),
  automation_id: z.string(),
  record_id: z.string().nullable(),
  run_id: z.string().nullable(),
  trigger: z.string(),
  status: z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'suppressed', 'uncertain']),
  steps: z.array(z.object({ index: z.number(), status: z.string(), run_id: z.string().optional() })),
  error: z.string().nullable(),
  started_at: isoTime.nullable(),
  finished_at: isoTime.nullable(),
  created_at: isoTime,
});
export const recordHandoffSchema = z.object({
  agent_id: z.string().min(1).max(64),
  brief: z.string().trim().min(1).max(4000),
  output_field_id: z.string().max(64).optional(),
});
export type AutomationInput = z.input<typeof automationInputSchema>;
export type AutomationConfig = z.infer<typeof automationConfigSchema>;
export type Automation = z.infer<typeof automationSchema>;
export type AutomationRun = z.infer<typeof automationRunSchema>;
