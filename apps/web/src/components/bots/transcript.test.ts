import { describe, expect, it } from 'vitest';
import type { BotRequestView } from '@greenhouse/types/bots';
import type { BotMessage } from '../../lib/api/bots';
import type { BotStreamSegment } from '../../lib/session-manager';
import {
  buildTranscript,
  handoffsFromCalls,
  pickUpQueued,
  speakingSegment,
  type PendingSend,
  type TranscriptItem,
} from './transcript';

let seq = 0;
function msg(partial: Partial<BotMessage>): BotMessage {
  seq += 1;
  return {
    id: partial.id ?? `m${seq}`,
    role: 'assistant',
    content: 'text',
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

function segment(partial: Partial<BotStreamSegment>): BotStreamSegment {
  return { botId: 'bot_a', reason: 'user', status: 'streaming', text: '', reasoning: '', toolCalls: [], ...partial };
}

const summary = (items: TranscriptItem[]) =>
  items.map((item) => {
    if (item.kind === 'bot') return `bot:${item.botId}${item.header ? '+h' : ''}`;
    if (item.kind === 'segment') return `seg:${item.segment.botId}${item.header ? '+h' : ''}`;
    if (item.kind === 'pending') return `pending:${item.pending.clientId}`;
    if (item.kind === 'handoff') return `handoff:${item.handoff.from}->${item.handoff.to}`;
    if (item.kind === 'request') return `request:${item.requestId}`;
    return item.kind;
  });

describe('buildTranscript', () => {
  it('never puts a header on the DM owner, but names a guest when the speaker changes', () => {
    const items = buildTranscript({
      conversationKind: 'direct',
      ownerBotId: 'bot_owner',
      messages: [
        msg({ role: 'user', content: 'hi' }),
        msg({ bot_id: 'bot_owner' }),
        msg({ bot_id: 'bot_owner' }),
        msg({ bot_id: 'bot_guest' }),
        msg({ bot_id: 'bot_guest' }),
        msg({ bot_id: 'bot_owner' }),
      ],
    });
    expect(summary(items)).toEqual([
      'user',
      'bot:bot_owner',
      'bot:bot_owner',
      'bot:bot_guest+h',
      'bot:bot_guest',
      'bot:bot_owner',
    ]);
  });

  it('shows a group speaker header only on speaker change, including after the member speaks', () => {
    const items = buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [
        msg({ bot_id: 'bot_a' }),
        msg({ bot_id: 'bot_a' }),
        msg({ role: 'user' }),
        msg({ bot_id: 'bot_a' }),
        msg({ bot_id: 'bot_b' }),
      ],
    });
    expect(summary(items)).toEqual(['bot:bot_a+h', 'bot:bot_a', 'user', 'bot:bot_a+h', 'bot:bot_b+h']);
  });

  it('renders the greeting as the Bot speaking and system rows as events', () => {
    const items = buildTranscript({
      conversationKind: 'direct',
      ownerBotId: 'bot_owner',
      messages: [
        msg({ role: 'system', bot_event: { kind: 'greeting', bot_id: 'bot_owner' } }),
        msg({ role: 'system', bot_event: { kind: 'joined', bot_id: 'bot_x', by: 'user' } }),
      ],
    });
    expect(summary(items)).toEqual(['bot:bot_owner', 'event']);
  });

  it('draws a hand-off from the trace unless the engine recorded it as an event row', () => {
    const ask = {
      step: 1,
      tool: 'team',
      input: { action: 'ask', bot_id: 'bot_b', message: 'polish this' },
      output: { action: 'ask', status: 'handed_over', to: 'bot_b' },
      duration_ms: 3,
    };
    const fromTrace = buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [msg({ bot_id: 'bot_a', pipeline: [ask] })],
    });
    expect(summary(fromTrace)).toEqual(['bot:bot_a+h', 'handoff:bot_a->bot_b']);

    const withEvent = buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [
        msg({ bot_id: 'bot_a', pipeline: [ask] }),
        msg({ role: 'system', content: 'polish this', bot_event: { kind: 'ask', from: 'bot_a', to: 'bot_b' } }),
      ],
    });
    expect(summary(withEvent)).toEqual(['bot:bot_a+h', 'handoff:bot_a->bot_b']);
  });

  it('drops refused hand-offs', () => {
    expect(
      handoffsFromCalls('bot_a', [
        {
          name: 'team',
          input: JSON.stringify({ action: 'ask', bot: 'bot_b', message: 'x' }),
          output: { error: 'loop' },
        },
      ]),
    ).toEqual([]);
  });

  it('hides a live segment once its persisted message is in the transcript', () => {
    const question = msg({ role: 'user' });
    const persisted = msg({ id: 'persisted-1', bot_id: 'bot_a' });
    const items = buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [persisted, question],
      segments: [
        segment({ botId: 'bot_a', status: 'completed', messageId: 'persisted-1' }),
        segment({ botId: 'bot_b' }),
      ],
    });
    expect(summary(items)).toEqual(['user', 'bot:bot_a+h', 'seg:bot_b+h']);
  });

  it('drops a skipped wrap-up turn entirely', () => {
    const items = buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [],
      segments: [
        segment({ botId: 'bot_a', status: 'completed', text: 'done' }),
        segment({ botId: 'bot_b', status: 'skipped' }),
      ],
    });
    expect(summary(items)).toEqual(['seg:bot_a+h']);
  });

  it('keeps a message sent mid-run between the segments before and after it', () => {
    const items = buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [msg({ role: 'user' })],
      segments: [segment({ botId: 'bot_a', status: 'completed' }), segment({ botId: 'bot_b' })],
      pending: [
        { clientId: 'early', content: 'a', images: [], status: 'sent', afterSegment: 0 },
        { clientId: 'mid', content: 'b', images: [], status: 'queued', afterSegment: 1 },
        { clientId: 'late', content: 'c', images: [], status: 'queued', afterSegment: 2 },
      ],
    });
    expect(summary(items)).toEqual([
      'user',
      'pending:early',
      'seg:bot_a+h',
      'pending:mid',
      'seg:bot_b+h',
      'pending:late',
    ]);
  });

  it('places a live card under the latest turn of the Bot that raised it, once', () => {
    const request = { id: 'brq_1', bot_id: 'bot_a' } as BotRequestView;
    const items = buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [],
      segments: [segment({ botId: 'bot_a', status: 'completed' }), segment({ botId: 'bot_b', status: 'completed' })],
      liveRequests: [request],
    });
    expect(summary(items)).toEqual(['seg:bot_a+h', 'request:brq_1', 'seg:bot_b+h']);

    const persisted = buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [
        msg({
          role: 'system',
          bot_event: { kind: 'request', request_id: 'brq_1', request_kind: 'approval', bot_id: 'bot_a' },
        }),
      ],
      liveRequests: [request],
    });
    expect(summary(persisted)).toEqual(['request:brq_1']);
    // Same key live and persisted: React keeps the card (and what the member typed into it).
    const liveKey = items.find((item) => item.kind === 'request')?.key;
    expect(liveKey).toBeDefined();
    expect(persisted.find((item) => item.kind === 'request')?.key).toBe(liveKey);
  });

  describe('a card sits under the reply of the turn that raised it', () => {
    const cardRow = (requestId: string, botId = 'bot_a', kind: 'approval' | 'bot_create' = 'bot_create') =>
      msg({
        id: `row-${requestId}`,
        role: 'system',
        bot_event: { kind: 'request', request_id: requestId, request_kind: kind, bot_id: botId },
      });
    const raised = (requestId: string) => [
      {
        step: 1,
        tool: 'team',
        input: { action: 'create' },
        output: { status: 'proposed', request_id: requestId },
        duration_ms: 1,
      },
    ];
    const dm = { conversationKind: 'direct' as const, ownerBotId: 'bot_a' };

    it('persisted: the card row is written mid-turn, the reply at its end — the card still follows the reply', () => {
      const items = buildTranscript({
        ...dm,
        messages: [msg({ role: 'user' }), cardRow('brq_1'), msg({ id: 'reply', bot_id: 'bot_a' })],
      });
      expect(summary(items)).toEqual(['user', 'bot:bot_a', 'request:brq_1']);
    });

    it('an approval (its result does not name the card) follows the Bot’s next reply in the same chain', () => {
      const items = buildTranscript({
        ...dm,
        messages: [msg({ role: 'user' }), cardRow('brq_2', 'bot_a', 'approval'), msg({ bot_id: 'bot_a' })],
      });
      expect(summary(items)).toEqual(['user', 'bot:bot_a', 'request:brq_2']);
    });

    it('follows the reply whose tool call raised it, even past a message the member sent meanwhile', () => {
      const items = buildTranscript({
        ...dm,
        messages: [
          msg({ role: 'user', content: 'build me a researcher' }),
          cardRow('brq_3'),
          msg({ role: 'user', content: 'and make it fast' }),
          msg({ bot_id: 'bot_a', pipeline: raised('brq_3') }),
        ],
      });
      expect(summary(items)).toEqual(['user', 'user', 'bot:bot_a', 'request:brq_3']);
    });

    it('keeps the card under its live turn across a mid-run reload, and under the reply once it lands — one key', () => {
      const request = { id: 'brq_4', bot_id: 'bot_a' } as BotRequestView;
      const live = buildTranscript({
        ...dm,
        messages: [msg({ role: 'user' })],
        segments: [segment({ botId: 'bot_a', text: 'Here is my proposal', toolCalls: [] })],
        liveRequests: [request],
      });
      const reloaded = buildTranscript({
        ...dm,
        messages: [msg({ role: 'user' }), cardRow('brq_4')],
        segments: [segment({ botId: 'bot_a', text: 'Here is my proposal — and more' })],
        liveRequests: [request],
      });
      const settled = buildTranscript({
        ...dm,
        messages: [msg({ role: 'user' }), cardRow('brq_4'), msg({ id: 'reply-4', bot_id: 'bot_a' })],
        segments: [segment({ botId: 'bot_a', status: 'completed', messageId: 'reply-4' })],
        liveRequests: [request],
      });
      expect(summary(live)).toEqual(['user', 'seg:bot_a', 'request:brq_4']);
      expect(summary(reloaded)).toEqual(['user', 'seg:bot_a', 'request:brq_4']);
      expect(summary(settled)).toEqual(['user', 'bot:bot_a', 'request:brq_4']);
      const key = (items: TranscriptItem[]) => items.find((item) => item.kind === 'request')?.key;
      expect(key(reloaded)).toBe(key(live));
      expect(key(settled)).toBe(key(live));
    });

    it('a live card goes under the segment whose tool call raised it, not a later turn of the same Bot', () => {
      const request = { id: 'brq_5', bot_id: 'bot_a' } as BotRequestView;
      const items = buildTranscript({
        conversationKind: 'group',
        ownerBotId: null,
        messages: [],
        segments: [
          segment({
            botId: 'bot_a',
            status: 'completed',
            toolCalls: [{ id: 't1', name: 'bot_tasks', input: {}, output: { request_id: 'brq_5' }, status: 'done' }],
          } as Partial<BotStreamSegment>),
          segment({ botId: 'bot_b', status: 'completed' }),
          segment({ botId: 'bot_a' }),
        ],
        liveRequests: [request],
      });
      expect(summary(items)).toEqual(['seg:bot_a+h', 'request:brq_5', 'seg:bot_b+h', 'seg:bot_a+h']);
    });

    it('two cards from one turn keep their order under its reply', () => {
      const items = buildTranscript({
        ...dm,
        messages: [msg({ role: 'user' }), cardRow('brq_6'), cardRow('brq_7'), msg({ bot_id: 'bot_a' })],
      });
      expect(summary(items)).toEqual(['user', 'bot:bot_a', 'request:brq_6', 'request:brq_7']);
    });

    it('a card whose turn left no reply stays where it was written — an earlier run’s card never joins a new live turn', () => {
      const items = buildTranscript({
        ...dm,
        messages: [msg({ role: 'user' }), cardRow('brq_8'), msg({ role: 'user' })],
        segments: [segment({ botId: 'bot_a', text: 'new turn' })],
        liveRequests: [],
      });
      expect(summary(items)).toEqual(['user', 'request:brq_8', 'user', 'seg:bot_a']);
    });

    it('never moves a card under another Bot’s reply', () => {
      const items = buildTranscript({
        conversationKind: 'direct',
        ownerBotId: 'bot_a',
        messages: [msg({ role: 'user' }), cardRow('brq_9', 'bot_b'), msg({ bot_id: 'bot_a' })],
      });
      expect(summary(items)).toEqual(['user', 'request:brq_9', 'bot:bot_a']);
    });
  });

  it('draws one card per request; a later row for the same request is a plain event line', () => {
    const items = buildTranscript({
      conversationKind: 'direct',
      ownerBotId: 'bot_a',
      messages: [
        msg({
          id: 'row-raised',
          role: 'system',
          content: 'Sage asked to sign in',
          bot_event: { kind: 'request', request_id: 'brq_9', request_kind: 'login', bot_id: 'bot_a' },
        }),
        msg({
          id: 'row-declined',
          role: 'system',
          content: 'You declined',
          bot_event: { kind: 'request', request_id: 'brq_9', request_kind: 'login', bot_id: 'bot_a' },
        }),
      ],
    });
    expect(summary(items)).toEqual(['request:brq_9', 'event']);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it('tells a later line from the card by time when the card row is on an older page', () => {
    const request = { id: 'brq_7', bot_id: 'bot_a', created_at: '2026-10-05T08:00:00.000Z' } as BotRequestView;
    const row = (created_at: string) =>
      msg({
        role: 'system',
        content: 'Sign-in to github.com skipped',
        created_at,
        bot_event: { kind: 'request', request_id: 'brq_7', request_kind: 'login', bot_id: 'bot_a' },
      });
    const base = {
      conversationKind: 'direct' as const,
      ownerBotId: 'bot_a',
      requests: new Map([[request.id, request]]),
    };
    // Written with the request: the card itself.
    expect(summary(buildTranscript({ ...base, messages: [row('2026-10-05T08:00:00.200Z')] }))).toEqual([
      'request:brq_7',
    ]);
    // Written an hour later, its card out of the loaded window: a system line, not a second card.
    expect(summary(buildTranscript({ ...base, messages: [row('2026-10-05T09:00:00.000Z')] }))).toEqual(['event']);
  });

  it('reports the Bot that is speaking right now', () => {
    expect(
      speakingSegment([segment({ botId: 'bot_a', status: 'completed' }), segment({ botId: 'bot_b' })])?.botId,
    ).toBe('bot_b');
    expect(speakingSegment([segment({ status: 'completed' })])).toBeNull();
  });
});

describe('pickUpQueued', () => {
  const send = (clientId: string, status: PendingSend['status'], afterSegment: number): PendingSend => ({
    clientId,
    content: clientId,
    images: [],
    status,
    afterSegment,
  });

  it('gives each new interjection turn to the oldest message still waiting that was sent before it', () => {
    const pending = [send('a', 'queued', 1), send('b', 'queued', 1), send('c', 'sending', 0)];
    expect(pickUpQueued(pending, [2]).map((item) => item.status)).toEqual(['sent', 'queued', 'sending']);
    expect(pickUpQueued(pending, [2, 4]).map((item) => item.status)).toEqual(['sent', 'sent', 'sending']);
  });

  it('never gives a message a turn that started before it was sent', () => {
    expect(pickUpQueued([send('late', 'queued', 3)], [2]).map((item) => item.status)).toEqual(['queued']);
    expect(pickUpQueued([send('late', 'queued', 3)], [3]).map((item) => item.status)).toEqual(['sent']);
  });

  it('leaves the list alone with no new turns', () => {
    const pending = [send('a', 'queued', 1)];
    expect(pickUpQueued(pending, [])).toEqual(pending);
  });
});
