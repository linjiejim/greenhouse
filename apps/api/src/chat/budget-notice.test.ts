/**
 * What Chat says when a model call was refused for budget: the refusal's own
 * words in the reader's language, through whatever the AI SDK wrapped it in.
 */

import { describe, expect, it } from 'vitest';
import { budgetExceededMessage, UsageBudgetAdmissionError, type BudgetRefusal } from '../usage/budget-errors.js';
import { usageBudgetNotice } from './turn.js';

function refused(refusal: BudgetRefusal) {
  return new UsageBudgetAdmissionError(
    budgetExceededMessage(refusal),
    429,
    'usage_budget_exceeded',
    undefined,
    refusal,
  );
}

describe('usageBudgetNotice', () => {
  it('names the USD budget that ran out, in one language', () => {
    const wrapped = new Error('Failed after 3 attempts', {
      cause: refused({ unit: 'usd_micros', level: 'service', service: 'llm' }),
    });
    expect(usageBudgetNotice(wrapped, 'zh')).toBe('本月「模型」服务额度已用完，重试不会成功。请联系管理员提高额度。');
    expect(usageBudgetNotice(wrapped, 'en')).toBe(
      "This month's model budget is used up, so retrying will not help. Ask an administrator to raise it.",
    );
  });

  it('keeps the token wording for the parallel token budget, and stays out of other failures', () => {
    const tokens = new UsageBudgetAdmissionError('Monthly token budget exceeded.', 429, 'usage_budget_exceeded');
    expect(usageBudgetNotice(tokens, 'zh')).toMatch(/Token 额度/);
    expect(usageBudgetNotice(new Error('provider 500'), 'zh')).toBeNull();
  });
});
