import { describe, expect, it } from 'vitest';
import { CANCEL_DISTANCE, cancelArmed, dictatedMessage, dictationLocale } from './dictation';

describe('hold to talk', () => {
  it('cancels only after sliding far enough up', () => {
    expect(cancelArmed(-CANCEL_DISTANCE)).toBe(true);
    expect(cancelArmed(-10)).toBe(false);
    expect(cancelArmed(40)).toBe(false);
  });

  it('sends the draft with what was heard, and nothing for silence', () => {
    expect(dictatedMessage('', ' 帮我写周报 ')).toBe('帮我写周报');
    expect(dictatedMessage('关于这个文档：', '总结一下')).toBe('关于这个文档： 总结一下');
    expect(dictatedMessage('draft', '   ')).toBeNull();
  });

  it('listens in the app’s language', () => {
    expect(dictationLocale('zh')).toBe('zh-CN');
    expect(dictationLocale('en')).toBe('en-US');
  });
});
