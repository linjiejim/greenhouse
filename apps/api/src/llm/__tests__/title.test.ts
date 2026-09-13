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
import { cleanTitle } from '../title.js';

describe('cleanTitle', () => {
  it('keeps a well-formed title', () => {
    expect(cleanTitle('草坪洒水器品类调研')).toBe('草坪洒水器品类调研');
  });

  it('strips surrounding quotes and trailing punctuation', () => {
    expect(cleanTitle('"Lawn sprinkler research."')).toBe('Lawn sprinkler research');
    expect(cleanTitle('「洒水器调研」')).toBe('洒水器调研');
  });

  it('truncates a slightly long title rather than rejecting it', () => {
    const title = cleanTitle('A'.repeat(45));
    expect(title).toHaveLength(30);
    expect(title.endsWith('…')).toBe(true);
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
