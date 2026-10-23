/**
 * HTTP plumbing for the E2B driver (ported from the v2 providers package,
 * packages/providers/src/http.ts — only what the driver uses). Vendors report
 * failures in many shapes; callers get one short error that names the call,
 * keeps the HTTP status (a 4xx means the provider refused and did nothing) and
 * never repeats a secret, even when the vendor echoes it back.
 */

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
  /** Names the call in messages, e.g. "Creating the computer at e2b.app". */
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
  404: 'Check the domain and the template.',
  408: 'Try again.',
  429: 'Rate limited or out of quota; try again later.',
};

const MESSAGE_KEYS = ['message', 'error', 'detail', 'msg'];

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
  // An HTML error page from a proxy or a wrong domain says nothing useful.
  if (!trimmed || trimmed.startsWith('<')) return undefined;
  let detail: string | undefined = trimmed;
  try {
    detail = messageIn(JSON.parse(trimmed));
  } catch {
    // Plain text: keep it.
  }
  return detail?.replace(/\s+/g, ' ').slice(0, 200);
}

function providerError(
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

/** Why fetch itself threw, in a form that is safe to show. */
function fetchFailure(error: unknown, url: string, call: CallContext): Error {
  const { name, message, cause } = (error ?? {}) as { name?: unknown; message?: unknown; cause?: unknown };
  if (name === 'TimeoutError') {
    return new ProviderRequestError(`${call.label} timed out after ${Math.round(call.timeoutMs / 1000)}s.`, 408);
  }
  const { code, message: causeMessage } = (cause ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === 'string') {
    return new ProviderRequestError(`${call.label} could not reach ${new URL(url).host} (${code}).`, undefined, code);
  }
  // Anything else may quote what was sent, key included.
  const detail = [message, causeMessage].filter((part) => typeof part === 'string' && part).join(': ');
  return providerError(call, { detail: detail || String(error) });
}

/**
 * Sends one request; only a 2xx response comes back. Redirects are refused: a
 * credential is only ever sent to the endpoint it was configured for.
 */
export async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, call: CallContext) {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(call.timeoutMs) });
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
    throw new ProviderRequestError(`${call.label} returned a response that is not JSON. Check the domain.`);
  }
}
