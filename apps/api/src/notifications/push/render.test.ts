import { describe, expect, it } from 'vitest';

import type { PushEnvelope } from './policy.js';
import { excerptOf, PUSH_EXCERPT_CHARS, renderPush, renderTestPush } from './render.js';

const card = (request_kind: NonNullable<PushEnvelope['request_kind']>): PushEnvelope => ({
  k: 'needs_you',
  sid: 'bots-dm-1',
  open: 'bots',
  rid: 'brq_1',
  request_kind,
});
const reply: PushEnvelope = { k: 'replies', sid: 'bots-dm-1', open: 'bots', message_id: 'msg-1' };
const task = (ok: boolean): PushEnvelope => ({ k: 'done', sid: 'bots-dm-1', open: 'bots', ok });
const automation = (ok: boolean): PushEnvelope => ({ k: 'done', sid: 'session-1', open: 'chat', ok });

const base = { botName: 'Sprouty', fallbackTitle: 'Greenhouse' };

describe('push words', () => {
  it('says only who and what kind of thing by default — in Chinese and English', () => {
    const secret = { subject: '发送邮件给 王总', excerpt: '合同金额 80 万，周五前签' };
    expect(renderPush({ ...base, ...secret, locale: 'zh', envelope: card('approval'), preview: false })).toEqual({
      title: 'Sprouty',
      body: '请你批准一个操作',
    });
    expect(renderPush({ ...base, ...secret, locale: 'en', envelope: card('approval'), preview: false })).toEqual({
      title: 'Sprouty',
      body: 'Needs your approval',
    });
    const zh = (envelope: PushEnvelope) =>
      renderPush({ ...base, ...secret, locale: 'zh', envelope, preview: false }).body;
    expect(zh(card('login'))).toBe('需要你登录一个网站');
    expect(zh(card('takeover'))).toBe('需要你接手电脑');
    expect(zh(card('bot_create'))).toBe('提议新建一个 Bot');
    expect(zh(card('task_start'))).toBe('提议一个后台任务');
    expect(zh(reply)).toBe('回复了你');
    expect(zh(task(true))).toBe('后台任务完成了');
    expect(zh(task(false))).toBe('后台任务没能完成');
    expect(zh(automation(true))).toBe('定时任务完成了');
    expect(zh(automation(false))).toBe('定时任务失败了');
    for (const envelope of [card('approval'), reply, task(true), automation(true)]) {
      const words = JSON.stringify(renderPush({ ...base, ...secret, locale: 'zh', envelope, preview: false }));
      expect(words).not.toContain('王总');
      expect(words).not.toContain('80 万');
    }
  });

  it('names the subject and the first words when the device shows previews', () => {
    const on = (locale: 'zh' | 'en', envelope: PushEnvelope, subject: string | null, excerpt: string | null = null) =>
      renderPush({ ...base, locale, envelope, preview: true, subject, excerpt }).body;
    expect(on('zh', card('approval'), '发送邮件')).toBe('请你批准：发送邮件');
    expect(on('en', card('approval'), 'send an email')).toBe('Asks to send an email');
    expect(on('zh', card('login'), 'example.com')).toBe('需要你登录 example.com');
    expect(on('zh', card('bot_create'), '小润')).toBe('提议新建「小润」');
    expect(on('zh', task(true), '竞品调研')).toBe('「竞品调研」完成了');
    expect(on('en', task(false), 'Vendor scan')).toBe("“Vendor scan” didn't finish");
    expect(on('zh', automation(true), '每周到期任务汇总', '本周有 **3** 个任务到期')).toBe(
      '「每周到期任务汇总」：本周有 3 个任务到期',
    );
    expect(on('zh', automation(false), '每周到期任务汇总', 'Provider timed out')).toBe('「每周到期任务汇总」失败了');
    expect(on('zh', reply, null, '找到了三家供应商，见下表。')).toBe('找到了三家供应商，见下表。');
    // a reply that is only a block has no words to show
    expect(on('zh', reply, null, '```chart\n{"type":"bar"}\n```')).toBe('回复了你');
  });

  it('titles with the Bot, or the workspace when no Bot speaks', () => {
    expect(renderPush({ ...base, botName: null, locale: 'zh', envelope: automation(true), preview: false }).title).toBe(
      'Greenhouse',
    );
    expect(renderTestPush('zh', 'Greenhouse').body).toContain('测试');
  });
});

describe('excerptOf', () => {
  it('turns chat markdown into one plain line, at most the excerpt length', () => {
    expect(excerptOf('# 结论\n\n**三家** 供应商：[A](https://a.example) 与 `B`\n\n![img](x.png)')).toBe(
      '结论 三家 供应商：A 与 B',
    );
    const long = '很长'.repeat(100);
    const clipped = excerptOf(long);
    expect(Array.from(clipped)).toHaveLength(PUSH_EXCERPT_CHARS);
    expect(clipped.endsWith('…')).toBe(true);
    expect(excerptOf('```python\nprint(1)\n```')).toBe('');
  });
});
