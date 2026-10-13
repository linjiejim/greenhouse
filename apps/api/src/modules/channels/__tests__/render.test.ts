import { describe, expect, it } from 'vitest';
import { deepLink, linkPath, renderEmail, renderIm, renderPush, type Rendering } from '../render.js';

const card: Rendering = {
  locale: 'zh',
  category: 'needs_you',
  kind: 'request',
  requestKind: 'approval',
  from: 'Greeny',
  workspace: 'Acme',
  title: 'Greeny 请你批准：发邮件给 boss@acme.com',
  body: '主题：涨薪申请',
  link: 'https://gh.acme.com/#/c/cnv_1',
  previews: false,
  count: 1,
};

const run: Rendering = {
  ...card,
  category: 'runs',
  kind: 'run_done',
  requestKind: null,
  title: '后台运行完成：周报',
  body: '本周完成 12 项',
  link: 'https://gh.acme.com/#/c/cnv_2',
};

describe('rendering a delivered notification', () => {
  it('says only who wants what kind of thing without previews', () => {
    expect(renderPush(card)).toEqual({ title: 'Greeny', body: '请你批准一个操作' });
    expect(renderPush({ ...card, requestKind: 'takeover', locale: 'en' })).toEqual({
      title: 'Greeny',
      body: 'Needs you to take over the computer',
    });
    const email = renderEmail(card);
    expect(email.subject).toBe('Greeny：请你批准一个操作');
    expect(email.text).not.toContain('boss@acme.com');
    expect(email.text).not.toContain('涨薪');
    expect(email.text).toContain('https://gh.acme.com/#/c/cnv_1');
    expect(renderIm(card)).toBe('Greeny：请你批准一个操作\nhttps://gh.acme.com/#/c/cnv_1');
  });

  it('names the subject with previews, but never sends a sensitive body', () => {
    const on = { ...card, previews: true };
    expect(renderPush(on).body).toBe('Greeny 请你批准：发邮件给 boss@acme.com');
    const email = renderEmail(on);
    expect(email.subject).toBe('Greeny 请你批准：发邮件给 boss@acme.com');
    expect(email.text).not.toContain('涨薪申请');
    expect(email.html).not.toContain('涨薪申请');
    expect(renderIm(on)).not.toContain('涨薪申请');
    // Replies are sensitive too.
    const reply = {
      ...on,
      category: 'replies' as const,
      kind: 'reply' as const,
      title: 'Greeny 回复了',
      body: '密码是 hunter2',
    };
    expect(renderPush(reply).body).not.toContain('hunter2');
    expect(renderEmail(reply).text).not.toContain('hunter2');
  });

  it('carries the body of a run with previews on', () => {
    expect(renderPush({ ...run, previews: true }).body).toBe('后台运行完成：周报 · 本周完成 12 项');
    expect(renderEmail({ ...run, previews: true }).text).toContain('本周完成 12 项');
    expect(renderPush(run).body).toBe('后台运行完成了');
    expect(renderPush({ ...run, kind: 'run_failed', locale: 'en' }).body).toBe('A background run did not finish');
  });

  it('says how many notifications one message stands for', () => {
    expect(renderPush({ ...card, count: 3 }).body).toBe('请你批准一个操作（共 3 条）');
    expect(renderEmail({ ...card, count: 3, locale: 'en' }).subject).toBe('Greeny: Needs your approval (3 updates)');
  });

  it('escapes HTML and defuses markup in IM text', () => {
    const tricky = {
      ...run,
      previews: true,
      from: '<b>Bot</b>',
      title: 'Done <a href="https://evil.example">click</a>',
      body: '<script>alert(1)</script>',
    };
    const email = renderEmail(tricky);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('href="https://gh.acme.com/#/c/cnv_2"');
    const im = renderIm(tricky);
    expect(im).not.toMatch(/<a |<script>/);
    expect(im).toContain('‹a href');
  });

  it('keeps pushes short', () => {
    const long = renderPush({ ...run, previews: true, from: 'x'.repeat(100), title: 'y'.repeat(400) });
    expect(Array.from(long.title)).toHaveLength(60);
    expect(Array.from(long.body).length).toBeLessThanOrEqual(180);
    expect(long.body.endsWith('…')).toBe(true);
  });

  it('links back to the source', () => {
    expect(linkPath({ targetType: 'conversation', targetId: 'cnv_1', runId: 'run_1' })).toBe('/c/cnv_1');
    expect(linkPath({ targetType: 'request', targetId: 'req_1', runId: null })).toBe('/notifications');
    expect(linkPath({ targetType: null, targetId: null, runId: 'run_9' })).toBe('/runs/run_9');
    expect(linkPath({ targetType: 'agent', targetId: 'agt_1', runId: null })).toBe('/agents/agt_1');
    expect(deepLink('https://gh.acme.com/', '/c/cnv_1')).toBe('https://gh.acme.com/#/c/cnv_1');
  });
});
