/**
 * Chat streaming — POST /api/chat, consume the NDJSON stream.
 *
 * Uses `expo/fetch` (SDK 52+) instead of React Native's built-in fetch because
 * only expo/fetch exposes a streaming `response.body` reader on native. On web
 * it maps to the browser fetch (which also streams). This is the same path the
 * Vercel AI SDK uses for Expo.
 *
 * Yields the canonical `StreamingEvent` union from @greenhouse/types so callers can
 * drive it through `handleStreamEvent`.
 */

import { fetch as expoFetch } from 'expo/fetch';
import type { StreamingEvent } from '../shared/greenhouse-types';
import { t } from '../lib/i18n';
import { getApiBase } from '../store/stations';
import { getAccessToken } from './token-storage';
import { refreshTokens } from './client';

interface StreamChatArgs {
  sessionId: string;
  message: string;
  /** Uploaded images to attach to the user message (see /api/upload). */
  images?: Array<{ id: string; url: string }>;
  modelOverride?: string;
  signal?: AbortSignal;
}

async function openStream(args: StreamChatArgs, token: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const body: Record<string, unknown> = {
    session_id: args.sessionId,
    messages: [
      {
        role: 'user',
        content: args.message,
        ...(args.images?.length ? { images: args.images } : {}),
      },
    ],
  };
  if (args.modelOverride) body.model_override = args.modelOverride;

  return expoFetch(`${getApiBase()}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: args.signal,
  });
}

export async function* streamChat(args: StreamChatArgs): AsyncGenerator<StreamingEvent> {
  let res = await openStream(args, getAccessToken());

  // One refresh+retry on 401 before the stream body is consumed.
  if (res.status === 401) {
    const ok = await refreshTokens();
    if (ok) res = await openStream(args, getAccessToken());
  }

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`${t('chat.requestFailed')} (${res.status})${detail ? `: ${detail}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const evt = parseLine(line);
        if (evt) yield evt;
      }
    }
    // Flush any trailing line.
    const tail = buffer.trim();
    if (tail) {
      const evt = parseLine(tail);
      if (evt) yield evt;
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* ignore */
    }
  }
}

function parseLine(line: string): StreamingEvent | null {
  try {
    return JSON.parse(line) as StreamingEvent;
  } catch {
    return null;
  }
}
