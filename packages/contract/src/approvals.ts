import { z } from 'zod';
import { isoTime } from './common.js';

export const approvalScopeSchema = z.object({
  type: z.enum(['folder', 'table']),
  id: z.string().min(1).max(64),
  actions: z.array(z.string().min(1).max(64)).min(1).max(10),
});
export const standingApprovalSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  scope_type: z.enum(['folder', 'table']),
  scope_id: z.string(),
  scope_name: z.string().nullable().optional(),
  scope_href: z.string().nullable().optional(),
  actions: z.array(z.string()),
  granted_at: isoTime,
  revoked_at: isoTime.nullable(),
});
export type StandingApproval = z.infer<typeof standingApprovalSchema>;
export const approveInputSchema = z.object({
  standing: z.boolean().default(false),
  continue_after: z.boolean().optional(),
});
