/**
 * Agent addresses and who a sender is. Pure.
 *
 * - A new mailbox is `<the Agent's name in ASCII>-<4 random characters>@<the Agent domain>`.
 * - A From address can be forged: a sender counts as verified only when the receiving server's
 *   DMARC passed, or its SPF or DKIM passed for a domain aligned with the From domain (one is the
 *   other or under it, DMARC's relaxed alignment).
 */

import { randomInt } from 'node:crypto';
import type { InboundMail } from '@greenhouse/providers';

/** Readable at a glance: no 0/o, 1/l/i. */
const SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Local parts no Agent may take: they mean something to mail servers and people. */
export const RESERVED_LOCAL_PARTS = new Set([
  'abuse',
  'admin',
  'administrator',
  'hostmaster',
  'mailer-daemon',
  'noreply',
  'no-reply',
  'postmaster',
  'root',
  'security',
  'webmaster',
]);

export function randomSuffix(length = 4): string {
  let out = '';
  for (let index = 0; index < length; index++) out += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  return out;
}

/** `Greeny` → `greeny-k3v9`; a name without ASCII letters becomes `agent-k3v9`. */
export function localPartFor(name: string, suffix = randomSuffix()): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'agent';
  return `${base}-${suffix}`;
}

export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at > 0 && at < address.length - 1 ? address.slice(at + 1).toLowerCase() : null;
}

export function localPartOf(address: string): string {
  const at = address.lastIndexOf('@');
  return (at > 0 ? address.slice(0, at) : address).toLowerCase();
}

/** Relaxed alignment: the same domain, or one under the other. */
export function aligned(a: string, b: string): boolean {
  const left = a.toLowerCase().replace(/\.$/, '');
  const right = b.toLowerCase().replace(/\.$/, '');
  return !!left && !!right && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`));
}

/**
 * Whether the From address is really the sender's: the receiving server's DMARC passed, or SPF
 * passed for an aligned envelope sender, or DKIM passed and every signature in the mail is from an
 * aligned domain (a summary "pass" cannot then belong to someone else's signature).
 */
export function senderVerified(mail: Pick<InboundMail, 'from' | 'auth' | 'envelopeFrom' | 'dkimDomains'>): boolean {
  const fromDomain = domainOf(mail.from.address);
  if (!fromDomain) return false;
  if (mail.auth.dmarc === 'pass') return true;
  const envelope = mail.envelopeFrom ? domainOf(mail.envelopeFrom) : null;
  if (mail.auth.spf === 'pass' && envelope && aligned(envelope, fromDomain)) return true;
  return (
    mail.auth.dkim === 'pass' &&
    mail.dkimDomains.length > 0 &&
    mail.dkimDomains.every((domain) => aligned(domain, fromDomain))
  );
}

/** A Subject line for a reply: `Re: ` once. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(re|回复|答复)\s*[:：]/i.test(trimmed) ? trimmed : `Re: ${trimmed || '(no subject)'}`;
}
