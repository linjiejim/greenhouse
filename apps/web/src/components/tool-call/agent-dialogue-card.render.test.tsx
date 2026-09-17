/** @vitest-environment happy-dom */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { AgentDialogueCard } from './agent-dialogue-card';
import { isArtifactCall } from './body-artifacts';

describe('bilateral dialogue card', () => {
  it('shows the real participants and both rounds, including a failed reply without inventing one', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'zh',
        children: createElement(AgentDialogueCard, {
          call: {
            name: 'agent_chat',
            output: {
              type: 'agent_dialogue',
              dialogue_id: 'd1',
              from_name: '研究同事',
              to_name: '产品同事',
              rounds: [
                {
                  id: 'r1',
                  round: 1,
                  message: '你怎么看这个证据？',
                  reply: '需要补充时间范围。',
                  status: 'succeeded',
                  error: null,
                },
                {
                  id: 'r2',
                  round: 2,
                  message: '那我们先核实时间。',
                  reply: null,
                  status: 'failed',
                  error: 'The peer stopped.',
                },
              ],
            },
          },
        }),
      }),
    );
    for (const copy of ['研究同事', '产品同事', '第 2 轮', '你怎么看这个证据？', '需要补充时间范围。', '回复中断'])
      expect(html).toContain(copy);
    expect(html).toContain('<details');
    expect(html).not.toContain('textarea');
  });
  it('leaves authorization failures in the tool trace', () => {
    expect(isArtifactCall({ name: 'agent_chat', output: { error: 'Forbidden' } })).toBe(false);
    expect(isArtifactCall({ name: 'agent_chat', output: { colleagues: [] } })).toBe(false);
    expect(isArtifactCall({ name: 'agent_chat', output: { type: 'agent_dialogue' } })).toBe(true);
  });
});
