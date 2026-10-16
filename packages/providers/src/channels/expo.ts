/**
 * The Expo push service: the phone apps register Expo push tokens, and Expo holds the APNs and
 * FCM credentials. Messages go out grouped by Expo project (one request may not mix them), at most
 * 100 per request, and every message gets one ticket back in order. An access token is sent only
 * when one is set (Expo's enhanced push security). Receipts say later what became of each ticket.
 */

import { z } from 'zod';
import { ProviderRequestError, redact } from '../http.js';
import { EndpointViolation } from '../pinned-fetch.js';
import type { ProviderAdapter, PushClient, PushMessage, PushReceipt, PushTicket } from '../types.js';

const configSchema = z.object({ baseUrl: z.string().url().default('https://exp.host') });
export type ExpoConfig = z.infer<typeof configSchema>;

export const EXPO_CHUNK_SIZE = 100;
const RECEIPT_CHUNK_SIZE = 1000;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const TIMEOUT_MS = 15_000;

interface TicketWire {
  status?: unknown;
  id?: unknown;
  message?: unknown;
  details?: { error?: unknown } | null;
}

/** Expo's message format: `projectId` stays here, `contentAvailable` is `_contentAvailable` on the wire. */
function wire(message: PushMessage): Record<string, unknown> {
  const { projectId: _project, contentAvailable, ...rest } = message;
  return { ...rest, ...(contentAvailable ? { _contentAvailable: true } : {}) };
}

const refusal = (value: TicketWire | undefined): { code: string | null; message: string } => {
  const code = typeof value?.details?.error === 'string' ? value.details.error : null;
  return { code, message: typeof value?.message === 'string' ? value.message : (code ?? 'error') };
};

export const expoAdapter: ProviderAdapter<'push', ExpoConfig> = {
  capability: 'push',
  kind: 'expo',
  label: 'Expo',
  configSchema: configSchema as z.ZodType<ExpoConfig>,
  secretKeys: ['accessToken'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const base = `${config.baseUrl.replace(/\/+$/, '')}/--/api/v2/push`;
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(secrets.accessToken ? { authorization: `Bearer ${secrets.accessToken}` } : {}),
    };
    const clean = (text: string) => redact(text, [secrets.accessToken]);

    async function post(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
      const response = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }

    async function sendChunk(messages: readonly PushMessage[]): Promise<PushTicket[]> {
      const all = (ticket: PushTicket) => messages.map(() => ticket);
      let answer: { status: number; body: unknown };
      try {
        answer = await post('send', messages.map(wire));
      } catch (error) {
        if (error instanceof EndpointViolation) return all({ status: 'fatal', error: error.message });
        return all({ status: 'retry', error: clean(`Expo unreachable: ${messageOf(error)}`) });
      }
      const envelope = (answer.body ?? {}) as { data?: unknown; errors?: unknown };
      const errors = Array.isArray(envelope.errors) ? (envelope.errors as { code?: unknown; message?: unknown }[]) : [];
      const describe = () =>
        clean(
          errors.length
            ? errors
                .map((entry) => [entry.code ?? 'error', entry.message].filter(Boolean).map(String).join(': '))
                .join('; ')
            : `HTTP ${answer.status}`,
        );
      if (answer.status === 429 || answer.status >= 500 || errors.some((entry) => entry.code === 'TOO_MANY_REQUESTS')) {
        return all({ status: 'retry', error: describe() });
      }
      if (answer.status < 200 || answer.status >= 300 || !Array.isArray(envelope.data)) {
        return all({ status: 'fatal', error: describe() });
      }
      const tickets = envelope.data as TicketWire[];
      return messages.map((_, index): PushTicket => {
        const ticket = tickets[index];
        if (!ticket) return { status: 'retry', error: 'Expo returned no ticket for this message' };
        if (ticket.status === 'ok') return { status: 'ok', id: typeof ticket.id === 'string' ? ticket.id : null };
        return { status: 'error', ...refusal(ticket) };
      });
    }

    const client: PushClient = {
      async send(messages) {
        const tickets: PushTicket[] = new Array(messages.length);
        const byProject = new Map<string, number[]>();
        messages.forEach((message, index) => {
          byProject.set(message.projectId, [...(byProject.get(message.projectId) ?? []), index]);
        });
        const requests: Promise<void>[] = [];
        for (const indexes of byProject.values()) {
          for (let start = 0; start < indexes.length; start += EXPO_CHUNK_SIZE) {
            const slice = indexes.slice(start, start + EXPO_CHUNK_SIZE);
            requests.push(
              sendChunk(slice.map((index) => messages[index]!)).then((result) =>
                slice.forEach((index, position) => (tickets[index] = result[position]!)),
              ),
            );
          }
        }
        await Promise.all(requests);
        return tickets;
      },

      async receipts(ticketIds) {
        const out: Record<string, PushReceipt> = {};
        for (let start = 0; start < ticketIds.length; start += RECEIPT_CHUNK_SIZE) {
          let answer: { status: number; body: unknown };
          try {
            answer = await post('getReceipts', { ids: ticketIds.slice(start, start + RECEIPT_CHUNK_SIZE) });
          } catch (error) {
            if (error instanceof EndpointViolation) throw error;
            throw new ProviderRequestError(clean(`Expo receipts unreachable: ${messageOf(error)}`));
          }
          const data = (answer.body as { data?: unknown } | null)?.data;
          if (answer.status < 200 || answer.status >= 300 || !data || typeof data !== 'object') {
            throw new ProviderRequestError(clean(`Expo receipts failed: HTTP ${answer.status}`), answer.status);
          }
          for (const [id, receipt] of Object.entries(data as Record<string, TicketWire>)) {
            out[id] = receipt?.status === 'ok' ? { status: 'ok' } : { status: 'error', ...refusal(receipt) };
          }
        }
        return out;
      },
    };
    return client;
  },
  // A receipt lookup for a ticket that does not exist: reachable, and the access token (if any) is accepted.
  test: async (client) => {
    await client.receipts(['00000000-0000-0000-0000-000000000000']);
  },
};
