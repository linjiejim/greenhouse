/**
 * manage_eval_dataset tool — allows an authorized Assistant to create, update, list, and delete eval datasets.
 *
 * Use cases:
 * - After eval runs, record poorly-answered questions as new test cases
 * - Review and adjust existing datasets based on evaluation results
 * - Add typical customer questions encountered during chat to the eval suite
 */

import { tool } from 'ai';
import { defineTool, type ToolMeta } from './define.js';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';

const manageEvalDatasetSchema = z.object({
  action: z
    .enum(['list', 'create', 'update', 'delete', 'get', 'archive', 'restore'])
    .describe(
      'Action to perform: list (with optional filters), create (add new test case), update (modify existing), delete (remove), get (single by ID), archive (mark as archived), restore (un-archive)',
    ),
  // For list action — filters
  category: z
    .string()
    .optional()
    .describe('Filter by category (faq, plant, product, guide, troubleshooting, topic, negative, edge, comparison)'),
  difficulty: z.string().optional().describe('Filter by difficulty (easy, medium, hard)'),
  language: z.string().optional().describe('Filter by language (en, zh)'),
  enabled: z.boolean().optional().describe('Filter by enabled status'),
  status: z.string().optional().describe('Filter by lifecycle status (active, archived, deprecated)'),
  source: z.string().optional().describe('Filter by creation source (manual, agent, import, seed)'),
  filter_tags: z.array(z.string()).optional().describe('Filter datasets that contain ALL these tags'),
  // For create/update actions
  id: z.number().optional().describe('Dataset ID (required for update/delete/get/archive/restore)'),
  question: z.string().optional().describe('The test question (required for create)'),
  ground_truth: z.array(z.string()).optional().describe('Array of expected factual points the answer should contain'),
  expected_behavior: z.string().optional().describe('Description of what good behavior looks like'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  is_negative: z.boolean().optional().describe("Whether this is a negative test (expects refusal/don't know)"),
  notes: z.string().optional().describe('Free-text notes explaining why this case was added or modified'),
});

type ManageEvalDatasetInput = z.infer<typeof manageEvalDatasetSchema>;

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'manage_eval_dataset',
  name: 'Eval Dataset',
  brief: 'Manage evaluation test datasets',
  description: `Manage evaluation datasets. Operations: list / create / update / get.
ground_truth should list specific facts the answer must include. is_negative=true for questions the Agent should refuse to answer.`,
  category: 'admin',
  is_global: false,
  icon: 'FileEdit',
  runtime_risk: 'r2',
  sort_order: 22,
};

export function createManageEvalDatasetTool(db: DatabaseProvider) {
  return tool({
    description: meta.description,
    inputSchema: manageEvalDatasetSchema,
    execute: async (input: ManageEvalDatasetInput) => {
      const { action } = input;

      switch (action) {
        case 'list': {
          const datasets = await db.eval.listDatasets({
            category: input.category,
            difficulty: input.difficulty,
            language: input.language,
            enabled: input.enabled,
            status: input.status,
            source: input.source,
            tags: input.filter_tags,
          });
          return {
            action: 'list',
            count: datasets.length,
            datasets: datasets.map((d) => ({
              id: d.id,
              category: d.category,
              difficulty: d.difficulty,
              question: d.question,
              ground_truth_count: JSON.parse(d.ground_truth).length,
              language: d.language,
              is_negative: d.is_negative === 1,
              enabled: d.enabled === 1,
              tags: JSON.parse(d.tags),
              status: d.status,
              source: d.source,
              created_by: d.created_by,
            })),
          };
        }

        case 'get': {
          if (!input.id) return { error: 'id is required for get action' };
          const dataset = await db.eval.getDataset(input.id);
          if (!dataset) return { error: `Dataset #${input.id} not found` };
          return {
            action: 'get',
            dataset: {
              ...dataset,
              ground_truth: JSON.parse(dataset.ground_truth),
              tags: JSON.parse(dataset.tags),
              is_negative: dataset.is_negative === 1,
              enabled: dataset.enabled === 1,
            },
          };
        }

        case 'create': {
          if (!input.question) return { error: 'question is required for create action' };
          if (!input.ground_truth || input.ground_truth.length === 0) {
            return { error: 'ground_truth (array of facts) is required for create action' };
          }
          if (!input.category) return { error: 'category is required for create action' };

          const dataset = await db.eval.createDataset({
            category: input.category,
            difficulty: input.difficulty ?? 'medium',
            question: input.question,
            ground_truth: JSON.stringify(input.ground_truth),
            expected_behavior: input.expected_behavior,
            tags: input.tags,
            language: input.language ?? 'en',
            is_negative: input.is_negative,
            source: 'agent',
            notes: input.notes,
          });

          return {
            action: 'created',
            dataset: {
              id: dataset.id,
              category: dataset.category,
              difficulty: dataset.difficulty,
              question: dataset.question,
              ground_truth: JSON.parse(dataset.ground_truth),
              language: dataset.language,
              is_negative: dataset.is_negative === 1,
              enabled: dataset.enabled === 1,
            },
            message: `✅ Test case #${dataset.id} created successfully`,
          };
        }

        case 'update': {
          if (!input.id) return { error: 'id is required for update action' };
          const updates: Record<string, unknown> = {};
          if (input.category !== undefined) updates.category = input.category;
          if (input.difficulty !== undefined) updates.difficulty = input.difficulty;
          if (input.question !== undefined) updates.question = input.question;
          if (input.ground_truth !== undefined) updates.ground_truth = JSON.stringify(input.ground_truth);
          if (input.expected_behavior !== undefined) updates.expected_behavior = input.expected_behavior;
          if (input.tags !== undefined) updates.tags = input.tags;
          if (input.language !== undefined) updates.language = input.language;
          if (input.is_negative !== undefined) updates.is_negative = input.is_negative;
          if (input.notes !== undefined) updates.notes = input.notes;

          if (input.enabled !== undefined) updates.enabled = input.enabled;

          if (Object.keys(updates).length === 0) {
            return { error: 'No fields to update. Provide at least one field to change.' };
          }

          const dataset = await db.eval.updateDataset(input.id, updates as any);
          if (!dataset) return { error: `Dataset #${input.id} not found` };

          return {
            action: 'updated',
            dataset: {
              id: dataset.id,
              category: dataset.category,
              difficulty: dataset.difficulty,
              question: dataset.question,
              ground_truth: JSON.parse(dataset.ground_truth),
              language: dataset.language,
              is_negative: dataset.is_negative === 1,
              enabled: dataset.enabled === 1,
            },
            message: `✅ Test case #${dataset.id} updated successfully`,
          };
        }

        case 'delete': {
          if (!input.id) return { error: 'id is required for delete action' };
          const ok = await db.eval.deleteDataset(input.id);
          if (!ok) return { error: `Dataset #${input.id} not found` };
          return {
            action: 'deleted',
            id: input.id,
            message: `✅ Test case #${input.id} deleted successfully`,
          };
        }

        case 'archive': {
          if (!input.id) return { error: 'id is required for archive action' };
          const archived = await db.eval.updateDataset(input.id, {
            status: 'archived',
            notes: input.notes,
          });
          if (!archived) return { error: `Dataset #${input.id} not found` };
          return {
            action: 'archived',
            id: input.id,
            message: `📦 Test case #${input.id} archived successfully`,
          };
        }

        case 'restore': {
          if (!input.id) return { error: 'id is required for restore action' };
          const restored = await db.eval.updateDataset(input.id, {
            status: 'active',
            notes: input.notes,
          });
          if (!restored) return { error: `Dataset #${input.id} not found` };
          return {
            action: 'restored',
            id: input.id,
            message: `✅ Test case #${input.id} restored to active`,
          };
        }

        default:
          return { error: `Unknown action: ${action}` };
      }
    },
  });
}

export const manageEvalDatasetTool = defineTool({ meta, kind: 'static', create: createManageEvalDatasetTool });
