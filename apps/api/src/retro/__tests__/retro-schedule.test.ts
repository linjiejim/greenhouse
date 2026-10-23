/**
 * The retro's schedule and rendering, without a database: the job is
 * registered for 09:00 on the 1st in the workspace zone and follows a zone
 * change; the cron targets the month that just ended in that zone; the doc
 * renders aggregates as tables (cells escaped) and says why suggestions are
 * missing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const zone = vi.hoisted(() => ({ current: 'Asia/Shanghai' }));

vi.mock('../../hub-context/settings.js', () => ({
  workspaceTimeZone: async () => zone.current,
}));

import {
  MONTHLY_RETRO_CRON,
  monthlyRetroNextRun,
  startMonthlyRetroJob,
  stopUpkeepJobs,
} from '../../scheduler/upkeep-jobs.js';
import { frictionErrorClass, previousMonthIn, retroMonth, type RetroAggregates } from '../aggregate.js';
import { renderRetroMarkdown } from '../render.js';

afterEach(() => {
  stopUpkeepJobs();
  zone.current = 'Asia/Shanghai';
});

describe('monthly retro schedule', () => {
  it('runs at 09:00 on the 1st, workspace time, and follows a zone change', async () => {
    const job = await startMonthlyRetroJob();
    expect(job?.getPattern()).toBe(MONTHLY_RETRO_CRON);
    const next = monthlyRetroNextRun()!;
    // 09:00 in Shanghai (UTC+8) is 01:00 UTC on the 1st.
    expect(next.getUTCDate()).toBe(1);
    expect(next.getUTCHours()).toBe(1);
    expect(next.getUTCMinutes()).toBe(0);

    zone.current = 'UTC';
    await startMonthlyRetroJob();
    expect(monthlyRetroNextRun()!.getUTCHours()).toBe(9);
  });

  it('targets the month that just ended in the workspace zone', () => {
    // 2026-11-01 01:00 UTC is 09:00 on the 1st in Shanghai.
    expect(previousMonthIn(new Date('2026-11-01T01:00:00Z'), 'Asia/Shanghai')).toBe('2026-10');
    expect(previousMonthIn(new Date('2027-01-01T09:00:00Z'), 'UTC')).toBe('2026-12');
  });
});

describe('retro document', () => {
  const aggregates: RetroAggregates = {
    month: retroMonth('2026-10')!,
    modules: {
      page_opens: [{ key: 'knowledge', count: 12 }],
      tool_calls: [{ key: 'tables_query', count: 30 }],
      by_client: [{ client: 'web', page_opens: 12, tool_calls: 5 }],
    },
    agents: {
      writes: 4,
      members: 2,
      by_client: [{ client: 'Codex', writes: 4, executed: 2, failed: 1, outcome_unknown: 1 }],
    },
    frictions: {
      seen: 1,
      new: 1,
      top: [{ tool: 'tables_query', kind: 'tool_error', error_class: 'not_found', frictions: 2, occurrences: 3 }],
    },
    requests: {
      submitted: 1,
      by_status: { pending: 1, accepted: 0, rejected: 0, done: 0 },
      top: [{ title: 'PDF export', status: 'pending', priority: 'normal' }],
    },
    spend: {
      total_usd_micros: 1_230_000,
      calls: 7,
      unpriced_calls: 2,
      by_service: [{ key: 'llm', cost_usd_micros: 1_230_000, calls: 7 }],
      by_client: [{ key: 'mcp', cost_usd_micros: 1_230_000, calls: 7 }],
    },
  };

  it('renders every section as tables, escaping cell text', () => {
    const markdown = renderRetroMarkdown({
      aggregates,
      suggestions: { ok: true, text: '- 建议' },
      generatedAt: new Date('2026-11-01T01:00:00Z'),
      timeZone: 'Asia/Shanghai',
    });
    expect(markdown.startsWith('# 2026-10 复盘\n')).toBe(true);
    expect(markdown).toContain('| Codex | 4 | 2 | 1 | 1 |');
    expect(markdown).toContain('失败 1 次，结果未知 1 次');
    expect(markdown).toContain('| tables_query | 工具报错 | 找不到对象 | 2 | 3 |');
    expect(markdown).toContain('本月提交 1 条：待处理 1');
    expect(markdown).toContain('本月合计 $1.23，7 次计价调用（其中 2 次未定价，按 0 计）。');
    expect(markdown.trimEnd().endsWith('- 建议')).toBe(true);
  });

  it('classifies a friction by its error without passing its words on', () => {
    expect(frictionErrorClass('Doc "Q3 plan" not found')).toBe('not_found');
    expect(frictionErrorClass('Permission denied for user Ada')).toBe('permission');
    expect(frictionErrorClass('tableId is required')).toBe('invalid_input');
    expect(frictionErrorClass('upstream timed out')).toBe('timeout');
    expect(frictionErrorClass('Ada wanted a summary of the board meeting')).toBe('other');
  });

  it('escapes table cells', () => {
    const markdown = renderRetroMarkdown({
      aggregates: {
        ...aggregates,
        requests: { ...aggregates.requests, top: [{ title: 'A | B', status: 'pending', priority: 'normal' }] },
      },
      suggestions: { ok: true, text: '-' },
      generatedAt: new Date(),
      timeZone: 'UTC',
    });
    expect(markdown).toContain('| A \\| B | 待处理 | normal |');
  });

  it('says why the suggestions are missing', () => {
    const markdown = renderRetroMarkdown({
      aggregates,
      suggestions: { ok: false, reason: 'over_budget' },
      generatedAt: new Date(),
      timeZone: 'UTC',
    });
    expect(markdown).toContain('团队本月的模型额度已用完');
  });
});
