/**
 * @vitest-environment happy-dom
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamingEvent } from '@greenhouse/types/api';
import type { BotRequestView } from '@greenhouse/types/bots';
import { BotsApiError } from './api/bots';
import {
  SessionManagerProvider,
  useSessionManager,
  type InterruptOutcome,
  type SessionManagerContextValue,
} from './session-manager';

const openBotsChat = vi.fn();
const interruptChatRun = vi.fn();

vi.mock('./api', () => ({
  openBotsChat: (...args: unknown[]) => openBotsChat(...args),
  interruptChatRun: (...args: unknown[]) => interruptChatRun(...args),
  listChatRuns: vi.fn().mockResolvedValue({ runs: [] }),
  getChatRun: vi.fn().mockResolvedValue({ active: false }),
  streamChatRun: vi.fn(),
  streamChat: vi.fn(),
  stopChatRun: vi.fn().mockResolvedValue(true),
  updateSession: vi.fn().mockResolvedValue(undefined),
  postClientActionResult: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./ws', () => ({
  wsClient: { onEvent: () => () => {}, onStatusChange: () => () => {} },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function* stream(events: StreamingEvent[]): AsyncGenerator<StreamingEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

const request = {
  id: 'brq_1',
  session_id: 's1',
  bot_id: 'bot_b',
  kind: 'approval',
  status: 'pending',
  payload: { action: 'vault_fill', title: 'Sign in', details: [], allow_always: true },
  result: null,
  expires_at: null,
  created_at: '2026-10-05T00:00:00.000Z',
} satisfies BotRequestView;

let manager: SessionManagerContextValue | null = null;
let container: HTMLDivElement;

function Probe() {
  manager = useSessionManager();
  return null;
}

async function settle() {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('SessionManager — Bots runs', () => {
  beforeEach(async () => {
    manager = null;
    openBotsChat.mockReset();
    interruptChatRun.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(createElement(SessionManagerProvider, null, createElement(Probe)));
    });
    // Let the provider's run-list seed resolve inside act.
    await settle();
  });

  afterEach(() => {
    container.remove();
  });

  it('splits one run into per-Bot segments between bot-turn-start and bot-turn-end', async () => {
    openBotsChat.mockResolvedValue({
      queued: false,
      events: stream([
        { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' },
        { type: 'text-delta', text: 'Asking Fern. ' },
        { type: 'tool-call-start', id: 'c1', toolName: 'team' },
        { type: 'tool-call', id: 'c1', toolName: 'team', input: { action: 'ask', bot_id: 'bot_b', message: 'polish' } },
        { type: 'tool-result', id: 'c1', toolName: 'team', output: { accepted: true } },
        { type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1' },
        { type: 'bot-turn-start', bot_id: 'bot_b', reason: 'ask', asked_by: 'bot_a' },
        { type: 'text-delta', text: 'Polished.' },
        { type: 'bot-request', request },
        { type: 'bot-turn-end', bot_id: 'bot_b', status: 'completed', message_id: 'm2' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    });

    let result: { queued: boolean } | undefined;
    await act(async () => {
      result = await manager!.sendBotsMessage('s1', 'hi', { mentions: ['bot_a'] });
    });
    await settle();

    expect(result).toEqual({ queued: false });
    expect(openBotsChat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', message: 'hi', mentions: ['bot_a'] }),
    );
    const session = manager!.activeSessions.get('s1');
    expect(session?.status).toBe('completed');
    // Nothing leaks into the single-agent fields.
    expect(session?.streamText).toBe('');
    expect(session?.streamToolCalls).toEqual([]);
    expect(
      session?.botSegments.map((segment) => [segment.botId, segment.text, segment.status, segment.messageId]),
    ).toEqual([
      ['bot_a', 'Asking Fern. ', 'completed', 'm1'],
      ['bot_b', 'Polished.', 'completed', 'm2'],
    ]);
    expect(session?.botSegments[0].toolCalls).toEqual([
      expect.objectContaining({ id: 'c1', name: 'team', status: 'done', output: { accepted: true } }),
    ]);
    expect(session?.botSegments[1].askedBy).toBe('bot_a');
    expect(session?.botRequests.map((card) => card.id)).toEqual(['brq_1']);
  });

  it('closes a segment the run ended without a bot-turn-end for', async () => {
    openBotsChat.mockResolvedValue({
      queued: false,
      events: stream([
        { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' },
        { type: 'text-delta', text: 'partial' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    });
    await act(async () => {
      await manager!.sendBotsMessage('s1', 'hi');
    });
    await settle();
    expect(manager!.activeSessions.get('s1')?.botSegments[0].status).toBe('completed');
  });

  it('reports a queued delivery without opening a stream', async () => {
    openBotsChat.mockResolvedValue({ queued: true });
    let result: { queued: boolean } | undefined;
    await act(async () => {
      result = await manager!.sendBotsMessage('s1', 'also this');
    });
    expect(result).toEqual({ queued: true });
    expect(manager!.activeSessions.has('s1')).toBe(false);
  });

  it('rejects when the API refuses the message', async () => {
    openBotsChat.mockRejectedValue(new Error('Bots are not enabled for this account'));
    await act(async () => {
      await expect(manager!.sendBotsMessage('s1', 'hi')).rejects.toThrow('not enabled');
    });
    expect(manager!.activeSessions.has('s1')).toBe(false);
  });
});

/** A stream the test feeds event by event, to look at the run between events. */
function controlledStream() {
  const queue: StreamingEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  async function* events(): AsyncGenerator<StreamingEvent> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    events: events(),
    push(event: unknown) {
      // `run-interrupting` is new on the wire; the stream type may not list it yet.
      queue.push(event as StreamingEvent);
      wake?.();
      wake = null;
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
  };
}

describe('SessionManager — Bots soft stop', () => {
  beforeEach(async () => {
    manager = null;
    openBotsChat.mockReset();
    interruptChatRun.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(createElement(SessionManagerProvider, null, createElement(Probe)));
    });
    await settle();
  });

  afterEach(() => {
    container.remove();
  });

  async function startRun() {
    const stream = controlledStream();
    openBotsChat.mockResolvedValue({ queued: false, events: stream.events });
    await act(async () => {
      await manager!.sendBotsMessage('s1', 'hi');
    });
    return stream;
  }

  it('follows run-interrupting (from any tab) and clears it when the next turn starts', async () => {
    const stream = await startRun();
    stream.push({ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' });
    await settle();
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(false);

    stream.push({ type: 'run-interrupting' });
    await settle();
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(true);

    // The interrupted turn ends: still stopping — the run may simply end now.
    stream.push({ type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1' });
    await settle();
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(true);

    // A later turn starts (the member's waiting message): the soft stop was used up.
    stream.push({ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' });
    await settle();
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(false);

    // Asked between turns: the next turn to start is the waiting message's.
    stream.push({ type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm2' });
    stream.push({ type: 'run-interrupting' });
    await settle();
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(true);
    stream.push({ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'interjection' });
    await settle();
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(false);

    stream.push({ type: 'finish', finishReason: 'stop' });
    stream.end();
    await settle();
    expect(manager!.activeSessions.get('s1')?.status).toBe('completed');
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(false);
  });

  it('ends a soft-stopped run with nothing waiting as completed — no error', async () => {
    const stream = await startRun();
    stream.push({ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' });
    stream.push({ type: 'run-interrupting' });
    await settle();
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(true);
    stream.push({ type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1' });
    stream.push({ type: 'finish', finishReason: 'stop' });
    stream.end();
    await settle();
    const session = manager!.activeSessions.get('s1');
    expect(session?.status).toBe('completed');
    expect(session?.error).toBeUndefined();
    expect(session?.interrupting).toBe(false);
  });

  it('asks the server for a soft stop and shows it at once', async () => {
    const stream = await startRun();
    stream.push({ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' });
    await settle();

    interruptChatRun.mockResolvedValue({ run_id: 'run-1' });
    let outcome: InterruptOutcome | undefined;
    await act(async () => {
      outcome = await manager!.interruptSession('s1');
    });
    await settle();
    expect(outcome).toBe('interrupting');
    expect(interruptChatRun).toHaveBeenCalledWith('s1');
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(true);

    stream.push({ type: 'finish', finishReason: 'stop' });
    stream.end();
    await settle();
  });

  it('does not mark a soft stop the run already moved past', async () => {
    const stream = await startRun();
    stream.push({ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' });
    await settle();

    // The answer comes back after the next turn already started.
    let answer: (value: { run_id: string }) => void = () => {};
    interruptChatRun.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    let outcome: Promise<InterruptOutcome> | undefined;
    act(() => {
      outcome = manager!.interruptSession('s1');
    });
    stream.push({ type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1' });
    stream.push({ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'interjection' });
    await settle();
    await act(async () => {
      answer({ run_id: 'run-1' });
      await outcome;
    });
    await settle();
    expect(manager!.activeSessions.get('s1')?.interrupting).toBe(false);

    stream.push({ type: 'finish', finishReason: 'stop' });
    stream.end();
    await settle();
  });

  it('tells a run that already finished (404) from a refusal', async () => {
    const outcomes: InterruptOutcome[] = [];
    interruptChatRun.mockRejectedValueOnce(new BotsApiError('No active run', 404));
    interruptChatRun.mockRejectedValueOnce(
      new BotsApiError('Only Bots conversations can be interrupted', 400, 'not_supported'),
    );
    interruptChatRun.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => {
      outcomes.push(await manager!.interruptSession('s1'));
      outcomes.push(await manager!.interruptSession('s1'));
      outcomes.push(await manager!.interruptSession('s1'));
    });
    expect(outcomes).toEqual(['no_run', 'refused', 'refused']);
  });
});
