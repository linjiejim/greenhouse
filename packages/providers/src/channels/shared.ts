/**
 * Plumbing for the IM channel adapters: an app access token cache, and one request helper that
 * reads the vendor's JSON verdict whatever the HTTP status (Feishu answers 400 with a code in the
 * body; WeCom answers 200 with `errcode`).
 */

import { createHash } from 'node:crypto';
import { ProviderRequestError, redact } from '../http.js';
import { EndpointViolation } from '../pinned-fetch.js';

/** App tokens live about two hours and their endpoints are rate limited: keep one per app. */
const tokens = new Map<string, { token: string; expiresAt: number }>();
/** Renew this early so a token never runs out in the middle of a send. */
const MARGIN_MS = 5 * 60_000;
const MAX_CACHED = 100;

/** The cache key of an app: its address, its id and its secret, hashed so the key holds no secret. */
export function appKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** A cached token, or a fresh one when there is none, it runs out soon, or `renew` is set. */
export async function appToken(
  key: string,
  fetchToken: () => Promise<{ token: string; expiresInSeconds: number }>,
  renew = false,
): Promise<string> {
  const now = Date.now();
  const hit = tokens.get(key);
  if (!renew && hit && hit.expiresAt - MARGIN_MS > now) return hit.token;
  const fresh = await fetchToken();
  if (tokens.size >= MAX_CACHED) {
    for (const [entry, value] of tokens) if (value.expiresAt <= now) tokens.delete(entry);
    if (tokens.size >= MAX_CACHED) tokens.clear();
  }
  tokens.set(key, { token: fresh.token, expiresAt: now + Math.max(fresh.expiresInSeconds, 60) * 1000 });
  return fresh.token;
}

export function forgetToken(key: string): void {
  tokens.delete(key);
}

/** One request; the parsed JSON body (or null) with the status. Network failures are retriable errors. */
export async function exchange(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  call: { label: string; secrets: readonly (string | undefined)[]; timeoutMs: number },
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(call.timeoutMs) });
  } catch (error) {
    if (error instanceof EndpointViolation) throw error;
    const { name, cause } = (error ?? {}) as { name?: unknown; cause?: { code?: unknown } };
    const reason =
      name === 'TimeoutError'
        ? `timed out after ${Math.round(call.timeoutMs / 1000)}s`
        : typeof cause?.code === 'string'
          ? `could not connect (${cause.code})`
          : 'could not connect';
    throw new ProviderRequestError(redact(`${call.label} ${reason}.`, call.secrets));
  }
  const text = await response.text().catch(() => '');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: a proxy page or a wrong address.
  }
  return { status: response.status, body };
}

/** A retriable failure that names the call, the vendor's code and words, and never a secret. */
export function failure(
  call: { label: string; secrets: readonly (string | undefined)[] },
  status: number,
  code: unknown,
  message: unknown,
): ProviderRequestError {
  const detail = [code !== undefined && code !== null ? String(code) : `HTTP ${status}`, message]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ');
  return new ProviderRequestError(
    redact(`${call.label} failed: ${detail}`.slice(0, 300), call.secrets),
    status >= 400 ? status : undefined,
  );
}
