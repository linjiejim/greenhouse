/**
 * Replies being written, outside the thread store: deltas arrive many times a second and only
 * the reply being written should re-render. React-free (./streams.test.ts); `useStream` in
 * ./use-stream.ts subscribes a row to one reply.
 *
 * A delta carries its `offset` — the reply's length before it — so a client that fetched the
 * partial reply mid-stream (or reconnected) joins the saved text and the live piece where they
 * meet (`liveText`), never doubling or dropping words. `message.updated` (the reply settled)
 * replaces the stream; `message.deleted` forgets it and drops anything still on its way.
 */

import type { RealtimeEvent } from '../shared/contract';

export type LiveStep = Extract<RealtimeEvent, { type: 'message.step' }>['data']['step'];

/** A contiguous piece of the reply: `text` starts at character `start`. */
export interface Stream {
  start: number;
  text: string;
  steps: LiveStep[];
}

const streams = new Map<string, Stream>();
const listeners = new Map<string, Set<() => void>>();
/** Replies removed by an edit or a regenerate: deltas that still arrive for them are dropped. */
const removed = new Set<string>();
const REMOVED_MAX = 500;

function emit(messageId: string) {
  listeners.get(messageId)?.forEach((listener) => listener());
}

/** Text appended to a reply at `offset`. Overlaps are trimmed; a gap restarts the piece there. */
export function appendDelta(messageId: string, text: string, offset: number): void {
  if (removed.has(messageId)) return;
  const current = streams.get(messageId);
  if (!current || (current.text === '' && current.start === 0 && offset > 0)) {
    streams.set(messageId, { start: offset, text, steps: current?.steps ?? [] });
  } else {
    const end = current.start + current.text.length;
    if (offset > end) streams.set(messageId, { ...current, start: offset, text });
    else if (offset + text.length > end) streams.set(messageId, { ...current, text: current.text + text.slice(end - offset) });
    else return;
  }
  emit(messageId);
}

/**
 * What to show for a reply being written: the saved partial text (`base`, from the last fetch)
 * joined with the live piece where they meet.
 */
export function liveText(base: string, stream: Stream | undefined): string {
  if (!stream) return base;
  if (stream.start > base.length) return base + stream.text;
  const joined = base.slice(0, stream.start) + stream.text;
  return joined.length >= base.length ? joined : base;
}

/** A tool step started or settled in a reply being written. */
export function upsertStep(messageId: string, step: LiveStep): void {
  if (removed.has(messageId)) return;
  const current = streams.get(messageId) ?? { start: 0, text: '', steps: [] };
  const steps = current.steps.some((item) => item.id === step.id)
    ? current.steps.map((item) => (item.id === step.id ? step : item))
    : [...current.steps, step];
  streams.set(messageId, { ...current, steps });
  emit(messageId);
}

/** The reply settled (its saved copy has everything): drop the live piece. */
export function endStream(messageId: string): void {
  if (streams.delete(messageId)) emit(messageId);
}

/** The reply left the transcript: drop its stream and ignore anything still on its way. */
export function forgetStream(messageId: string): void {
  removed.add(messageId);
  if (removed.size > REMOVED_MAX) removed.delete(removed.values().next().value!);
  endStream(messageId);
}

/** Sign-out, another station or account: nothing live survives. */
export function clearStreams(): void {
  const ids = [...streams.keys()];
  streams.clear();
  removed.clear();
  ids.forEach(emit);
}

export const readStream = (messageId: string): Stream | undefined => streams.get(messageId);

/** Calls `listener` whenever this reply's stream changes; returns the unsubscribe. */
export function subscribeStream(messageId: string, listener: () => void): () => void {
  const set = listeners.get(messageId) ?? new Set();
  set.add(listener);
  listeners.set(messageId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(messageId);
  };
}
