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
      ['收件人', 'stranger@outside.example'],
      ['主题', 'Re: Partnership idea'],
      ['count', '3'],
    ]);
  });

  it('reads a plain object too, and nothing else', () => {
    expect(detailRows({ repo: 'acme/web', labels: ['bug'] })).toEqual([
      ['repo', 'acme/web'],
      ['labels', '["bug"]'],
    ]);
    expect(detailRows(null)).toEqual([]);
    expect(detailRows('text')).toEqual([]);
  });
});
