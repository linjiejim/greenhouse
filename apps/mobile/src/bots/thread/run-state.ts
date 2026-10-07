/**
 * One Bots run's live state, folded from its NDJSON events — a pure,
 * structurally shared reducer the thread engine (./engine.ts) feeds event by
 * event. Only the segment an event touches becomes a new object; every other
 * segment keeps its reference, so the memoised transcript rows on screen only
 * re-render for the Bot that is actually talking.
 *
 * A hand port of the web's inline reducer (apps/web/src/lib/session-manager.tsx
 * `runStream`: the `run-interrupting` branch :345-351, `speaking` /
 * `updateCalls` :355-359, and the `handleStreamEvent` callbacks :361-436). The
 * canonical text is pinned by a tripwire in ../vendor/vendor.parity.test.ts:
 * when the web changes, that test turns red here — re-check this file against
 * it, then update the hash. Differences, on purpose:
 * - Text and tool events outside a Bot turn are dropped (the web writes them to
 *   the single-agent fields; a Bots run never has any).
 * - It also records what the engine needs around the reducer: `turnStarts`
 *   (has a soft stop been overtaken?), the interjection turns (queued messages
 *   picked up), the replay cursor `lastSeq`, `finish`, and the server's
 *   declared `error` (read on to EOF, never retried — :465-470).
 */

import type { BotRequestView } from '../../shared/bots';
import { settleOpenSegments, type BotStreamSegment, type StreamingToolCall } from '../../shared/bots-wire';
import type { RunStreamEvent } from '../../api/chat';

export interface RunState {
  segments: BotStreamSegment[];
  /** Index of the open segment (between its `bot-turn-start` and `bot-turn-end`), -1 = none. */
  current: number;
  /** Cards raised during the run, latest copy per id, in arrival order. */
  requests: BotRequestView[];
  /** A soft stop was taken (`run-interrupting`); the next turn to start clears it. */
  interrupting: boolean;
  /** `bot-turn-start`s seen — a soft stop asked for before a newer one was used up by it. */
  turnStarts: number;
  /** Segment indexes of `interjection` turns (each answers one queued member message). */
  interjections: number[];
  /** Highest `seq` seen: where a re-attach to the same run resumes (`?after=`). */
  lastSeq: number;
  /** The run's one `finish` arrived. */
  finished: boolean;
  /** The server declared the run failed (`error` event); its safe partial is persisted. */
  serverError: string | null;
}

export function emptyRunState(): RunState {
  return {
    segments: [],
    current: -1,
    requests: [],
    interrupting: false,
    turnStarts: 0,
    interjections: [],
    lastSeq: -1,
    finished: false,
    serverError: null,
  };
}

/** Replace segment `index` (only it becomes a new object). */
function withSegment(s: RunState, index: number, segment: BotStreamSegment): BotStreamSegment[] {
  const segments = [...s.segments];
  segments[index] = segment;
  return segments;
}

/** Fold one event into the run. Returns `s` itself when nothing changed. */
export function applyRunEvent(s: RunState, e: RunStreamEvent): RunState {
  const seq = typeof e.seq === 'number' && e.seq > s.lastSeq ? e.seq : s.lastSeq;
  const next = reduce(s, e);
  if (seq === next.lastSeq) return next;
  return { ...next, lastSeq: seq };
}

function reduce(s: RunState, e: RunStreamEvent): RunState {
  // The Bot speaking right now: text and tool events belong to it.
  const speaking = s.current >= 0 ? s.segments[s.current] : null;
  const updateCalls = (fn: (calls: StreamingToolCall[]) => StreamingToolCall[]): RunState =>
    speaking ? { ...s, segments: withSegment(s, s.current, { ...speaking, toolCalls: fn(speaking.toolCalls) }) } : s;

  switch (e.type) {
    case 'run-interrupting':
      // A soft stop, asked for here or on another device (replayed after a re-attach).
      return s.interrupting ? s : { ...s, interrupting: true };
    case 'text-delta':
      if (!speaking || !e.text) return s;
      return { ...s, segments: withSegment(s, s.current, { ...speaking, text: speaking.text + e.text }) };
    case 'reasoning-delta':
      if (!speaking || !e.text) return s;
      return { ...s, segments: withSegment(s, s.current, { ...speaking, reasoning: speaking.reasoning + e.text }) };
    case 'tool-call-start':
      return updateCalls((calls) => [...calls, { id: e.id, name: e.toolName, input: '', status: 'calling' }]);
    case 'tool-call-delta':
      return updateCalls((calls) => calls.map((tc) => (tc.id === e.id ? { ...tc, input: tc.input + e.delta } : tc)));
    case 'tool-call':
      return updateCalls((calls) =>
        calls.map((tc) => (tc.id === e.id ? { ...tc, input: JSON.stringify(e.input) } : tc)),
      );
    case 'tool-result':
      return updateCalls((calls) =>
        calls.map((tc) => (tc.id === e.id ? { ...tc, output: e.output, status: 'done' } : tc)),
      );
    case 'bot-turn-start': {
      const index = s.segments.length;
      return {
        ...s,
        segments: [
          ...s.segments,
          {
            botId: e.bot_id,
            reason: e.reason,
            askedBy: e.asked_by,
            status: 'streaming',
            text: '',
            reasoning: '',
            toolCalls: [],
          },
        ],
        current: index,
        turnStarts: s.turnStarts + 1,
        // A turn after a soft stop answers a message that was waiting: the server used the request up.
        interrupting: false,
        interjections: e.reason === 'interjection' ? [...s.interjections, index] : s.interjections,
      };
    }
    case 'bot-turn-end': {
      // The open segment normally; fall back to the Bot's latest one so a
      // replayed end after a resume still lands.
      let index = s.current;
      if (index < 0 || s.segments[index]?.botId !== e.bot_id) {
        index = s.segments.map((segment) => segment.botId).lastIndexOf(e.bot_id);
      }
      const segment = index >= 0 ? s.segments[index] : undefined;
      if (!segment) return s.current === -1 ? s : { ...s, current: -1 };
      return {
        ...s,
        segments: withSegment(s, index, { ...segment, status: e.status, messageId: e.message_id, error: e.error }),
        current: -1,
      };
    }
    case 'bot-request': {
      const known = s.requests.findIndex((existing) => existing.id === e.request.id);
      if (known < 0) return { ...s, requests: [...s.requests, e.request] };
      const requests = [...s.requests];
      requests[known] = e.request;
      return { ...s, requests };
    }
    case 'error':
      // Keep reading to EOF: the API persists the partial before it closes the stream.
      return { ...s, serverError: e.error || s.serverError || 'error' };
    case 'finish':
      return s.finished ? s : { ...s, finished: true };
    default:
      // `ping`, `local-tool-request` (a browser client action — never run here), titles…
      return s;
  }
}

/**
 * Close the segments the run ended without a `bot-turn-end` for (stop,
 * transport loss, server error) — the vendored `settleOpenSegments`, keeping
 * the references of segments that were already closed.
 */
export function settleRun(s: RunState, status: BotStreamSegment['status']): RunState {
  if (!s.segments.some((segment) => segment.status === 'streaming'))
    return s.current === -1 ? s : { ...s, current: -1 };
  const settled = settleOpenSegments(s.segments, status);
  return {
    ...s,
    segments: settled.map((segment, index) => (s.segments[index].status === 'streaming' ? segment : s.segments[index])),
    current: -1,
  };
}
