import { describe, expect, it } from 'vitest';
import { speechChunks, speechText } from '../speech';

describe('speechText', () => {
  it('reads the prose without marks, code, tables or pictures', () => {
    const reply = [
      '# 本周进度',
      '',
      '完成了 **登录页** 和 *注册页*，见 [设计稿](https://example.com/design)。',
      '',
      '- 修了 `api` 的超时',
      '- 加了 ~~两个~~ 三个测试',
      '',
      '```ts',
      'const secret = 1;',
      '```',
      '',
      '| 模块 | 状态 |',
      '| --- | --- |',
      '| 登录 | 完成 |',
      '',
      '![chart](/api/files/fil_1/content)',
      '',
      '> 下周上线',
    ].join('\n');
    expect(speechText(reply)).toBe(
      ['本周进度', '完成了 登录页 和 注册页，见 设计稿。', '修了 api 的超时', '加了 两个 三个测试', '下周上线'].join(
        '\n',
      ),
    );
  });

  it('leaves out Rich Output blocks and keeps the words around them', () => {
    const reply = [
      '结果如下：',
      '',
      '```stats',
      '{"items":[{"label":"用户","value":"120"}]}',
      '```',
      '',
      '以上。',
    ].join('\n');
    expect(speechText(reply)).toBe('结果如下：\n以上。');
  });

  it('reads a mention by its name and an empty reply as nothing', () => {
    expect(speechText('问一下 [@Mei](member:mbr_1) 吧')).toBe('问一下 @Mei 吧');
    expect(speechText('```\nonly code\n```')).toBe('');
  });
});

describe('speechChunks', () => {
  it('cuts at the ends of sentences, within the limit', () => {
    const text = '第一句话。第二句话！Third one. Fourth?';
    expect(speechChunks(text, 12)).toEqual(['第一句话。 第二句话！', 'Third one.', 'Fourth?']);
    expect(speechChunks(text, 100)).toEqual(['第一句话。 第二句话！ Third one. Fourth?']);
  });

  it('cuts a sentence longer than the limit where it must', () => {
    expect(speechChunks('一二三四五六七八九十', 4)).toEqual(['一二三四', '五六七八', '九十']);
    expect(speechChunks('', 10)).toEqual([]);
  });
});
