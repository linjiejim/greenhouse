/**
 * @vitest-environment happy-dom
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CloudAgentEvent } from '../../lib/api/cloud-agent';
import { I18nProvider } from '../../lib/i18n';
import { extractMissionAssistantUpdates, MissionProgressMessages } from './mission-progress-messages';

function event(type: string, payload: Record<string, unknown>, seq = 1): CloudAgentEvent {
  return {
    seq,
    type,
    payload: JSON.stringify(payload),
    created_at: '2026-08-13T08:00:00.000Z',
  } as CloudAgentEvent;
}

describe('MissionProgressMessages', () => {
  it('extracts only readable assistant updates from the event journal', () => {
    expect(
      extractMissionAssistantUpdates([
        event('tool.completed', { result: 'private tool output' }),
        event('message.assistant', { text: 'First useful update', model: 'pro' }, 2),
        event('message.assistant', { text: '' }, 3),
      ]),
    ).toEqual([
      {
        seq: 2,
        text: 'First useful update',
        model: 'pro',
        createdAt: '2026-08-13T08:00:00.000Z',
      },
    ]);
  });

  it('shows a quiet working row before the first update and hides after the run settles', () => {
    const render = (active: boolean) =>
      renderToStaticMarkup(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(MissionProgressMessages, { events: [], active }),
        }),
      );

    expect(render(true)).toContain('Mission is working…');
    expect(render(false)).toBe('');
  });

  it('renders assistant updates in the Chat reading flow', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(MissionProgressMessages, {
          active: true,
          events: [event('message.assistant', { text: '**Important finding**', model: 'pro' })],
        }),
      }),
    );

    expect(html).toContain('Mission update');
    expect(html).toContain('<strong>Important finding</strong>');
  });
});
