import { expect, it } from 'vitest';
import { han } from '../i18n.js';
it('joins Han names and spaces Latin names and digits', () => {
  expect(han`在 ${'发布准备'} 新建文档《${'清单'}》`).toBe('在发布准备新建文档《清单》');
  expect(han`在 ${'Launch'} 新建文档`).toBe('在 Launch 新建文档');
  expect(han`文档超过 ${200} 篇`).toBe('文档超过 200 篇');
  expect(han`${'Greeny'}的电脑`).toBe('Greeny 的电脑');
  expect(han`Mail from ${'Lin'} (${3})`).toBe('Mail from Lin (3)');
  expect(han`${'2026-10-01'} 至 ${'2026-10-02'}`).toBe('2026-10-01 至 2026-10-02');
});
