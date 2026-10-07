/**
 * @vitest-environment happy-dom
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotRequestView, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import type { BotMessage } from '../../lib/api/bots';
import type { BotStreamSegment } from '../../lib/session-manager';
import { BotTranscript, type BotTranscriptProps } from './bot-transcript';

function bot(id: string, name: string, role: string): BotView {
  return {
    id,
    name,
    role,
    instructions: '',
    avatar: { color: 'forest' },
    model_id: null,
    template_key: null,
    status: 'active',
    description: '',
    tools: null,
    max_steps: null,
    current_version: 1,
    user_id: 'u1',
    updated_at: '2026-10-05T00:00:00.000Z',
    dm_session_id: null,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

const ivy = bot('bot_ivy', 'Ivy', 'Chief of staff');
const sage = bot('bot_sage', 'Sage', 'Researcher');
const fern = bot('bot_fern', 'Fern', 'Writer');
const all = [ivy, sage, fern];

let seq = 0;
function msg(partial: Partial<BotMessage>): BotMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    role: 'assistant',
    content: `reply ${seq}`,
    bot_id: null,
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: '2026-10-05T00:00:00.000Z',
    seq,
    ...partial,
  };
}

function render(overrides: Partial<BotTranscriptProps>) {
  const props: BotTranscriptProps = {
    sessionId: 's1',
    kind: 'direct',
    title: 'Ivy',
    ownerBotId: ivy.id,
    members: [ivy],
    lookup: (key) => all.find((candidate) => candidate.id === key || candidate.name === key),
    messages: [],
    hasMore: false,
    loadingEarlier: false,
    onLoadEarlier: vi.fn(),
    segments: [],
    liveRequests: [],
    pending: [],
    requests: new Map(),
    busy: false,
    runError: null,
    onDismissRunError: vi.fn(),
    vaultAvailable: true,
    onRequestSettled: vi.fn(),
    onStale: vi.fn(),
    onOpenComputer: vi.fn(),
    onViewSummary: vi.fn(),
    onAddress: vi.fn(),
    onSendText: vi.fn(),
    onStarter: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <BotTranscript {...props} />
    </I18nProvider>,
  );
}

const headers = (html: string) => [...html.matchAll(/data-testid="bots-speaker">([^<]+)<\/span>/g)].map((m) => m[1]);

describe('BotTranscript', () => {
  it('renders a DM owner in the flush Chat style — no per-message speaker header', () => {
    const html = render({
      messages: [msg({ role: 'user', content: 'plan my week' }), msg({ bot_id: ivy.id }), msg({ bot_id: ivy.id })],
    });
    expect(headers(html)).toEqual([]);
    expect(html).toContain('This is the beginning of your conversation with Ivy.');
  });

  it('names a speaker only when the speaker changes, and draws the hand-off strip', () => {
    const html = render({
      kind: 'group',
      title: 'Launch prep',
      ownerBotId: null,
      members: all,
      messages: [
        msg({ role: 'user', content: 'go' }),
        msg({ bot_id: sage.id }),
        msg({ bot_id: sage.id }),
        msg({ role: 'system', content: 'polish the intro', bot_event: { kind: 'ask', from: sage.id, to: fern.id } }),
        msg({ bot_id: fern.id }),
      ],
    });
    expect(headers(html)).toEqual(['Sage', 'Fern']);
    expect(html).toContain('@Fern');
    expect(html).toContain('polish the intro');
  });

  it("rings a group intro's overlapped chips in the canvas the transcript sits on", () => {
    // The transcript has no surface of its own; the stack's default ring (surface-raised) is a
    // visible lighter halo on dark's darker canvas.
    const html = render({ kind: 'group', title: 'Launch prep', ownerBotId: null, members: all });
    const stack = html.slice(html.indexOf('data-testid="plant-avatar-stack"'));
    const chipRings = [...stack.matchAll(/class="(relative inline-flex rounded-full[^"]*)"/g)].map((m) =>
      m[1].split(/\s+/).filter((name) => name.startsWith('ring-') && name !== 'ring-2'),
    );
    expect(chipRings).toHaveLength(3);
    for (const ring of chipRings) expect(ring).toEqual(['ring-surface-canvas']);
  });

  it('streams each Bot as its own segment and marks a queued send as delivered', () => {
    const segments: BotStreamSegment[] = [
      { botId: sage.id, reason: 'user', status: 'completed', text: 'found it', reasoning: '', toolCalls: [] },
      { botId: fern.id, reason: 'ask', askedBy: sage.id, status: 'streaming', text: '', reasoning: '', toolCalls: [] },
    ];
    const html = render({
      kind: 'group',
      ownerBotId: null,
      members: all,
      messages: [msg({ role: 'user', content: 'go' })],
      segments,
      busy: true,
      pending: [{ clientId: 'p1', content: 'also check prices', images: [], status: 'queued', afterSegment: 2 }],
    });
    expect(headers(html)).toEqual(['Sage', 'Fern']);
    expect(html).toContain('found it');
    expect(html).toContain('Delivered — read after the current reply');
    expect(html.indexOf('found it')).toBeLessThan(html.indexOf('also check prices'));
  });

  it('renders an approval card with the vault-only "always" choice', () => {
    const request: BotRequestView = {
      id: 'brq_1',
      session_id: 's1',
      bot_id: ivy.id,
      kind: 'approval',
      status: 'pending',
      payload: {
        action: 'vault_fill',
        title: 'Fill github.com sign-in',
        details: [{ label: 'Site', value: 'https://github.com' }],
        allow_always: true,
      },
      result: null,
      expires_at: null,
      created_at: '2026-10-05T00:00:00.000Z',
    };
    const html = render({
      messages: [
        msg({
          role: 'system',
          bot_event: { kind: 'request', request_id: 'brq_1', request_kind: 'approval', bot_id: ivy.id },
        }),
      ],
      requests: new Map([[request.id, request]]),
    });
    expect(html).toContain('Ivy needs your approval');
    expect(html).toContain('Allow once');
    expect(html).toContain('Always for this site');
    expect(html).toContain('https://github.com');
  });

  it('shows greeting starters only while the greeting is the last word', () => {
    const chief = { ...ivy, template_key: 'chief' };
    const lookup = (key: string | null | undefined) => (key === chief.id ? chief : undefined);
    const greeting = msg({
      role: 'system',
      bot_id: ivy.id,
      content: 'Hi',
      bot_event: { kind: 'greeting', bot_id: ivy.id },
    });
    expect(render({ members: [chief], lookup, messages: [greeting] })).toContain('Plan my week from my open projects');
    expect(
      render({ members: [chief], lookup, messages: [greeting, msg({ role: 'user', content: 'hello' })] }),
    ).not.toContain('Plan my week from my open projects');
  });

  it('records a memory receipt with its scope', () => {
    const html = render({
      messages: [
        msg({
          bot_id: ivy.id,
          pipeline: [
            {
              step: 1,
              tool: 'memory',
              input: { action: 'remember' },
              output: { action: 'remember', remembered: { id: 7, title: 'Prefers tables' }, scope: 'bot' },
              duration_ms: 4,
            },
          ],
        }),
      ],
    });
    expect(html).toContain('Remembered — only Ivy');
    expect(html).toContain('Prefers tables');
    expect(html).toContain('>Undo<');
  });

  it("renders a background task report as the Bot's markdown, not a one-line event", () => {
    const html = render({
      kind: 'group',
      title: 'Launch prep',
      ownerBotId: null,
      members: all,
      messages: [
        msg({
          role: 'system',
          bot_id: sage.id,
          content: '## Findings\n\n- **gVisor** isolates containers',
          bot_event: {
            kind: 'task_report',
            run_id: 'run_1',
            bot_id: sage.id,
            title: 'Read three sites',
            status: 'succeeded',
          },
        }),
      ],
    });
    expect(html).toContain('data-testid="bots-task-report"');
    expect(html).toContain('Sage · background task report');
    expect(html).toContain('Read three sites');
    expect(html).toMatch(/<h2[^>]*>Findings<\/h2>/);
    expect(html).toContain('<strong>gVisor</strong>');
    expect(html).not.toContain('## Findings');
    expect(html).not.toContain('data-event-kind="task_report"');
  });
});
