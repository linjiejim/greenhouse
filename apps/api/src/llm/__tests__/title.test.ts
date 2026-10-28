/**
 * Session title sanitiser.
 *
 * The regression this locks down: a first message that asks for a deliverable
 * ("输出完整的 HTML 调研报告") makes the small title model start writing the
 * deliverable. The old cleaner truncated whatever came back to 30 characters,
 * so two dev sessions were stored titled "```html\n<!DOCTYPE html>\n<html…".
 * Rejecting answer-shaped output is what makes the caller fall back to the
 * user's own words.
 */

import { describe, expect, it } from 'vitest';
import { cleanTitle, titleLanguage } from '../title.js';

describe('cleanTitle', () => {
  it('keeps a well-formed title', () => {
    expect(cleanTitle('草坪洒水器品类调研')).toBe('草坪洒水器品类调研');
  });

  it('strips surrounding quotes and trailing punctuation', () => {
    expect(cleanTitle('"Lawn sprinkler research."')).toBe('Lawn sprinkler research');
    expect(cleanTitle('「洒水器调研」')).toBe('洒水器调研');
  });

  it('keeps a slightly long title whole rather than cutting it mid-word', () => {
    expect(cleanTitle('Schedule Friday 5pm weekly review')).toBe('Schedule Friday 5pm weekly review');
  });

  it.each([
    ['an HTML document', '```html\n<!DOCTYPE html>\n<html lang="zh-CN">\n<head>'],
    ['a bare doctype', '<!DOCTYPE html>'],
    ['an opening tag', '<html lang="zh-CN">'],
    ['a code fence', '```\nconst a = 1;\n```'],
    ['a markdown heading', '# 智能草坪洒水器品类调研'],
    ['a JSON payload', '{"title": "洒水器调研"}'],
    ['multi-line prose', '好的，我来帮你分析。\n首先看 OtO 的技术路线'],
  ])('rejects %s', (_label, raw) => {
    expect(cleanTitle(raw)).toBe('');
  });

  it('rejects a paragraph that is merely long, not truncating it into a title', () => {
    expect(cleanTitle('好的'.repeat(60))).toBe('');
  });

  it('rejects empty and single-character output', () => {
    expect(cleanTitle('   ')).toBe('');
    expect(cleanTitle('好')).toBe('');
  });
});

describe('titleLanguage', () => {
  it('follows the language of the first message, whatever the account says', () => {
    expect(titleLanguage('Create an automation that waters the plants every Monday', 'zh')).toBe('en');
    expect(titleLanguage('每周一提醒我给植物浇水', 'en')).toBe('zh');
  });

  it('reads a Chinese message with English terms as Chinese, and the reverse as English', () => {
    expect(titleLanguage('我们 CRM 里一共有多少家客户？其中 S 级有几家？', 'en')).toBe('zh');
    expect(titleLanguage('How do I say 你好 politely in French?', 'zh')).toBe('en');
  });

  it('ignores links and code when weighing the message', () => {
    expect(titleLanguage('总结 https://example.com/some/long/english/path/about/things', 'en')).toBe('zh');
    expect(titleLanguage('解释这段代码 ```const total = items.map((item) => item.price)```', 'en')).toBe('zh');
  });

  it('uses the account language when the message gives no clear signal', () => {
    expect(titleLanguage('https://example.com/report.pdf', 'zh')).toBe('zh');
    expect(titleLanguage('42?', 'en')).toBe('en');
    expect(titleLanguage('CRM 客户', 'zh')).toBe('zh');
    expect(titleLanguage('CRM 客户', 'en')).toBe('en');
    expect(titleLanguage('👍', null)).toBe('en');
  });
});
