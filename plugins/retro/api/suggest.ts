/**
 * The retro's "下月建议" — a short list the model writes from the aggregates
 * alone (no content ever reaches it, because the aggregates hold none).
 *
 * Metered to the organization (no member pays for it): service `llm`, client
 * `system`, through `createOrganizationAttemptBudgetHook`. Over budget, no
 * model configured or a failed call → the section is skipped and the doc says
 * why; the retro itself is never lost to it.
 */

import { generateText } from 'ai';
import {
  buildProviderOptions,
  createModelFromConfig,
  getAvailableProviders,
  resolveModelConfig,
  type ModelConfig,
} from '@greenhouse/api/extension-kit';
import { type DatabaseProvider } from '@greenhouse/api/extension-kit';
import { logger } from '@greenhouse/api/extension-kit';
import { toErrorMessage } from '@greenhouse/api/extension-kit';
import { createOrganizationAttemptBudgetHook } from '@greenhouse/api/extension-kit';
import { findBudgetRefusal } from '@greenhouse/api/extension-kit';
import { type RetroAggregates } from '@greenhouse/api/extension-kit';
import { usd, type RetroSuggestions } from './render.js';

const RETRO_MODEL_ID = 'flash';
const RETRO_MODEL: ModelConfig = { id: RETRO_MODEL_ID, provider: 'openai-compatible', model: RETRO_MODEL_ID };
export const RETRO_CALLER = 'monthly-retro';

const SYSTEM_PROMPT = [
  '你是一个团队的运营复盘助手。团队用 Greenhouse 作为成员 Agent 的中台：成员自己的 Agent 通过 MCP 读写团队的知识、文件、表格和服务。',
  '下面是一个月（month 字段）的汇总数字，只有计数与花费，没有任何对话内容。请据此写 3 到 5 条接下来一个月的建议：',
  '- 每条一行，以「- 」开头，先说做什么，再用括号给出依据的数字；',
  '- 只根据给出的数字，不要编造数据，也不要点名任何成员；',
  '- 关注：没人用的模块、失败或结果未知的 Agent 写入、反复出现的踩坑、积压的需求、花费集中的服务；',
  '- 只输出建议列表本身，不要标题和开场白。',
].join('\n');

/** The numbers the model sees — the same aggregates the doc shows, trimmed. */
function promptOf(a: RetroAggregates): string {
  return JSON.stringify(
    {
      month: a.month.month,
      page_opens_by_module: a.modules.page_opens.slice(0, 15),
      tool_calls_by_tool: a.modules.tool_calls.slice(0, 15),
      usage_by_client: a.modules.by_client,
      agent_writes: a.agents,
      frictions: a.frictions,
      feature_requests: a.requests,
      spend: {
        total: usd(a.spend.total_usd_micros),
        calls: a.spend.calls,
        unpriced_calls: a.spend.unpriced_calls,
        by_service: a.spend.by_service.map((row) => ({
          service: row.key,
          cost: usd(row.cost_usd_micros),
          calls: row.calls,
        })),
      },
    },
    null,
    1,
  );
}

export async function suggestNextMonth(db: DatabaseProvider, aggregates: RetroAggregates): Promise<RetroSuggestions> {
  if (getAvailableProviders(RETRO_MODEL_ID).length === 0) return { ok: false, reason: 'no_model' };
  try {
    const modelConfig = resolveModelConfig(RETRO_MODEL);
    const model = await createModelFromConfig(modelConfig, {
      onProviderAttempt: createOrganizationAttemptBudgetHook({
        db,
        caller: RETRO_CALLER,
        profileId: 'system',
        metadata: { retro_month: aggregates.month.month },
      }),
    });
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: promptOf(aggregates) }],
      temperature: 0.3,
      maxOutputTokens: 800,
      maxRetries: 1,
      providerOptions: buildProviderOptions(modelConfig),
    });
    const text = result.text.trim();
    return text ? { ok: true, text } : { ok: false, reason: 'failed' };
  } catch (err) {
    if (findBudgetRefusal(err)) return { ok: false, reason: 'over_budget' };
    logger.warn('[retro] could not write suggestions', { error: toErrorMessage(err) });
    return { ok: false, reason: 'failed' };
  }
}
