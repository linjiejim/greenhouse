import { ProviderRequestError } from '@greenhouse/providers';
import { ApiError } from '../../http/errors.js';
import { z } from 'zod';
import { defineTool } from '../tools/define.js';
import { expect, it } from 'vitest';
import { approvalStep, argumentDetails, failureReason, toolSummary } from '../tools/presentation.js';

it('formats nested arguments as readable text and never exposes a raw fallback tool name', () => {
  expect(argumentDetails({ to: 'a@example.com', values: { Priority: ['High', 'New'] }, required: true }, 'zh')).toEqual(
    [
      { label: '收件人', value: 'a@example.com' },
      { label: '字段值', value: 'Priority：High · New' },
      { label: '必填', value: '是' },
    ],
  );
  expect(toolSummary({ tool: 'vendor_raw_id', input: {}, status: 'done' }, new Map(), 'zh')).toBe('完成了操作');
  expect(toolSummary({ tool: 'vendor_raw_id', input: {}, status: 'failed' }, new Map(), 'zh')).toBe(
    '操作未完成：请检查输入和访问权限',
  );
  expect(approvalStep('新建文档', 'uncertain', 'zh')).toBe('结果未知：新建文档');
});

it('keeps unexpected service errors out of member-facing step copy', () => {
  const defs = new Map([
    [
      'table_query',
      defineTool({
        name: 'table_query',
        description: 'Read tables.',
        input: z.object({}),
        risk: 'read',
        execute: async () => ({}),
        summarize: () => '查看了表格',
      }),
    ],
  ]);
  const summary = toolSummary(
    { tool: 'table_query', input: {}, status: 'failed', error: 'table_query failed with {"id":"tbl_private"}' },
    defs,
    'zh',
  );
  expect(summary).toBe('查看表格失败：服务暂时不可用，请稍后重试或换一个来源');
  expect(summary).not.toContain('table_query');
  expect(summary).not.toContain('tbl_private');
});

it.each([
  [new ApiError(403, 'web_page_refused', 'private'), '网站拒绝访问', 'refused access'],
  [
    new ProviderRequestError('Firecrawl could not read the page: it answered HTTP 403.'),
    '网站拒绝访问',
    'refused access',
  ],
  [new ProviderRequestError('Scrape failed: 403 blocked', 500), '网站拒绝访问', 'refused access'],
  [
    new ProviderRequestError('Jina page reader failed (HTTP 403): API key refused', 403),
    '服务拒绝访问',
    'service refused access',
  ],
  [new ProviderRequestError('private', 404), '不存在', 'not found'],
  [new ProviderRequestError('private', 408), '超时', 'timed out'],
  [new ProviderRequestError('private', 413), '内容太长', 'too large'],
  [new ProviderRequestError('private', 429), '请求过于频繁', 'rate limited'],
  [new ApiError(503, 'search_not_configured', 'private'), '尚未配置搜索', 'No search service'],
  [new ApiError(403, 'web_address_blocked', 'private'), '受限网络', 'restricted network'],
])('explains the cause without vendor text (%s)', (error, zh, en) => {
  expect(failureReason(error, 'web_fetch', 'zh')).toContain(zh);
  expect(failureReason(error, 'web_fetch', 'en')).toContain(en);
  expect(failureReason(error, 'web_fetch', 'zh')).not.toContain('private');
});

it('keeps Han words joined and Latin boundaries spaced in approval steps', () => {
  expect(approvalStep('新建定时「周报」', 'pending', 'zh')).toBe('请求新建定时「周报」 · 等你批准');
  expect(approvalStep('Greeny', 'pending', 'zh')).toBe('请求 Greeny · 等你批准');
});
