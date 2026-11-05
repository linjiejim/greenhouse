/**
 * Plugin object tickets — /api/ext-objects
 *
 * The proxied half of plugin object storage (storage/plugin-objects.ts) for backends that
 * cannot presign: local disk, and S3 without STORAGE_S3_PRESIGN. The ticket in the path is
 * the whole authorization, exactly like a presigned URL: one object, one operation, an
 * expiry, signed with a TOKEN_SIGNING_KEY-derived key. Public path (an <img>/<video> tag
 * sends no Bearer); the owning plugin must still be active.
 *
 *   GET  /:ticket — stream the object; single byte ranges (`Range: bytes=…`) for video seeking
 *   PUT  /:ticket — stream the body to storage; Content-Length required, ≤ the ticket's cap,
 *                   Content-Type must equal the ticket's
 */
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { validateObjectTicket } from '../auth/token.js';
import { contentDisposition } from '../http/content-disposition.js';
import { EXTENSIONS } from '../plugin-host/index.js';
import { pluginObjectStorageKey } from '../storage/plugin-objects.js';
import { headObjectSize, openObjectAtKey, putObjectStreamAtKey } from '../storage/uploads.js';

const notFound = () => new Response(null, { status: 404 });

function ticketFor(raw: string, op: 'r' | 'u') {
  const ticket = validateObjectTicket(raw);
  if (!ticket || ticket.o !== op || !EXTENSIONS.some((ext) => ext.id === ticket.p)) return null;
  try {
    return { ticket, key: pluginObjectStorageKey(ticket.p, ticket.k) };
  } catch {
    return null;
  }
}

/** One `bytes=` range (RFC 9110 §14.1.2); multiple ranges are ignored and served whole. */
export function parseByteRange(
  header: string | undefined,
): { start: number; end?: number } | { suffix: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.includes(',') ? null : 'invalid';
  const [, a, b] = m;
  if (!a && !b) return 'invalid';
  if (!a) return { suffix: Number(b) };
  const start = Number(a);
  const end = b ? Number(b) : undefined;
  if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start)))
    return 'invalid';
  return { start, end };
}

/** Counts bytes and errors the stream once it passes `limit`. */
function byteCap(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) controller.error(new Error('Upload exceeds its declared length'));
      else controller.enqueue(chunk);
    },
  });
}

export default new Hono<AppEnv>()
  .get('/:ticket', async (c) => {
    const found = ticketFor(c.req.param('ticket'), 'r');
    if (!found) return notFound();
    const { ticket, key } = found;

    const parsed = parseByteRange(c.req.header('range'));
    let range: { start: number; end?: number } | undefined;
    if (parsed === 'invalid') return new Response(null, { status: 416 });
    if (parsed && 'suffix' in parsed) {
      const size = await headObjectSize(key);
      if (size === null) return notFound();
      if (parsed.suffix === 0 || size === 0)
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      range = { start: Math.max(0, size - parsed.suffix) };
    } else if (parsed) range = parsed;

    const object = await openObjectAtKey(key, range);
    if (!object) return notFound();
    if (object === 'unsatisfiable') {
      const size = await headObjectSize(key);
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size ?? 0}` } });
    }

    const inline = ticket.d === 'i' && ticket.t;
    const headers = new Headers({
      'Content-Type': inline ? ticket.t! : 'application/octet-stream',
      'Content-Length': String(object.contentLength),
      'Content-Disposition': inline ? 'inline' : contentDisposition(ticket.f ?? key.split('/').pop()!),
      'Accept-Ranges': 'bytes',
      'Cache-Control': `private, max-age=${Math.max(0, ticket.e - Math.floor(Date.now() / 1000))}`,
    });
    if (object.status === 206) {
      const start = range!.start;
      headers.set('Content-Range', `bytes ${start}-${start + object.contentLength - 1}/${object.size}`);
    }
    if (c.req.method === 'HEAD') {
      await object.body.cancel();
      return new Response(null, { status: object.status, headers });
    }
    return new Response(object.body, { status: object.status, headers });
  })
  .put('/:ticket', async (c) => {
    const found = ticketFor(c.req.param('ticket'), 'u');
    if (!found) return notFound();
    const { ticket, key } = found;

    const lengthHeader = c.req.header('content-length');
    if (!lengthHeader || !/^\d+$/.test(lengthHeader)) return c.json({ error: 'Content-Length required' }, 411);
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length > ticket.m!) return c.json({ error: 'file too large' }, 413);
    const type = c.req.header('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== ticket.t) return c.json({ error: 'content type does not match the upload' }, 415);

    const body = c.req.raw.body ?? new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() });
    try {
      await putObjectStreamAtKey(key, body.pipeThrough(byteCap(length)), length, ticket.t!);
    } catch {
      return c.json({ error: 'upload failed' }, 400);
    }
    return c.json({ ok: true, size: length });
  });
