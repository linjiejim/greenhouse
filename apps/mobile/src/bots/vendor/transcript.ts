// VENDORED from apps/web/src/components/bots/transcript.ts — verbatim below the imports (apps/mobile
// cannot import the web app; see apps/mobile/AGENTS.md). Only the import paths differ. Do not edit
// here: change the canonical file, re-copy it, and run src/bots/vendor/vendor.parity.test.ts.

/**
 * Transcript assembly for a Bots conversation — a pure function from
 * (persisted rows, the live run, sends in flight) to the rows on screen.
 *
 * Kept out of the components because the rules are subtle and worth pinning
 * with unit tests:
 * - Speaker headers appear only when the speaker changes, and never for the
 *   owner Bot of a DM (the conversation header already says who it is).
 * - A live segment disappears the moment its persisted message shows up
 *   (dedupe by message id), so a mid-run reload never doubles a reply.
 * - A message sent while Bots were working stays where it was sent, between
 *   the segments before and after it.
 * - A card sits under the reply of the turn that raised it — live and once
 *   persisted alike. The server writes the card's row mid-turn and the reply
 *   only when the turn ends, so in `seq` order the card comes first; drawn in
 *   that order it would jump above the text it was streaming under.
 */

import type { BotEvent, BotMessage, BotRequestView } from '../../shared/bots';
import type { BotStreamSegment, PipelineStep } from '../../shared/bots-wire';

/** A member message the client has sent but the transcript does not contain yet. */
export interface PendingSend {
  clientId: string;
  content: string;
  images: Array<{ id: string; url: string }>;
  /** `queued` = delivered while busy, read after the current reply. */
  status: 'sending' | 'queued' | 'sent';
  /** Live segments that existed when it was sent — it renders after them. */
  afterSegment: number;
  /** Queued, and the member pressed "Handle now": read once the current step finishes. */
  nudged?: boolean;
}

export interface Handoff {
  from: string;
  /** Target as written by the asking Bot: an id or a name. */
  to: string;
  text: string;
}

export type TranscriptItem =
  | { key: string; kind: 'user'; message: BotMessage }
  | { key: string; kind: 'bot'; message: BotMessage; botId: string | null; header: boolean }
  | { key: string; kind: 'handoff'; handoff: Handoff }
  | { key: string; kind: 'event'; message: BotMessage; event: BotEvent | null }
  | { key: string; kind: 'request'; requestId: string; botId: string | null; message: BotMessage | null }
  | { key: string; kind: 'segment'; segment: BotStreamSegment; header: boolean }
  | { key: string; kind: 'pending'; pending: PendingSend };

export interface TranscriptInput {
  messages: readonly BotMessage[];
  conversationKind: 'direct' | 'group';
  ownerBotId: string | null;
  segments?: readonly BotStreamSegment[];
  liveRequests?: readonly BotRequestView[];
  pending?: readonly PendingSend[];
  /** Latest known state of each card — tells a card's own row from a later line about it. */
  requests?: ReadonlyMap<string, BotRequestView>;
}

/**
 * A card's own row is written the moment the request is created; a row about
 * the same request written well after it ("Sign-in skipped", "declined") is a
 * later line, even when the card's row sits on an older page not loaded yet.
 * Generous on purpose (clock skew between the database and the API): a later
 * line that lands sooner sits right after its card, on the same page.
 */
const LATER_LINE_MS = 2 * 60_000;

function isLaterLine(message: BotMessage, request: BotRequestView | undefined): boolean {
  if (!request) return false;
  const gap = Date.parse(message.created_at) - Date.parse(request.created_at);
  return Number.isFinite(gap) && gap > LATER_LINE_MS;
}

function readInput(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object') return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

/** `team.ask` calls in a turn's tool trace, as hand-off strips. */
export function handoffsFromCalls(
  from: string,
  calls: ReadonlyArray<{ name: string; input: unknown; output?: unknown }>,
): Handoff[] {
  return calls.flatMap((call) => {
    if (call.name !== 'team') return [];
    const input = readInput(call.input);
    if (!input || input.action !== 'ask') return [];
    // A refused hand-off (loop guard, budget, Bot-to-Bot off) is not a hand-off.
    const output = readInput(call.output);
    if (output && (output.status === 'refused' || typeof output.error === 'string' || output.accepted === false)) {
      return [];
    }
    // The tool resolves the target and reports its name; before the result
    // lands, the asker's own `bot_id` (an id or an exact name) is all there is.
    const to = firstString(output?.to, input.bot_id, input.bot, input.to);
    const text = firstString(input.message);
    return to ? [{ from, to, text }] : [];
  });
}

/**
 * The engine writes an ask row's text as "Sage → @Fern: brief" for readers
 * without the structure (other Bots, exports). The strip draws the names
 * itself, so only the brief is kept.
 */
export function stripHandoffPrefix(text: string): string {
  return text.replace(/^\s*[^\n→]{1,40}→\s*@[^\n:：]{1,40}[:：]\s*/, '');
}

function pipelineCalls(pipeline: readonly PipelineStep[]) {
  return pipeline.map((step) => ({ name: step.tool, input: step.input, output: step.output }));
}

/** One key per request card, live or persisted (see the request branch below). */
function requestKey(requestId: string): string {
  return `request:${requestId}`;
}

/**
 * The tool call that raised this card: its result names the request (team
 * `create`, bot_tasks `start`, `self`, takeover and sign-in cards all do).
 * An approval's result is the gated tool's own — the turn waited on the card,
 * so its reply is simply the Bot's next one (see `buildTranscript`).
 */
function raisedBy(calls: ReadonlyArray<{ output?: unknown }>, requestId: string): boolean {
  return calls.some((call) => {
    const output = readInput(call.output);
    return !!output && (output.request_id === requestId || output.bots_request_id === requestId);
  });
}

export function buildTranscript({
  messages,
  conversationKind,
  ownerBotId,
  segments = [],
  liveRequests = [],
  pending = [],
  requests,
}: TranscriptInput): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  let lastSpeaker: string | null = null;

  const wantsHeader = (botId: string | null) => {
    const changed = botId !== lastSpeaker;
    lastSpeaker = botId;
    if (!changed) return false;
    // DMs: the owner speaks under the conversation header; guests get a name.
    return conversationKind === 'group' || botId !== ownerBotId;
  };

  // A hand-off the engine also recorded as an event row is drawn once, from
  // the row. Rows and the asker's message can land in either order, so the
  // match is "same asker, same chain" (a chain = everything after one member
  // message, up to the next).
  const askEventsByChain = new Map<number, Set<string>>();
  const chainOf = new Map<string, number>();
  const persistedIds = new Set<string>();
  const persistedRequests = new Set<string>();
  let chain = 0;
  for (const message of ordered) {
    if (message.role === 'user' && !message.bot_event) chain += 1;
    chainOf.set(message.id, chain);
    persistedIds.add(message.id);
    if (message.bot_event?.kind === 'ask') {
      const askers = askEventsByChain.get(chain) ?? new Set<string>();
      askers.add(message.bot_event.from);
      askEventsByChain.set(chain, askers);
    }
    if (message.bot_event?.kind === 'request') persistedRequests.add(message.bot_event.request_id);
  }
  const askRecorded = (message: BotMessage, from: string) =>
    askEventsByChain.get(chainOf.get(message.id) ?? -1)?.has(from) ?? false;

  // ── Where a card goes: under the reply of the turn that raised it ──
  type CardItem = Extract<TranscriptItem, { kind: 'request' }>;
  const isLive = (index: number) => {
    const segment = segments[index];
    return segment.status !== 'skipped' && !(segment.messageId && persistedIds.has(segment.messageId));
  };
  /** The live segment a card hangs under: the one whose tool call raised it, else the Bot's latest (-1: none). */
  const segmentFor = (requestId: string, botId: string | null): number => {
    let latest = -1;
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index].botId !== botId || !isLive(index)) continue;
      if (raisedBy(segments[index].toolCalls, requestId)) return index;
      latest = index;
    }
    return latest;
  };
  /**
   * The persisted reply of the turn that raised the card written at `at`: the
   * reply whose tool call names it, else the Bot's next reply in the same chain
   * (an approval holds its turn until it is decided, so that reply is its own).
   * Null while the turn is still running.
   */
  const replyFor = (at: number, requestId: string, botId: string | null): string | null => {
    if (!botId) return null;
    const cardChain = chainOf.get(ordered[at].id);
    let next: string | null = null;
    for (let index = at + 1; index < ordered.length; index += 1) {
      const message = ordered[index];
      if (message.role !== 'assistant' || message.bot_event || message.bot_id !== botId) continue;
      if (raisedBy(pipelineCalls(message.pipeline), requestId)) return message.id;
      if (next === null && chainOf.get(message.id) === cardChain) next = message.id;
    }
    return next;
  };
  const runRequests = new Set(liveRequests.map((request) => request.id));
  /** Persisted cards held back for their reply (by message id) or their live segment (by index). */
  const underReply = new Map<string, CardItem[]>();
  const underSegment = new Map<number, CardItem[]>();
  const hold = <K>(held: Map<K, CardItem[]>, at: K, card: CardItem) => held.set(at, [...(held.get(at) ?? []), card]);

  const renderedRequests = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const message = ordered[index];
    const event = message.bot_event;
    if (event?.kind === 'greeting') {
      items.push({ key: message.id, kind: 'bot', message, botId: event.bot_id, header: wantsHeader(event.bot_id) });
      continue;
    }
    if (event?.kind === 'ask') {
      items.push({
        key: message.id,
        kind: 'handoff',
        handoff: { from: event.from, to: event.to, text: stripHandoffPrefix(message.content) },
      });
      continue;
    }
    if (event?.kind === 'request') {
      if (renderedRequests.has(event.request_id) || isLaterLine(message, requests?.get(event.request_id))) {
        // A later line about the same card (e.g. "declined") is a plain event:
        // one card per request, and never two items with one key.
        items.push({ key: message.id, kind: 'event', message, event });
        continue;
      }
      renderedRequests.add(event.request_id);
      // Keyed by request id — the same key the live copy used — so React keeps
      // the card's instance (an edited name, a half-typed sign-in) when the
      // persisted row replaces it mid-run.
      const card: CardItem = {
        key: requestKey(event.request_id),
        kind: 'request',
        requestId: event.request_id,
        botId: event.bot_id,
        message,
      };
      const reply = replyFor(index, event.request_id, event.bot_id);
      const live = reply || !runRequests.has(event.request_id) ? -1 : segmentFor(event.request_id, event.bot_id);
      if (reply) hold(underReply, reply, card);
      else if (live >= 0) hold(underSegment, live, card);
      else items.push(card); // its turn left no reply (or it is not this run's): where it was written
      continue;
    }
    if (event || message.role === 'system') {
      items.push({ key: message.id, kind: 'event', message, event: event ?? null });
      continue;
    }
    if (message.role === 'user') {
      lastSpeaker = 'user';
      items.push({ key: message.id, kind: 'user', message });
      continue;
    }
    const botId = message.bot_id;
    items.push({ key: message.id, kind: 'bot', message, botId, header: wantsHeader(botId) });
    if (botId && !askRecorded(message, botId)) {
      handoffsFromCalls(botId, pipelineCalls(message.pipeline)).forEach((handoff, handoffIndex) =>
        items.push({ key: `${message.id}:handoff:${handoffIndex}`, kind: 'handoff', handoff }),
      );
    }
    items.push(...(underReply.get(message.id) ?? []));
  }

  // ── The live run: segments not persisted yet, with sends and cards in place ──
  const placedRequests = new Set<string>();
  for (let index = 0; index <= segments.length; index += 1) {
    // Sends made after `index` segments existed sit right here — persisted
    // segments already render above, so this is still "after what they saw".
    const atEnd = index === segments.length;
    for (const send of pending) {
      if (atEnd ? send.afterSegment < index : send.afterSegment !== index) continue;
      lastSpeaker = 'user';
      items.push({ key: `pending:${send.clientId}`, kind: 'pending', pending: send });
    }
    if (atEnd) break;
    const segment = segments[index];
    if (segment.status === 'skipped') continue;
    if (segment.messageId && persistedIds.has(segment.messageId)) continue;
    items.push({ key: `segment:${index}`, kind: 'segment', segment, header: wantsHeader(segment.botId) });
    handoffsFromCalls(segment.botId, segment.toolCalls).forEach((handoff, handoffIndex) =>
      items.push({ key: `segment:${index}:handoff:${handoffIndex}`, kind: 'handoff', handoff }),
    );
    // A card belongs under the turn that raised it (its persisted row too, until that turn's reply lands).
    items.push(...(underSegment.get(index) ?? []));
    for (const request of liveRequests) {
      if (persistedRequests.has(request.id) || placedRequests.has(request.id)) continue;
      if (segmentFor(request.id, request.bot_id) !== index) continue;
      placedRequests.add(request.id);
      items.push({
        key: requestKey(request.id),
        kind: 'request',
        requestId: request.id,
        botId: request.bot_id,
        message: null,
      });
    }
  }

  for (const request of liveRequests) {
    if (persistedRequests.has(request.id) || placedRequests.has(request.id)) continue;
    items.push({
      key: requestKey(request.id),
      kind: 'request',
      requestId: request.id,
      botId: request.bot_id,
      message: null,
    });
  }
  return items;
}

/**
 * Queued messages a run picks up. Between turns the engine reads one waiting
 * member message at a time and answers it with `interjection` turns, so each
 * new interjection turn picks up the oldest message still queued that was sent
 * before it started. Those read as sent — "read after the current reply" and
 * "Handle now" no longer apply. Feed every interjection turn once (the caller
 * keeps count): a turn must not be matched again after its message settled.
 */
export function pickUpQueued<T extends PendingSend>(pending: readonly T[], interjectionTurns: readonly number[]): T[] {
  const next = [...pending];
  for (const turn of interjectionTurns) {
    const index = next.findIndex((send) => send.status === 'queued' && send.afterSegment <= turn);
    if (index >= 0) next[index] = { ...next[index], status: 'sent' };
  }
  return next;
}

/** The Bot speaking right now, if any (header roster animation, status line). */
export function speakingSegment(segments: readonly BotStreamSegment[] | undefined): BotStreamSegment | null {
  if (!segments) return null;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].status === 'streaming') return segments[index];
  }
  return null;
}
