/**
 * query_eval_runs tool — allows an authorized Assistant to list eval runs and inspect their results.
 *
 * Use cases:
 * - List recent eval runs with their summary scores
 * - Get detailed results for a specific run (per-question scores)
 * - Search runs by name
 * - Identify low-scoring questions for analysis
 */

import { tool } from 'ai';
import { defineTool, type ToolMeta } from './define.js';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';

const queryEvalRunsSchema = z.object({
  action: z
    .enum(['list_runs', 'get_run', 'get_low_scores'])
    .describe(
      'Action: list_runs (list recent runs), get_run (get a run with all results), get_low_scores (get lowest scoring results from a run)',
    ),
  run_id: z.string().optional().describe('Run ID (required for get_run, get_low_scores)'),
  search: z.string().optional().describe('Search runs by name (for list_runs)'),
  limit: z.number().optional().describe('Max results to return (default 20)'),
  threshold: z
    .number()
    .optional()
    .describe('Score threshold for get_low_scores (default 7.0, returns results scoring below this)'),
});

type QueryEvalRunsInput = z.infer<typeof queryEvalRunsSchema>;

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'query_eval_runs',
  name: 'Eval Runs',
  brief: 'Query and analyze evaluation run results',
  description: `Query evaluation run results. Operations: list_runs / get_run / get_low_scores (default threshold 7.0).
Analysis patterns: which categories score low? Which difficulty levels? Common issues? Low-score areas suggest creating new eval cases.`,
  category: 'admin',
  is_global: false,
  icon: 'BarChart3',
  sort_order: 23,
};

export function createQueryEvalRunsTool(db: DatabaseProvider) {
  return tool({
    description: meta.description,
    inputSchema: queryEvalRunsSchema,
    execute: async (input: QueryEvalRunsInput) => {
      const { action } = input;

      switch (action) {
        case 'list_runs': {
          const limit = input.limit ?? 20;
          const runs = await db.eval.listRuns(limit, input.search);
          return {
            action: 'list_runs',
            count: runs.length,
            runs: runs.map((r) => ({
              id: r.id,
              name: r.name,
              status: r.status,
              model: r.model,
              profile_id: r.profile_id,
              total: r.total,
              completed: r.completed,
              passed: r.passed,
              failed: r.failed,
              avg_score: r.avg_score != null ? Math.round(r.avg_score * 10) / 10 : null,
              avg_accuracy: r.avg_accuracy != null ? Math.round(r.avg_accuracy * 10) / 10 : null,
              avg_completeness: r.avg_completeness != null ? Math.round(r.avg_completeness * 10) / 10 : null,
              avg_relevance: r.avg_relevance != null ? Math.round(r.avg_relevance * 10) / 10 : null,
              avg_speed: r.avg_speed != null ? Math.round(r.avg_speed * 10) / 10 : null,
              started_at: r.started_at,
              finished_at: r.finished_at,
            })),
          };
        }

        case 'get_run': {
          if (!input.run_id) return { error: 'run_id is required for get_run action' };
          const run = await db.eval.getRun(input.run_id);
          if (!run) return { error: `Run ${input.run_id} not found` };
          const results = await db.eval.getRunResults(input.run_id);
          const limit = input.limit ?? 100;

          return {
            action: 'get_run',
            run: {
              id: run.id,
              name: run.name,
              status: run.status,
              model: run.model,
              profile_id: run.profile_id,
              total: run.total,
              passed: run.passed,
              failed: run.failed,
              avg_score: run.avg_score != null ? Math.round(run.avg_score * 10) / 10 : null,
              avg_accuracy: run.avg_accuracy != null ? Math.round(run.avg_accuracy * 10) / 10 : null,
              avg_completeness: run.avg_completeness != null ? Math.round(run.avg_completeness * 10) / 10 : null,
              avg_relevance: run.avg_relevance != null ? Math.round(run.avg_relevance * 10) / 10 : null,
              avg_speed: run.avg_speed != null ? Math.round(run.avg_speed * 10) / 10 : null,
              started_at: run.started_at,
              finished_at: run.finished_at,
            },
            result_count: results.length,
            results: results.slice(0, limit).map((r) => ({
              dataset_id: r.dataset_id,
              question: r.question,
              category: r.category,
              difficulty: r.difficulty,
              is_negative: r.is_negative === 1,
              status: r.status,
              score_final: r.score_final,
              score_accuracy: r.score_accuracy,
              score_completeness: r.score_completeness,
              score_relevance: r.score_relevance,
              score_speed: r.score_speed,
              duration_ms: r.duration_ms,
              answer_preview: r.answer ? r.answer.slice(0, 200) : null,
              error: r.error,
              judge_reasoning: r.judge_reasoning
                ? (() => {
                    try {
                      const j = JSON.parse(r.judge_reasoning!);
                      return {
                        accuracy: j.accuracy?.reason,
                        completeness: j.completeness?.reason,
                        relevance: j.relevance?.reason,
                        speed: j.speed?.reason,
                      };
                    } catch {
                      return null;
                    }
                  })()
                : null,
            })),
          };
        }

        case 'get_low_scores': {
          if (!input.run_id) return { error: 'run_id is required for get_low_scores action' };
          const run = await db.eval.getRun(input.run_id);
          if (!run) return { error: `Run ${input.run_id} not found` };
          const allResults = await db.eval.getRunResults(input.run_id);
          const threshold = input.threshold ?? 7.0;
          const limit = input.limit ?? 20;

          const lowScores = allResults
            .filter((r) => r.status === 'completed' && r.score_final != null && r.score_final < threshold)
            .sort((a, b) => (a.score_final ?? 0) - (b.score_final ?? 0))
            .slice(0, limit);

          return {
            action: 'get_low_scores',
            run_id: input.run_id,
            run_name: run.name,
            threshold,
            total_results: allResults.filter((r) => r.status === 'completed').length,
            low_score_count: lowScores.length,
            results: lowScores.map((r) => ({
              dataset_id: r.dataset_id,
              question: r.question,
              category: r.category,
              difficulty: r.difficulty,
              is_negative: r.is_negative === 1,
              score_final: r.score_final,
              score_accuracy: r.score_accuracy,
              score_completeness: r.score_completeness,
              score_relevance: r.score_relevance,
              score_speed: r.score_speed,
              duration_ms: r.duration_ms,
              answer_preview: r.answer ? r.answer.slice(0, 300) : null,
              judge_reasoning: r.judge_reasoning
                ? (() => {
                    try {
                      const j = JSON.parse(r.judge_reasoning!);
                      return {
                        accuracy: j.accuracy?.reason,
                        completeness: j.completeness?.reason,
                        relevance: j.relevance?.reason,
                        speed: j.speed?.reason,
                      };
                    } catch {
                      return null;
                    }
                  })()
                : null,
            })),
          };
        }

        default:
          return { error: `Unknown action: ${action}` };
      }
    },
  });
}

export const queryEvalRunsTool = defineTool({ meta, kind: 'static', create: createQueryEvalRunsTool });
