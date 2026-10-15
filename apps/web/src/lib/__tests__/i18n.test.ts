import { expect, it } from 'vitest';
import { translate } from '../i18n';

it('spaces Latin names and numbers beside Chinese without splitting Chinese words', () => {
  expect(translate('zh', 'chat.computerOf', { name: 'Greeny' })).toBe('Greeny 的电脑');
  expect(translate('zh', 'chat.computerOf', { name: '绿绿' })).toBe('绿绿的电脑');
  expect(translate('zh', 'directory.searchIn', { name: '知识库' })).toBe('搜索知识库');
  expect(translate('zh', 'access.lastUsed', { time: '刚刚' })).toBe('刚刚用过');
  expect(translate('zh', 'access.lastUsed', { time: '12 分钟前' })).toBe('12 分钟前用过');
  expect(translate('zh', 'access.lastUsed', { time: '14:20' })).toBe('14:20 用过');
  expect(translate('zh', 'memory.count', { count: 3 })).toBe('3 条记忆');
  expect(translate('zh', 'tables.timeline.bar', { name: '首页设计', start: '10 月 20 日', end: '10 月 23 日' })).toBe(
    '首页设计：10 月 20 日 到 10 月 23 日',
  );
  expect(translate('zh', 'tables.timeline.bar', { name: '首页设计', start: '昨天', end: '今天' })).toBe(
    '首页设计：昨天 到 今天',
  );
  expect(translate('en', 'chat.computerOf', { name: 'Greeny' })).toBe('Greeny’s computer');
  expect(translate('zh', 'chat.computerOf')).toBe('{name} 的电脑');
});
