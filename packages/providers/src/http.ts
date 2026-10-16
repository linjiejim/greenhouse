/**
 * HTTP plumbing for the adapters that speak plain JSON or binary over fetch (search, speech and
 * image). Vendors report failures in a dozen shapes; callers get one short error that names
 * the call, says what to check, keeps the HTTP status for fallback decisions (isRetriable reads
 * statusCode) and never repeats a secret, even when the vendor echoes it back.
 */

import { EndpointViolation } from './pinned-fetch.js';

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    /** A network error code such as ECONNREFUSED. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export interface CallContext {
  /** Names the call in messages, e.g. "Tavily search". */
  label: string;
  /** Values that must never appear in an error message. */
  secrets?: readonly (string | undefined)[];
  /** Advice for a status that beats the generic hint. */
  hints?: Readonly<Record<number, string>>;
  timeoutMs: number;
}

const HINTS: Readonly<Record<number, string>> = {
  401: 'Check the API key.',
  402: 'The account is out of credit.',
  403: 'Check the API key and the account plan or balance.',
  404: 'Check the base URL and the model.',
  408: 'Try again.',
  413: 'The input is too large for this provider.',
  429: 'Rate limited or out of quota; try again later.',
};

const MESSAGE_KEYS = ['message', 'error', 'detail', 'err_msg', 'msg', 'status_msg', 'warning'];

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  return secrets.reduce<string>(
    (out, secret) => (secret && secret.length >= 4 ? out.split(secret).join('***') : out),
    text,
  );
}

function messageIn(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (depth > 3 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return messageIn(value[0], depth + 1);
  for (const key of MESSAGE_KEYS) {
    const found = messageIn((value as Record<string, unknown>)[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** The vendor's own words from whichever field it uses, or the start of a plain-text body. */
export function detailOf(body: string): string | undefined {
  const trimmed = body.trim();
  // An HTML error page from a proxy or a wrong base URL says nothing useful.
  if (!trimmed || trimmed.startsWith('<')) return undefined;
  let detail: string | undefined = trimmed;
  try {
    detail = messageIn(JSON.parse(trimmed));
  } catch {
    // Plain text: keep it.
  }
  return detail?.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * `reason` is "HTTP 401" for a status, or the vendor's own code for an error inside a 200 body.
 * `statusCode` is what fallback logic sees; leave it out when another instance would not help.
 */
export function providerError(
  call: Pick<CallContext, 'label' | 'secrets' | 'hints'>,
  { reason, detail, statusCode }: { reason?: string; detail?: string | null; statusCode?: number },
): ProviderRequestError {
  const head = `${call.label} failed${reason ? ` (${reason})` : ''}${detail ? `: ${detail}` : ''}`;
  const hint =
    statusCode === undefined
      ? undefined
      : (call.hints?.[statusCode] ??
        HINTS[statusCode] ??
        (statusCode >= 500 ? 'The provider is unavailable; try again later.' : undefined));
  const message = `${head.replace(/[\s.]+$/, '')}.${hint ? ` ${hint}` : ''}`;
  return new ProviderRequestError(redact(message, call.secrets), statusCode);
}

/** Why fetch itself threw, in a form that is safe to show and that fallback logic can read. */
function fetchFailure(error: unknown, url: string, call: CallContext): Error {
  if (error instanceof EndpointViolation) return error;
  const { name, message, cause } = (error ?? {}) as { name?: unknown; message?: unknown; cause?: unknown };
  if (name === 'TimeoutError') {
    return new ProviderRequestError(
      `${call.label} timed out after ${Math.round(call.timeoutMs / 1000)}s. Try again.`,
      408,
    );
  }
  const { code, message: causeMessage } = (cause ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === 'string') {
    const text = `${call.label} could not reach ${hostOf(url)} (${code}). Check the base URL and the network.`;
    return new ProviderRequestError(text, undefined, code);
  }
  // Anything else, such as an invalid header, may quote what was sent: key included.
  const detail = [message, causeMessage].filter((part) => typeof part === 'string' && part).join(': ');
  return providerError(call, { detail: detail || String(error) });
}

/** Sends one request through the instance's pinned fetch; only a 2xx response comes back. */
export async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, call: CallContext) {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(call.timeoutMs) });
  } catch (error) {
    throw fetchFailure(error, url, call);
  }
  if (!response.ok) {
    const detail = detailOf(await response.text().catch(() => ''));
    throw providerError(call, { reason: `HTTP ${response.status}`, detail, statusCode: response.status });
  }
  return response;
}

export async function readJson<T>(response: Response, call: Pick<CallContext, 'label'>): Promise<T> {
  const body = await response.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ProviderRequestError(`${call.label} returned a response that is not JSON. Check the base URL.`);
  }
}

export async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  call: CallContext,
) {
  const response = await send(
    fetchImpl,
    url,
    { method: 'GET', headers: { Accept: 'application/json', ...headers } },
    call,
  );
  return readJson<T>(response, call);
}

export async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  call: CallContext,
) {
  const response = await send(
    fetchImpl,
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(payload),
    },
    call,
  );
  return readJson<T>(response, call);
}

/** Keyless local servers (Ollama-style) get no Authorization header at all. */
export const bearer = (apiKey: string | undefined): Record<string, string> =>
  apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

export const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '');

export const hostOf = (url: string) => new URL(url).host;
