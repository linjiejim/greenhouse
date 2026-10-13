/**
 * Replies being written, outside the query cache: deltas arrive many times a second and only
 * the message being written should re-render. The final message replaces the stream.
 */

import { useSyncExternalStore } from 'react';
import type { RealtimeEvent } from '@greenhouse/contract';

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

function emit(messageId: string) {
  listeners.get(messageId)?.forEach((listener) => listener());
}

export function appendDelta(messageId: string, text: string, offset: number) {
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
 * What to show for a reply being written: the saved partial text (`base`, from the last
 * fetch) joined with the live piece where they meet.
 */
export function liveText(base: string, stream: Stream | undefined): string {
  if (!stream) return base;
  if (stream.start > base.length) return base + stream.text;
  const joined = base.slice(0, stream.start) + stream.text;
  return joined.length >= base.length ? joined : base;
}

export function upsertStep(messageId: string, step: LiveStep) {
  if (removed.has(messageId)) return;
  const current = streams.get(messageId) ?? { start: 0, text: '', steps: [] };
  const steps = current.steps.some((item) => item.id === step.id)
    ? current.steps.map((item) => (item.id === step.id ? step : item))
    : [...current.steps, step];
  streams.set(messageId, { ...current, steps });
  emit(messageId);
}

export function endStream(messageId: string) {
  if (streams.delete(messageId)) emit(messageId);
}

/** The reply left the transcript: drop its stream and ignore anything still on its way. */
export function forgetStream(messageId: string) {
  removed.add(messageId);
  if (removed.size > 500) removed.delete(removed.values().next().value!);
  endStream(messageId);
}

export function clearStreams() {
  const ids = [...streams.keys()];
  streams.clear();
  ids.forEach(emit);
}

export const readStream = (messageId: string): Stream | undefined => streams.get(messageId);

export function useStream(messageId: string): Stream | undefined {
  return useSyncExternalStore(
    (listener) => {
      const set = listeners.get(messageId) ?? new Set();
      set.add(listener);
      listeners.set(messageId, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(messageId);
      };
    },
    () => streams.get(messageId),
  );
}
