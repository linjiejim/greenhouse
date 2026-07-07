/**
 * One-time SSO login tickets.
 *
 * The IdP callback is a top-level redirect, so tokens must not ride the URL
 * (browser history / logs). Instead the callback issues a short-lived,
 * single-use random ticket; the SPA exchanges it for a token pair via
 * POST /api/auth/sso/exchange.
 *
 * In-memory store — same single-instance assumption as local-disk uploads
 * (a restart inside the 60s window just means logging in again).
 */

import { createHash, randomBytes } from 'node:crypto';

const TICKET_TTL_MS = 60_000;

interface TicketEntry {
  userId: string;
  expiresAt: number;
}

const tickets = new Map<string, TicketEntry>();

function hashTicket(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Issue a single-use login ticket for a user who just passed IdP verification. */
export function issueLoginTicket(userId: string): string {
  const raw = randomBytes(32).toString('hex');
  tickets.set(hashTicket(raw), { userId, expiresAt: Date.now() + TICKET_TTL_MS });
  return raw;
}

/** Redeem a ticket (single use). Returns the user id, or null if unknown/expired. */
export function redeemLoginTicket(raw: string): { userId: string } | null {
  const key = hashTicket(raw);
  const entry = tickets.get(key);
  if (!entry) return null;
  tickets.delete(key); // single use — even if expired
  if (entry.expiresAt < Date.now()) return null;
  return { userId: entry.userId };
}

/** Drop expired tickets (issuance is bounded by the IdP + rate limit, but stay tidy). */
export function sweepExpiredTickets(): void {
  const now = Date.now();
  for (const [key, entry] of tickets) {
    if (entry.expiresAt < now) tickets.delete(key);
  }
}

setInterval(sweepExpiredTickets, 5 * 60_000).unref();
