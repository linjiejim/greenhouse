/**
 * Expo Push Service client — one plain `fetch`, no SDK (docs/specs/20261010-mobile-push.md
 * §3.1, D1).
 *
 * Messages are grouped by Expo project (one request may not mix projects:
 * `PUSH_TOO_MANY_EXPERIENCE_IDS`) and sent in chunks of ≤100. Every message gets
 * one outcome, in input order:
 * - `ok` — Expo accepted it (a ticket id; not proof the phone showed it);
 * - `error` — Expo refused that message (`code` is `details.error`, e.g.
 *   `DeviceNotRegistered` — the app is gone from the phone);
 * - `retry` — the whole request failed in a way that may pass later (network,
 *   HTTP 429, 5xx, `TOO_MANY_REQUESTS`);
 * - `fatal` — the whole request was refused and will be again (a malformed body,
 *   push security turned on — `UNAUTHORIZED`).
 * No access token is sent: enhanced push security stays off for the official
 * app (spec §3.1), or self-hosted deployments could not push at all.
 */

import { toErrorMessage } from '@greenhouse/utils/error';
import { EXPO_PUSH_SEND_URL } from './config.js';

export const EXPO_CHUNK_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;

/** The message fields this app sends (Expo's "message request format"). */
export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
  /** Unix seconds. */
  expiration?: number;
  priority?: 'default' | 'normal' | 'high';
  interruptionLevel?: 'active' | 'critical' | 'passive' | 'time-sensitive';
  threadId?: string;
  collapseId?: string;
}

export type ExpoOutcome =
  | { status: 'ok'; id: string | null }
  | { status: 'error'; code: string | null; message: string }
  | { status: 'retry'; error: string }
  | { status: 'fatal'; error: string };

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

interface ExpoTicketWire {
  status?: unknown;
  id?: unknown;
  message?: unknown;
  details?: { error?: unknown } | null;
}

function chunkOutcomes(count: number, outcome: ExpoOutcome): ExpoOutcome[] {
  return Array.from({ length: count }, () => outcome);
}

async function sendChunk(messages: ExpoMessage[], fetchImpl: FetchLike): Promise<ExpoOutcome[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let status: number;
  let body: unknown;
  try {
    const res = await fetchImpl(EXPO_PUSH_SEND_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(messages),
      signal: controller.signal,
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (error) {
    return chunkOutcomes(messages.length, { status: 'retry', error: `exp.host unreachable: ${toErrorMessage(error)}` });
  } finally {
    clearTimeout(timer);
  }

  const envelope = body && typeof body === 'object' ? (body as { data?: unknown; errors?: unknown }) : {};
  const errors = Array.isArray(envelope.errors)
    ? (envelope.errors as Array<{ code?: unknown; message?: unknown }>)
    : [];
  const describe = () =>
    errors.length
      ? errors.map((e) => `${String(e.code ?? 'error')}: ${String(e.message ?? '')}`.trim()).join('; ')
      : `HTTP ${status}`;
  if (status === 429 || status >= 500 || errors.some((e) => e.code === 'TOO_MANY_REQUESTS')) {
    return chunkOutcomes(messages.length, { status: 'retry', error: describe() });
  }
  if (status < 200 || status >= 300 || !Array.isArray(envelope.data)) {
    return chunkOutcomes(messages.length, { status: 'fatal', error: describe() });
  }
  const tickets = envelope.data as ExpoTicketWire[];
  return messages.map((_, index): ExpoOutcome => {
    const ticket = tickets[index];
    if (!ticket) return { status: 'retry', error: 'exp.host returned no ticket for this message' };
    if (ticket.status === 'ok') return { status: 'ok', id: typeof ticket.id === 'string' ? ticket.id : null };
    const code = typeof ticket.details?.error === 'string' ? ticket.details.error : null;
    return { status: 'error', code, message: typeof ticket.message === 'string' ? ticket.message : (code ?? 'error') };
  });
}

/** Send every message (grouped by project, ≤100 per request); one outcome per message, in input order. */
export async function sendExpoPush(
  items: ReadonlyArray<{ projectId: string; message: ExpoMessage }>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ExpoOutcome[]> {
  const outcomes: ExpoOutcome[] = new Array(items.length);
  const byProject = new Map<string, number[]>();
  items.forEach((item, index) => {
    const list = byProject.get(item.projectId) ?? [];
    list.push(index);
    byProject.set(item.projectId, list);
  });
  const requests: Array<Promise<void>> = [];
  for (const indexes of byProject.values()) {
    for (let start = 0; start < indexes.length; start += EXPO_CHUNK_SIZE) {
      const slice = indexes.slice(start, start + EXPO_CHUNK_SIZE);
      requests.push(
        sendChunk(
          slice.map((i) => items[i]!.message),
          fetchImpl,
        ).then((result) => {
          slice.forEach((itemIndex, position) => {
            outcomes[itemIndex] = result[position]!;
          });
        }),
      );
    }
  }
  await Promise.all(requests);
  return outcomes;
}
