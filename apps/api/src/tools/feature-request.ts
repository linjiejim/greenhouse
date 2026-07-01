/**
 * Feature Request tool — 用户需求反馈收集与管理。
 *
 * 当用户提出超出 Agent 当前能力范围的需求时，Agent 可引导用户提交反馈。
 * super 用户可查看和管理需求列表。
 *
 * Actions:
 * - submit: 提交新需求（member/admin/super）
 * - list: 查看需求列表（super only）
 * - update: 更新需求状态（super only）
 */

import { tool } from 'ai';
import { toErrorMessage } from '@greenhouse/utils/error';
import { defineTool, type ToolMeta } from './define.js';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';

export interface FeatureRequestContext {
  userId: string;
  userRole: string;
  sessionId?: string;
}

const featureRequestSchema = z.object({
  action: z.enum(['submit', 'list', 'update']).describe('Action to perform'),

  // submit params
  title: z.string().optional().describe('Feature request title (for submit)'),
  description: z.string().optional().describe('Detailed description of the requested feature (for submit)'),
  priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority level (for submit, default: normal)'),

  // list params
  status: z.enum(['pending', 'accepted', 'rejected', 'done']).optional().describe('Filter by status (for list)'),
  limit: z.number().optional().describe('Max results to return (for list, default: 20)'),
  offset: z.number().optional().describe('Pagination offset (for list)'),

  // update params
  id: z.number().optional().describe('Feature request ID (for update)'),
  new_status: z.enum(['pending', 'accepted', 'rejected', 'done']).optional().describe('New status (for update)'),
  new_priority: z.enum(['low', 'normal', 'high']).optional().describe('New priority (for update)'),
  admin_note: z.string().optional().describe('Admin note/comment (for update)'),
});

type FeatureRequestInput = z.infer<typeof featureRequestSchema>;

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'feature_request',
  name: 'Feature Requests',
  brief: 'Submit and manage feature requests',
  description: `Submit and manage product feature requests. Supports create, list, and update operations.
Admin can list/update all requests; regular users can create new requests.`,
  category: 'team',
  is_global: true,
  icon: 'Lightbulb',
  sort_order: 11,
};

export function createFeatureRequestTool(db: DatabaseProvider, ctx: FeatureRequestContext) {
  return tool({
    description: meta.description,
    inputSchema: featureRequestSchema,
    execute: async (input: FeatureRequestInput) => {
      try {
        switch (input.action) {
          case 'submit': {
            if (!input.title || !input.description) {
              return { error: 'title and description are required for submit' };
            }
            const request = await db.featureRequests.create({
              title: input.title,
              description: input.description,
              submitted_by: ctx.userId,
              session_id: ctx.sessionId,
              priority: input.priority,
            });
            return {
              success: true,
              message: 'Feature request submitted successfully',
              request: {
                id: request.id,
                title: request.title,
                status: request.status,
                priority: request.priority,
                created_at: request.created_at,
              },
            };
          }

          case 'list': {
            if (ctx.userRole !== 'super') {
              return { error: 'Only super users can list feature requests' };
            }
            const requests = await db.featureRequests.list({
              status: input.status,
              limit: input.limit ?? 20,
              offset: input.offset,
            });
            const total = await db.featureRequests.count(input.status);
            return {
              total,
              count: requests.length,
              requests: requests.map((r) => ({
                id: r.id,
                title: r.title,
                description: r.description,
                submitted_by: r.submitted_by,
                status: r.status,
                priority: r.priority,
                admin_note: r.admin_note,
                session_id: r.session_id,
                created_at: r.created_at,
                updated_at: r.updated_at,
              })),
            };
          }

          case 'update': {
            if (ctx.userRole !== 'super') {
              return { error: 'Only super users can update feature requests' };
            }
            if (!input.id) {
              return { error: 'id is required for update' };
            }
            const updated = await db.featureRequests.update(input.id, {
              status: input.new_status,
              priority: input.new_priority,
              admin_note: input.admin_note,
            });
            if (!updated) {
              return { error: `Feature request #${input.id} not found` };
            }
            return {
              success: true,
              request: {
                id: updated.id,
                title: updated.title,
                status: updated.status,
                priority: updated.priority,
                admin_note: updated.admin_note,
                updated_at: updated.updated_at,
              },
            };
          }

          default:
            return { error: `Unknown action: ${input.action}` };
        }
      } catch (err) {
        return {
          error: `Feature request error: ${toErrorMessage(err)}`,
        };
      }
    },
  });
}

export const featureRequestTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'optional' },
  create: (ctx) =>
    createFeatureRequestTool(ctx.db, { userId: ctx.userId, userRole: ctx.userRole, sessionId: ctx.sessionId }),
});
