import { describe, expect, it } from 'vitest';
import { detailRows } from '../status';

describe("an approval card's details", () => {
  it("reads the engine's label and value pairs in their order", () => {
    expect(
      detailRows([
        { label: '收件人', value: 'stranger@outside.example' },
        { label: '主题', value: 'Re: Partnership idea' },
        { label: 'count', value: 3 },
        'not a row',
      ]),
    ).toEqual([
      { label: '收件人', value: 'stranger@outside.example' },
      { label: '主题', value: 'Re: Partnership idea' },
      { label: 'count', value: '3' },
    ]);
  });

  it('keeps rendering hints with their row even when another entry is invalid', () => {
    expect(
      detailRows([
        'invalid',
        { label: '阶段', value: '单选 · 新客户', chips: ['新客户', {}] },
        { label: '内容', value: '**摘要**', format: 'markdown' },
      ]),
    ).toEqual([
      { label: '阶段', value: '单选 · 新客户', chips: ['新客户'] },
      { label: '内容', value: '**摘要**', format: 'markdown' },
    ]);
  });

  it('reads a plain object too, and nothing else', () => {
    expect(detailRows({ repo: 'acme/web', labels: ['bug'] })).toEqual([
      { label: 'repo', value: 'acme/web' },
      { label: 'labels', value: 'bug' },
    ]);
    expect(detailRows(null)).toEqual([]);
    expect(detailRows('text')).toEqual([]);
  });
});
