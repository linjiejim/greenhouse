/**
 * @vitest-environment happy-dom
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamingEvent } from '@greenhouse/types/api';
import type { BotRequestView } from '@greenhouse/types/bots';
import { SessionManagerProvider, useSessionManager, type SessionManagerContextValue } from './session-manager';

const openBotsChat = vi.fn();

vi.mock('./api', () => ({
  openBotsChat: (...args: unknown[]) => openBotsChat(...args),
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
