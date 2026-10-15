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
  expect(toolSummary({ tool: 'vendor_raw_id', input: {}, status: 'failed' }, new Map(), 'zh')).toBe('操作未完成');
  expect(approvalStep('新建文档', 'uncertain', 'zh')).toBe('结果未知：新建文档');
});
