/**
 * Feedback query — the read side of Issues & requests: the feature requests a
 * member filed (a super sees everyone's), with their status and the admin note.
 *
 * Plain reads, so members' agents can follow up on what they asked for without
 * a recorded write. Frictions stay write-only on purpose (see log_friction): a
 * model may log a stumble, never browse what other people hit. Lazy: needs the
 * calling user (buildLazyServerTools).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider, FeatureRequestRow } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';

const feedbackQuerySchema = z.object({
  action: z.enum(['requests.list', 'requests.get']).describe('requests.list: newest first. requests.get: one request.'),
  status: z
    .enum(['pending', 'accepted', 'rejected', 'done'])
    .optional()
    .describe('requests.list: only requests in this state.'),
  everyone: z.boolean().optional().describe('requests.list: super only — everyone’s requests instead of your own.'),
  limit: z.number().int().min(1).max(50).optional().describe('requests.list: max results (default 20).'),
  offset: z.number().int().min(0).optional().describe('requests.list: pagination offset.'),
  id: z.number().int().positive().optional().describe('requests.get: the request id.'),
});

type FeedbackQueryInput = z.infer<typeof feedbackQuerySchema>;

const meta: ToolMeta = {
  id: 'feedback_query',
  name: 'Feedback',
  brief: 'Check the feature requests you filed and how they were answered',
  description:
    'Read the feature requests you filed (a super admin can read everyone’s): status, priority and the admin’s note. File new ones with feature_request.',
  category: 'team',
  is_global: true,
  icon: 'Lightbulb',
  surface: { proxy: 'read', mcp: 'feedback' },
  sort_order: 12,
};

export interface FeedbackQueryContext {
  userId: string;
  userRole: string;
}

function view(row: FeatureRequestRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    admin_note: row.admin_note,
    submitted_by: row.submitted_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createFeedbackQueryTool(db: DatabaseProvider, ctx: FeedbackQueryContext) {
  const isSuper = ctx.userRole === 'super';
  return tool({
    description: meta.description,
    inputSchema: feedbackQuerySchema,
    execute: async (input: FeedbackQueryInput) => {
      try {
        if (input.action === 'requests.get') {
          if (!input.id) return { error: 'id is required for requests.get' };
          const row = await db.featureRequests.getById(input.id);
          // Someone else's request reads as missing, not as forbidden.
          if (!row || (!isSuper && row.submitted_by !== ctx.userId)) {
            return { error: `No feature request "${input.id}" of yours. Use requests.list to find it.` };
          }
          return { request: view(row) };
        }
        if (input.everyone && !isSuper) return { error: 'Only a super admin can list everyone’s requests.' };
        const rows = await db.featureRequests.list({
          status: input.status,
          submitted_by: input.everyone ? undefined : ctx.userId,
          limit: input.limit ?? 20,
          offset: input.offset,
        });
        return { count: rows.length, requests: rows.map(view) };
      } catch (error) {
        return { error: toErrorMessage(error) };
      }
    },
  });
}

export const feedbackQueryTool = defineTool({ meta, kind: 'lazy' });
