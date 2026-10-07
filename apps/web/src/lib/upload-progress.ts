/**
 * POST a raw body and report upload progress.
 *
 * fetch() has no upload progress, so this is the app's one XMLHttpRequest. It
 * authenticates the way authFetch's first attempt does (the stored Bearer
 * token, the API base for split hosting / the desktop shell); a caller that
 * gets a 401 retries through authFetch, which refreshes the token or sends
 * the member to sign in. The result is a regular `Response`, so failures are
 * read with the same code as every other call.
 */

import { apiUrl } from './api-base';
import { getStoredToken } from './auth';

export interface ProgressUploadOptions {
  headers?: Record<string, string>;
  /** Bytes sent so far, and the total. */
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** Statuses whose response may not carry a body (`new Response` refuses one). */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

function abortError(): DOMException {
  return new DOMException('The upload was aborted.', 'AbortError');
}

function responseHeaders(xhr: XMLHttpRequest): Headers {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().split(/[\r\n]+/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      // A header name the Headers class refuses: not one we read.
    }
  }
  return headers;
}

export function postWithProgress(url: string, body: Blob, options: ProgressUploadOptions = {}): Promise<Response> {
  const { headers = {}, onProgress, signal } = options;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const settle = () => signal?.removeEventListener('abort', onAbort);

    xhr.open('POST', apiUrl(url));
    xhr.responseType = 'blob';
    const token = getStoredToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.lengthComputable ? event.total : body.size);
    xhr.onload = () => {
      settle();
      const { status } = xhr;
      if (status < 200 || status > 599) {
        reject(new TypeError('Network request failed'));
        return;
      }
      resolve(
        new Response(NULL_BODY_STATUS.has(status) ? null : (xhr.response as Blob | null), {
          status,
          statusText: xhr.statusText,
          headers: responseHeaders(xhr),
        }),
      );
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError('Network request failed'));
    };
    xhr.onabort = () => {
      settle();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(body);
  });
}
