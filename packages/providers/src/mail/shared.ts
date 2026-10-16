/**
 * Plumbing for the mail adapters: addresses, header values, the vendors' verdicts and the size
 * limits every received mail is held to. Pure, apart from reading a response body under a cap.
 */

import type { InboundAttachment, MailAddress, MailVerdict } from '../types.js';

/** What a received mail may weigh before parts of it are left out (providers.md §6 邮箱). */
export const MAIL_LIMITS = {
  subjectChars: 500,
  /** Plain text kept for reading and search; the rest is cut. */
  textChars: 200_000,
  /** An HTML body larger than this is dropped (the text stays). */
  htmlBytes: 2 * 1024 * 1024,
  attachmentBytes: 15 * 1024 * 1024,
  totalAttachmentBytes: 25 * 1024 * 1024,
  attachments: 20,
  /** To, Cc and envelope recipients each. */
  addresses: 100,
} as const;

/** An address as SMTP and the vendors take it: no spaces, no angle brackets, one @. */
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

export const isAddress = (value: string) => value.length <= 254 && ADDRESS.test(value);

/** Cuts text to `max` characters (whole characters, never half a surrogate pair). */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** A header value or display name as one line: CR and LF would start a new header. */
export const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();

/** `Name <a@b.c>`, `"Last, First" <a@b.c>` or `a@b.c`; null when there is no usable address. */
export function parseAddress(raw: string | null | undefined): MailAddress | null {
  if (!raw || raw.length > 1000) return null;
  const text = oneLine(raw);
  const angled = /^(.*)<([^<>]+)>\s*$/.exec(text);
  const address = (angled ? angled[2]! : text).trim().toLowerCase();
  if (!isAddress(address)) return null;
  const name = angled
    ? angled[1]!
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/\\(.)/g, '$1')
        .trim()
    : '';
  return name ? { address, name: cut(name, 200) } : { address };
}

/** A header's list of addresses (commas inside quotes belong to a name), or an array of them. */
export function parseAddressList(raw: string | readonly string[] | null | undefined): MailAddress[] {
  if (!raw) return [];
  const parts: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    let current = '';
    let quoted = false;
    let angled = false;
    for (const char of String(entry)) {
      if (char === '"') quoted = !quoted;
      else if (char === '<' && !quoted) angled = true;
      else if (char === '>' && !quoted) angled = false;
      if (char === ',' && !quoted && !angled) {
        parts.push(current);
        current = '';
      } else current += char;
    }
    parts.push(current);
  }
  const seen = new Set<string>();
  const out: MailAddress[] = [];
  for (const part of parts) {
    const parsed = parseAddress(part);
    if (!parsed || seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    out.push(parsed);
    if (out.length >= MAIL_LIMITS.addresses) break;
  }
  return out;
}

/** An address for a header: the name quoted when it holds anything but plain words. */
export function formatAddress(entry: MailAddress): string {
  const name = entry.name ? oneLine(entry.name) : '';
  if (!name) return entry.address;
  const plain = /^[\p{L}\p{N} .'_-]+$/u.test(name);
  return `${plain ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`} <${entry.address}>`;
}

/** One Message-ID with its angle brackets, or null when the value is not one. */
export function messageIdOf(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000) return null;
  const match = /<([^<>\s]{1,900})>/.exec(raw) ?? /^\s*([^<>\s@]{1,450}@[^<>\s@]{1,450})\s*$/.exec(raw);
  return match ? `<${match[1]}>` : null;
}

/** Every Message-ID in a References header, oldest first, at most 50 (the newest kept). */
export function referencesOf(raw: string | readonly string[] | null | undefined): string[] {
  if (!raw) return [];
  const text = (Array.isArray(raw) ? raw.join(' ') : String(raw)).slice(-50_000);
  const ids = [...text.matchAll(/<([^<>\s]{1,900})>/g)].map((match) => `<${match[1]}>`);
  return ids.slice(-50);
}

/** A vendor's word for a check result, in our words; anything unexpected is unknown. */
export function verdictOf(raw: unknown): MailVerdict {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (value) {
    case 'pass':
    case 'fail':
    case 'softfail':
    case 'neutral':
    case 'none':
    case 'temperror':
    case 'permerror':
      return value;
    case 'soft fail':
      return 'softfail';
    case 'hardfail':
      return 'fail';
    default:
      return 'unknown';
  }
}

/** The signing domains (d=) of DKIM-Signature header values, lower case. */
export function dkimDomainsOf(values: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const value of values) {
    const match = /(?:^|;) ?d ?= ?([A-Za-z0-9.-]{1,253}) ?(?:;|$)/.exec(value.slice(0, 10_000).replace(/\s+/g, ' '));
    if (match) domains.add(match[1]!.toLowerCase().replace(/\.$/, ''));
  }
  return [...domains];
}

/** Every value of a header in a list of `[name, value]` pairs, in order. */
export function headerValues(pairs: readonly (readonly [string, string])[], name: string): string[] {
  const wanted = name.toLowerCase();
  return pairs.filter(([key]) => key.toLowerCase() === wanted).map(([, value]) => value);
}

/**
 * A verdict header the receiving server adds: trusted only when it appears exactly once. A sender
 * can write the same header into their mail; two of them mean someone tried, and neither counts.
 */
export function singleVerdict(pairs: readonly (readonly [string, string])[], name: string): MailVerdict {
  const values = headerValues(pairs, name);
  return values.length === 1 ? verdictOf(values[0]) : 'unknown';
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
/** Tags whose content is never text. */
const HIDDEN = new Set(['script', 'style', 'head', 'title']);
/** Tags that end a line. */
const BREAKS = new Set(['br', 'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table']);

/**
 * Readable text from an HTML body, for mail that came without a plain part. One pass with indexOf:
 * a sender's markup cannot make it slow (no pattern backtracks over the whole body).
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, open);
    const close = html.indexOf('>', open + 1);
    // A "<" that never closes is text, and so is everything after it.
    if (close === -1) {
      out += html.slice(open);
      break;
    }
    const tag = /^\/?([a-z0-9]{1,20})/.exec(lower.slice(open + 1, Math.min(close, open + 40)))?.[1] ?? '';
    const ending = lower[open + 1] === '/';
    if (HIDDEN.has(tag) && !ending) {
      const end = lower.indexOf(`</${tag}`, close + 1);
      if (end === -1) break;
      const after = html.indexOf('>', end);
      at = after === -1 ? html.length : after + 1;
      out += ' ';
      continue;
    }
    out += BREAKS.has(tag) ? '\n' : ' ';
    at = close + 1;
  }
  return out
    .replace(/&(#?[a-z0-9]{1,10});/gi, (entity, name: string) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower]) return ENTITIES[lower];
      const code = lower.startsWith('#x')
        ? Number.parseInt(lower.slice(2), 16)
        : lower.startsWith('#')
          ? Number(lower.slice(1))
          : NaN;
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : entity;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The body, or null once it passes `max` bytes (read no further than that). */
export async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Fits attachments into the limits, in order: each one's size, their number and their total. */
export class AttachmentBudget {
  private count = 0;
  private total = 0;

  /** Why this one is left out without downloading it, or null to fetch it. */
  before(size: number): InboundAttachment['skipped'] | null {
    if (this.count >= MAIL_LIMITS.attachments) return 'too_many';
    if (size > MAIL_LIMITS.attachmentBytes || this.total + size > MAIL_LIMITS.totalAttachmentBytes) return 'too_large';
    return null;
  }

  /** The cap for downloading one whose declared size may be wrong. */
  cap(): number {
    return Math.min(MAIL_LIMITS.attachmentBytes, MAIL_LIMITS.totalAttachmentBytes - this.total);
  }

  take(size: number): void {
    this.count += 1;
    this.total += size;
  }
}

/** A content type as it may be stored: `type/subtype`, else a download. */
export const contentTypeOf = (raw: unknown) => {
  const value = typeof raw === 'string' ? raw.split(';')[0]!.trim().toLowerCase() : '';
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream';
};

/** A file name without paths or control characters. */
export const fileNameOf = (raw: unknown, fallback = 'attachment') => {
  const value = typeof raw === 'string' ? oneLine(raw).replace(/[\\/]/g, '_') : '';
  return cut(value || fallback, 200);
};
