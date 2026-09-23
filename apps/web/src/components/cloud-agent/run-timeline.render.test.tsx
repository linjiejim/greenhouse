/**
 * Run timeline rendering — the replayed step-level view of a sandbox run.
 *
 * Pins the two readability fixes of 2026-08-03:
 *  - only the FIRST run.started renders (the runner used to emit one per
 *    provider-retry, painting a column of "Run started" rows; older runs'
 *    replayed events still carry those duplicates);
 *  - collapsed tool rows surface a one-line hint from their args (the bash
 *    command, a file path) so the timeline reads as what each step did.
 *
 * renderToStaticMarkup without an i18n provider uses the English fallback,
 * so assertions count translated label occurrences.
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunTimeline, formatTimelineTime } from './run-timeline';
import type { CloudAgentEvent } from '../../lib/api/cloud-agent';
import { translate } from '../../lib/i18n';

let seq = 0;
function ev(type: string, payload: Record<string, unknown> = {}): CloudAgentEvent {
  seq += 1;
  return {
    seq,
    type,
    payload: JSON.stringify(payload),
    created_at: '2026-08-03T07:13:43.779Z',
  } as CloudAgentEvent;
}

function render(events: CloudAgentEvent[], variant: 'detail' | 'summary' = 'detail'): string {
  return renderToStaticMarkup(createElement(RunTimeline, { events, variant }));
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('RunTimeline', () => {
  it('renders only the first run.started — retry duplicates from older runs collapse', () => {
    // The observed incident: 1 real start + 6 provider-retry re-emissions.
    const events = [
      ev('run.started', { model: 'deepseek-flash' }),
      ev('tool.started', { tool: 'bash', args: JSON.stringify({ command: 'ls -la ./inputs/' }) }),
      ev('tool.completed', { tool: 'bash', is_error: false, result: 'ok' }),
      ev('run.started', { model: 'deepseek-flash' }),
      ev('run.started', { model: 'deepseek-flash' }),
      ev('run.completed', { requests: 10 }),
    ];
    const html = render(events);
    expect(count(html, translate('en', 'cloudAgent.eventRunStarted'))).toBe(1);
    expect(count(html, translate('en', 'cloudAgent.eventRunCompleted'))).toBe(1);
  });

  it('shows a one-line args hint on the collapsed tool row', () => {
    const html = render([
      ev('tool.started', { tool: 'bash', args: JSON.stringify({ command: 'pdftoppm -r 300 -png manual.pdf page' }) }),
    ]);
    expect(html).toContain('pdftoppm -r 300 -png manual.pdf page');
  });

  it('never renders heartbeats', () => {
    const html = render([ev('run.heartbeat', { requests: 3 }), ev('run.started', {})]);
    expect(html).not.toContain('requests');
  });

  it('degrades an unparseable args payload to a plain row instead of crashing', () => {
    const html = render([ev('tool.started', { tool: 'bash', args: '{not json' })]);
    expect(html).toContain('bash');
  });

  it('keeps the dock summary focused on progress and omits assistant/tool outputs', () => {
    const html = render(
      [
        ev('run.started', {}),
        ev('message.assistant', { text: 'Important result belongs in Chat' }),
        ev('tool.started', { tool: 'bash', args: JSON.stringify({ command: 'inspect inputs' }) }),
        ev('tool.completed', { tool: 'bash', result: 'verbose tool output' }),
      ],
      'summary',
    );

    expect(html).toContain('inspect inputs');
    expect(html).not.toContain('Important result belongs in Chat');
    expect(html).not.toContain('verbose tool output');
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('data-timeline-scroll="bottom"');
    expect(html).toContain('data-step-number="1"');
    expect(html).toContain('data-step-number="2"');
  });

  it('shows only the clock for events from today', () => {
    const now = new Date('2026-08-13T16:00:00');
    expect(formatTimelineTime('2026-08-13T15:05:00', now)).not.toContain('2026');
    expect(formatTimelineTime('2026-08-12T15:05:00', now)).toContain('2026');
  });
});
