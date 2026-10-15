import { expect, it } from 'vitest';
import { interpolate } from './format';

it('joins Chinese names to Chinese copy and preserves Latin names, digits and English spacing', () => {
  const template = '这是 {name} 自己的电脑。{name} 需要时会自动开机';
  expect(interpolate('zh', template, { name: '发布助手' })).toBe('这是发布助手自己的电脑。发布助手需要时会自动开机');
  expect(interpolate('zh', template, { name: 'Greeny' })).toBe('这是 Greeny 自己的电脑。Greeny 需要时会自动开机');
  expect(interpolate('zh', '还有 {n} 条', { n: 2 })).toBe('还有 2 条');
  expect(interpolate('en', 'This is {name} computer', { name: '发布助手' })).toBe('This is 发布助手 computer');
  expect(interpolate('zh', '{from} 到 {to}', { from: '昨天', to: '今天' })).toBe('昨天 到 今天');
});
