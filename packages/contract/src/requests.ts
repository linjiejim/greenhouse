import { z } from 'zod';
import { isoTime } from './common.js';

export const REQUEST_KINDS = ['approval', 'login', 'takeover', 'question', 'proposal'] as const;
export const REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'answered',
  'handed_back',
  'expired',
  'canceled',
] as const;

export const questionFieldSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  type: z.enum(['text', 'choice']).default('text'),
  options: z.array(z.string().min(1).max(100)).max(10).optional(),
  required: z.boolean().default(true),
});
export type QuestionField = z.infer<typeof questionFieldSchema>;

/** "Needs you": one model for approvals, sign-ins, take-overs, questions and proposals. */
export const requestSchema = z.object({
  id: z.string(),
  kind: z.enum(REQUEST_KINDS),
  /** What is being decided: tool_write, ask_user, instructions_update, run_start, … */
  subject: z.string(),
  status: z.enum(REQUEST_STATUSES),
  conversation_id: z.string().nullable(),
  run_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  /** The card: a title and what it shows, never secrets. */
  title: z.string(),
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  expires_at: isoTime.nullable(),
  decided_at: isoTime.nullable(),
  created_at: isoTime,
});
export type NeedsYou = z.infer<typeof requestSchema>;

export const requestListQuerySchema = z.object({
  state: z.enum(['pending', 'all']).default('pending'),
  conversation_id: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const rejectInputSchema = z.object({ reason: z.string().trim().max(500).optional() });
export const answerInputSchema = z.object({ answers: z.record(z.string(), z.string().max(4000)) });
export type AnswerInput = z.infer<typeof answerInputSchema>;
