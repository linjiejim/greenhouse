import { z } from 'zod';
import { defineTool } from '../tools/define.js';
import { expect, it } from 'vitest';
import { approvalStep, argumentDetails, toolSummary } from '../tools/presentation.js';

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
  expect(summary).toBe('查看表格失败：服务未能完成这次操作，请稍后重试');
  expect(summary).not.toContain('table_query');
  expect(summary).not.toContain('tbl_private');
});
