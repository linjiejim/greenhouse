/**
 * The over-budget contract — one error type for every refusal the budget layer
 * makes before provider I/O, and the words each surface shows for it.
 *
 * A refusal is the one failure whose real message must reach whoever asked:
 * the text is ours, nothing was charged, and "please retry" would be false —
 * every retry is refused the same way. So:
 *   - MCP returns `message` as a tool error (`isError: true`);
 *   - a tool in Chat / automations throws it, the model reads it and relays it;
 *   - a refused model call in Chat shows `localizedBudgetNotice()` inline;
 *   - an automation is recorded as failed with `message` as the reason.
 *
 * Leaf module: imported by both the token budget (llm/usage-budget.ts) and the
 * USD meter (usage/metering.ts), so neither imports the other's error.
 */

import type { BudgetLevel, MeteredService } from '@greenhouse/types/metering';

/** Which budget refused. Token refusals predate USD metering and keep their own words. */
export interface BudgetRefusal {
  unit: 'usd_micros' | 'tokens';
  level: BudgetLevel;
  service?: MeteredService;
}

export class UsageBudgetAdmissionError extends Error {
  constructor(
    message: string,
    public readonly status: 403 | 429 | 503,
    public readonly code: string,
    options?: ErrorOptions,
    public readonly refusal?: BudgetRefusal,
  ) {
    super(message, options);
    this.name = 'UsageBudgetAdmissionError';
  }
}

const SERVICE_NAMES: Record<MeteredService, { zh: string; en: string }> = {
  llm: { zh: '模型', en: 'model' },
  vision: { zh: '识图', en: 'image understanding' },
  web_search: { zh: '网页搜索', en: 'web search' },
  page_read: { zh: '网页读取', en: 'page reading' },
  image_generation: { zh: '生图', en: 'image generation' },
  computer: { zh: '云电脑', en: 'cloud computer' },
};

function scopeName(refusal: BudgetRefusal, language: 'zh' | 'en'): string {
  if (refusal.level === 'member') return language === 'zh' ? '个人额度' : 'member budget';
  if (refusal.level === 'organization') return language === 'zh' ? '团队额度' : 'team budget';
  const service = refusal.service ? SERVICE_NAMES[refusal.service] : undefined;
  if (language === 'zh') return `「${service?.zh ?? refusal.service ?? '服务'}」服务额度`;
  return `${service?.en ?? refusal.service ?? 'service'} budget`;
}

/** One language, for a person reading Chat. */
export function localizedBudgetNotice(refusal: BudgetRefusal, locale?: string): string {
  if (locale === 'en') {
    return `This month's ${scopeName(refusal, 'en')} is used up, so retrying will not help. Ask an administrator to raise it.`;
  }
  return `本月${scopeName(refusal, 'zh')}已用完，重试不会成功。请联系管理员提高额度。`;
}

/** Both languages, for an agent: the error text MCP and tools return. */
export function budgetExceededMessage(refusal: BudgetRefusal): string {
  return `${localizedBudgetNotice(refusal, 'zh')} (${localizedBudgetNotice(refusal, 'en')})`;
}

/**
 * The admission refusal behind `err`, if any. The AI SDK wraps provider-attempt
 * failures (RetryError and friends) before they surface, so walk the cause chain.
 */
export function findUsageBudgetAdmission(err: unknown): UsageBudgetAdmissionError | null {
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < 5; depth++) {
    if (cursor instanceof UsageBudgetAdmissionError) return cursor;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

/** An over-budget refusal (as opposed to "budget service unavailable"). */
export function findBudgetRefusal(err: unknown): UsageBudgetAdmissionError | null {
  const admission = findUsageBudgetAdmission(err);
  return admission && admission.status === 429 ? admission : null;
}

/** The text a failed run or tool should record: the refusal's own words, or null for any other failure. */
export function budgetRefusalReason(err: unknown): string | null {
  return findBudgetRefusal(err)?.message ?? null;
}
