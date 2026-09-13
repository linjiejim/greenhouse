/**
 * `ask_user` 在飞书面的可见性。
 *
 * 这个渲染器存在的全部理由：`ask_user` 的 `presentation: 'artifact'` 让问题
 * 不进 assistant 正文，而飞书面只取 `result.text`——不从工具证据里捞出来，
 * 用户就只看到一句引导语，被问了什么完全不可见。
 */

import { describe, expect, it } from 'vitest';
import { renderAskUserFromEvidence } from '../ask-user.js';

const ask = (output: unknown) => [{ toolName: 'ask_user', output }];

describe('renderAskUserFromEvidence', () => {
  it('把问题与选项渲染出来 —— 这是它唯一的存在理由', () => {
    const out = renderAskUserFromEvidence(
      ask({
        type: 'ask_user',
        title: '报告偏好',
        description: '想先确认两件事',
        questions: [
          {
            id: 'range',
            label: '统计哪个区间？',
            type: 'single_choice',
            options: [
              { value: 'week', label: '最近 7 天' },
              { value: 'month', label: '本月' },
            ],
          },
          { id: 'focus', label: '重点关注什么？', type: 'text' },
        ],
      }),
    );

    expect(out).toContain('报告偏好');
    expect(out).toContain('想先确认两件事');
    expect(out).toContain('统计哪个区间？');
    expect(out).toContain('最近 7 天');
    expect(out).toContain('本月');
    expect(out).toContain('重点关注什么？');
    // 必须告诉用户怎么答——「回复」是会话延续的唯一入口，新发一条会开新链。
    expect(out).toContain('回复本条消息');
  });

  it('没有提问时返回 null，调用方照常只发正文', () => {
    expect(renderAskUserFromEvidence([])).toBeNull();
    expect(renderAskUserFromEvidence([{ toolName: 'crm_query', output: { rows: [] } }])).toBeNull();
  });

  it('模型写坏的输出不渲染，也不抛异常', () => {
    // 输出是模型写的，「形状对不对」不能假设。
    expect(renderAskUserFromEvidence(ask(null))).toBeNull();
    expect(renderAskUserFromEvidence(ask({ type: 'ask_user' }))).toBeNull();
    expect(renderAskUserFromEvidence(ask({ type: 'ask_user', questions: [] }))).toBeNull();
    expect(renderAskUserFromEvidence(ask({ type: 'ask_user', questions: [{ id: 'a' }] }))).toBeNull();
  });

  it('一题写坏不该让整组问题消失', () => {
    const out = renderAskUserFromEvidence(
      ask({
        type: 'ask_user',
        questions: [{ id: 'bad' }, { id: 'ok', label: '这题是好的', type: 'text' }],
      }),
    );
    expect(out).toContain('这题是好的');
  });

  it('一轮里问了两次就渲染两组 —— 漏掉任何一组都是同一个 bug', () => {
    const out = renderAskUserFromEvidence([
      { toolName: 'ask_user', output: { type: 'ask_user', questions: [{ id: 'a', label: '第一组', type: 'text' }] } },
      { toolName: 'ask_user', output: { type: 'ask_user', questions: [{ id: 'b', label: '第二组', type: 'text' }] } },
    ]);
    expect(out).toContain('第一组');
    expect(out).toContain('第二组');
  });

  it('多选题告诉用户可以多选', () => {
    const out = renderAskUserFromEvidence(
      ask({
        type: 'ask_user',
        questions: [
          {
            id: 'ch',
            label: '包含哪些板块？',
            type: 'multi_choice',
            options: [
              { value: 'a', label: '硬件故障' },
              { value: 'b', label: '配网问题' },
            ],
          },
        ],
      }),
    );
    expect(out).toContain('可多选');
  });
});
