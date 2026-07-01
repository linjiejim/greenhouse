/**
 * Compute tool — AI SDK tool definition.
 *
 * Allows the LLM to write and execute JavaScript code in a V8 sandbox
 * for precise data analysis, calculations, and transformations.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type ToolMeta } from '../define.js';
import { executeCompute } from './executor.js';

const MAX_DATA_BYTES = 1_000_000; // 1MB

const computeInputSchema = z.object({
  code: z
    .string()
    .describe(
      'JavaScript code that defines a `compute(data)` function. ' +
        'The function receives the data parameter and must return a JSON-serializable result. ' +
        'console.log() is available for debugging. ' +
        'No require/import, no network, no filesystem — pure computation only.',
    ),
  data: z
    .unknown()
    .refine(
      (v) => {
        try {
          return JSON.stringify(v ?? {}).length <= MAX_DATA_BYTES;
        } catch {
          return false;
        }
      },
      {
        message: `Input data too large (max ${Math.round(MAX_DATA_BYTES / 1024)}KB). Pre-filter or aggregate before passing to compute.`,
      },
    )
    .describe(
      'Input data to pass into the compute(data) function. ' + 'Typically the result from a previous tool call.',
    ),
});

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'compute',
  name: 'Compute',
  brief: 'Execute code for precise data analysis & calculations',
  description: `Execute JavaScript code in a secure sandbox for precise calculations, data analysis, and transformations.
Use this tool when you need to:
- Calculate statistics (sum, average, median, percentile, standard deviation)
- Aggregate or group data (count by category, pivot tables)
- Sort, filter, or transform datasets
- Perform date/time calculations
- Do any math that benefits from code precision over inference

Your code must define a \`compute(data)\` function that receives the data and returns a result:
\`\`\`js
function compute(data) {
  const total = data.items.reduce((sum, i) => sum + i.amount, 0);
  return { total, count: data.items.length, avg: total / data.items.length };
}
\`\`\`
Rules:
- No require/import (sandbox has no modules)
- No network access (no fetch/XMLHttpRequest)
- No filesystem access
- console.log() is available for debugging
- Must return a JSON-serializable value
- Timeout: 15 seconds, Memory: 64MB`,
  category: 'team',
  is_global: true,
  icon: 'Calculator',
  group: 'compute',
  surface: { proxy: 'read' },
};

export function createComputeTool() {
  return tool({
    description: meta.description,
    inputSchema: computeInputSchema,
    execute: async (input) => {
      const { code, data } = input;
      const result = await executeCompute(code, data ?? {});

      if (result.success) {
        return {
          success: true,
          result: result.result,
          logs: result.logs.length > 0 ? result.logs : undefined,
          duration_ms: result.duration_ms,
        };
      } else {
        return {
          success: false,
          error: result.error,
          logs: result.logs.length > 0 ? result.logs : undefined,
          duration_ms: result.duration_ms,
        };
      }
    },
  });
}

export const computeTool = defineTool({ meta, kind: 'static', create: () => createComputeTool() });
