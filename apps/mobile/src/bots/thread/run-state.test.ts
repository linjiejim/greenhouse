/**
 * The run reducer (./run-state.ts). The reducer cases of the web's
 * apps/web/src/lib/session-manager-bots.interaction.test.tsx, rewritten for the
 * pure function — the other web cases there are transport / stop behaviour and
 * live in ./engine.test.ts:
 * - "reports a queued delivery without opening a stream" → engine "202: …"
 * - "rejects when the API refuses the message" → engine "a refusal with any other code → rejected"
 * - "asks the server for a soft stop and shows it at once" and "does not mark a
 *   soft stop the run already moved past" → engine "first tap = soft; …"
 * - "tells a run that already finished (404) from a refusal" → engine "no_run → let go quietly; refused → stop now"
 * Plus what mobile adds: the `bot-turn-end` fallback, `skipped`, card upsert,
 * structural sharing, the replay cursor, `error` / `finish`.
 */

import { describe, expect, it } from 'vitest';
import type { RunStreamEvent } from '../../api/chat';
import type { BotRequestView } from '../../shared/bots';
import { applyRunEvent, emptyRunState, settleRun, type RunState } from './run-state';

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

function run(events: unknown[], from: RunState = emptyRunState()): RunState {
  return events.reduce<RunState>((state, event) => applyRunEvent(state, event as RunStreamEvent), from);
}

describe('applyRunEvent (web SessionManager cases)', () => {
  it('splits one run into per-Bot segments between bot-turn-start and bot-turn-end', () => {
    const s = run([
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
    ]);
    expect(s.segments.map((segment) => [segment.botId, segment.text, segment.status, segment.messageId])).toEqual([
      ['bot_a', 'Asking Fern. ', 'completed', 'm1'],
      ['bot_b', 'Polished.', 'completed', 'm2'],
    ]);
    expect(s.segments[0].toolCalls).toEqual([
      {
        id: 'c1',
        name: 'team',
        input: JSON.stringify({ action: 'ask', bot_id: 'bot_b', message: 'polish' }),
        output: { accepted: true },
        status: 'done',
      },
    ]);
    expect(s.segments[1].askedBy).toBe('bot_a');
    expect(s.requests.map((card) => card.id)).toEqual(['brq_1']);
    expect(s.finished).toBe(true);
    expect(s.current).toBe(-1);
    expect(s.turnStarts).toBe(2);
  });

  it('closes a segment the run ended without a bot-turn-end for', () => {
    const s = run([
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' },
      { type: 'text-delta', text: 'partial' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(s.segments[0].status).toBe('streaming');
    const settled = settleRun(s, 'completed');
    expect(settled.segments[0].status).toBe('completed');
    expect(settled.current).toBe(-1);
    expect(settleRun(s, 'stopped').segments[0].status).toBe('stopped');
  });

  it('follows run-interrupting (from any device) and clears it when the next turn starts', () => {
    let s = run([{ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' }]);
    expect(s.interrupting).toBe(false);
    s = run([{ type: 'run-interrupting' }], s);
    expect(s.interrupting).toBe(true);
    // The interrupted turn ends: still stopping — the run may simply end now.
    s = run([{ type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1' }], s);
    expect(s.interrupting).toBe(true);
    // A later turn starts (the member's waiting message): the soft stop was used up.
    s = run([{ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' }], s);
    expect(s.interrupting).toBe(false);
    // Asked between turns: the next turn to start is the waiting message's.
    s = run(
      [{ type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm2' }, { type: 'run-interrupting' }],
      s,
    );
    expect(s.interrupting).toBe(true);
    s = run([{ type: 'bot-turn-start', bot_id: 'bot_a', reason: 'interjection' }], s);
    expect(s.interrupting).toBe(false);
    expect(s.interjections).toEqual([2]);
  });

  it('a soft-stopped run with nothing waiting ends as completed — no error', () => {
    const s = run([
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' },
      { type: 'run-interrupting' },
      { type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(s.finished).toBe(true);
    expect(s.serverError).toBeNull();
    expect(settleRun(s, 'completed').segments[0].status).toBe('completed');
  });
});

describe('applyRunEvent (mobile)', () => {
  it('a bot-turn-end with no open segment, or another Bot’s, lands on that Bot’s latest segment (resume replay)', () => {
    let s = run([
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' },
      { type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1' },
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'followup' },
      { type: 'bot-turn-start', bot_id: 'bot_b', reason: 'ask', asked_by: 'bot_a' },
    ]);
    // Open segment is bot_b's; an end for bot_a falls back to bot_a's latest (index 1).
    s = run([{ type: 'bot-turn-end', bot_id: 'bot_a', status: 'stopped', message_id: 'm2' }], s);
    expect(s.segments.map((segment) => segment.status)).toEqual(['completed', 'stopped', 'streaming']);
    expect(s.current).toBe(-1);
    // No open segment at all: still lands.
    s = run([{ type: 'bot-turn-end', bot_id: 'bot_b', status: 'completed', message_id: 'm3' }], s);
    expect(s.segments[2]).toMatchObject({ status: 'completed', messageId: 'm3' });
    // An end for a Bot with no segment is ignored.
    expect(run([{ type: 'bot-turn-end', bot_id: 'ghost', status: 'completed' }], s)).toBe(s);
  });

  it('records a skipped wrap-up turn and an errored one as the server sent them', () => {
    const s = run([
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'continue' },
      { type: 'bot-turn-end', bot_id: 'bot_a', status: 'skipped' },
      { type: 'bot-turn-start', bot_id: 'bot_b', reason: 'mention' },
      { type: 'bot-turn-end', bot_id: 'bot_b', status: 'error', error: 'Model unavailable' },
    ]);
    expect(s.segments.map((segment) => [segment.status, segment.messageId, segment.error])).toEqual([
      ['skipped', undefined, undefined],
      ['error', undefined, 'Model unavailable'],
    ]);
  });

  it('upserts cards by id (a later copy replaces the earlier one in place)', () => {
    const second: BotRequestView = { ...request, id: 'brq_2' };
    let s = run([
      { type: 'bot-request', request },
      { type: 'bot-request', request: second },
    ]);
    s = run([{ type: 'bot-request', request: { ...request, status: 'resolved' } }], s);
    expect(s.requests.map((card) => [card.id, card.status])).toEqual([
      ['brq_1', 'resolved'],
      ['brq_2', 'pending'],
    ]);
  });

  it('only the segment an event touches becomes a new object', () => {
    const s = run([
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' },
      { type: 'text-delta', text: 'one' },
      { type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1' },
      { type: 'bot-turn-start', bot_id: 'bot_b', reason: 'ask' },
    ]);
    const next = run([{ type: 'text-delta', text: 'two' }], s);
    expect(next.segments[0]).toBe(s.segments[0]);
    expect(next.segments[1]).not.toBe(s.segments[1]);
    expect(next.segments[1].text).toBe('two');
    const tools = run([{ type: 'tool-call-start', id: 't1', toolName: 'browser' }], next);
    expect(tools.segments[0]).toBe(s.segments[0]);
    expect(tools.segments[1].text).toBe('two');
    // Closing keeps the already-closed segments too.
    const settled = settleRun(tools, 'stopped');
    expect(settled.segments[0]).toBe(s.segments[0]);
    expect(settled.segments[1].status).toBe('stopped');
  });

  it('drops text and tool events outside a Bot turn; ignores pings and client actions', () => {
    const s = emptyRunState();
    expect(run([{ type: 'text-delta', text: 'stray' }], s)).toBe(s);
    expect(run([{ type: 'tool-call-start', id: 't', toolName: 'x' }], s)).toBe(s);
    expect(run([{ type: 'ping' }], s)).toBe(s);
    expect(run([{ type: 'local-tool-request', toolCallId: 'c', toolId: 'nav', params: {}, replayed: true }], s)).toBe(
      s,
    );
  });

  it('builds a tool call from its deltas, then its full input and result', () => {
    const s = run([
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user' },
      { type: 'tool-call-start', id: 't1', toolName: 'browser' },
      { type: 'tool-call-delta', id: 't1', delta: '{"url":"https://' },
      { type: 'tool-call-delta', id: 't1', delta: 'github.com"' },
    ]);
    expect(s.segments[0].toolCalls[0]).toEqual({
      id: 't1',
      name: 'browser',
      input: '{"url":"https://github.com"',
      status: 'calling',
    });
    const done = run(
      [
        { type: 'tool-call', id: 't1', toolName: 'browser', input: { url: 'https://github.com' } },
        { type: 'tool-result', id: 't1', toolName: 'browser', output: 'ok' },
      ],
      s,
    );
    expect(done.segments[0].toolCalls[0]).toEqual({
      id: 't1',
      name: 'browser',
      input: '{"url":"https://github.com"}',
      output: 'ok',
      status: 'done',
    });
  });

  it('tracks the replay cursor, the server’s declared error and finish', () => {
    let s = run([
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user', seq: 0 },
      { type: 'text-delta', text: 'x', seq: 1 },
      { type: 'ping' },
    ]);
    expect(s.lastSeq).toBe(1);
    // An older seq (a replay overlapping) never moves the cursor back.
    s = run([{ type: 'text-delta', text: 'y', seq: 0 }], s);
    expect(s.lastSeq).toBe(1);
    s = run([{ type: 'error', error: 'overloaded', seq: 2 }], s);
    expect(s.serverError).toBe('overloaded');
    expect(s.lastSeq).toBe(2);
    expect(s.finished).toBe(false);
    s = run([{ type: 'finish', seq: 3 }], s);
    expect(s.finished).toBe(true);
  });
});
