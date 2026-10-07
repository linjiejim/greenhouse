/**
 * One-time tickets for the computer's WebSockets: the live viewer
 * (`/api/ws/computer`, spec §6.4) and the terminal (`/api/ws/computer-terminal`).
 *
 * A browser WebSocket cannot send a Bearer header, so both authenticate with
 * `?token=` (the request logger redacts `token`). A ticket is short (60 s),
 * single-use and bound to the member, their credential generation
 * (`auth_version` — a password reset or a disable kills it) and the container
 * name it was issued for. It is signed with the shared token key under its
 * socket's own purpose, so it can never pass as any other token — and a
 * viewer ticket never opens a terminal (the agent's shell) nor the other way
 * round.
 *
 * Single use is enforced in process: a ticket is minted and redeemed within a
 * minute against the same API (the slot serving the page); the consumed set
 * only has to outlive the 60 s expiry.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';

import { userHasFeature } from '../../auth/features.js';
import { hmacSign } from '../../auth/token.js';

/** safeJsonParse with the caller's expected shape (still validated field by field). */
function parseJson<T>(text: string): T | null {
  return safeJsonParse(text, null) as T | null;
}

export const VIEW_TOKEN_PURPOSE = 'bots-computer-view';
export const TERMINAL_TOKEN_PURPOSE = 'bots-computer-terminal';
export type ComputerTicketPurpose = typeof VIEW_TOKEN_PURPOSE | typeof TERMINAL_TOKEN_PURPOSE;
export const VIEW_TOKEN_TTL_MS = 60_000;

export interface ViewTokenClaims {
  uid: string;
  /** users.auth_version at issue time. */
  av: number;
  /** Container name the ticket is good for. */
  c: string;
  /** Expiry (epoch ms). */
  exp: number;
  /** Nonce — the single-use key. */
  n: string;
}

const consumed = new Map<string, number>();

function prune(now: number): void {
  for (const [nonce, exp] of consumed) if (exp <= now) consumed.delete(nonce);
}

export function createViewToken(
  user: { id: string; authVersion: number },
  container: string,
  opts: { now?: number; purpose?: ComputerTicketPurpose } = {},
): { token: string; expires_at: string } {
  const now = opts.now ?? Date.now();
  const claims: ViewTokenClaims = {
    uid: user.id,
    av: user.authVersion,
    c: container,
    exp: now + VIEW_TOKEN_TTL_MS,
    n: randomBytes(16).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = hmacSign(body, opts.purpose ?? VIEW_TOKEN_PURPOSE);
  return { token: `${body}.${signature}`, expires_at: new Date(claims.exp).toISOString() };
}

/**
 * Verify a ticket for one purpose (default: the viewer) and, by default,
 * consume it. Returns null when it is malformed, forged, signed for another
 * purpose, expired or already used. The caller still re-reads the member
 * (status, role, auth_version, feature) before opening the tunnel.
 */
export function verifyViewToken(
  token: string | null | undefined,
  opts: { now?: number; consume?: boolean; purpose?: ComputerTicketPurpose } = {},
): ViewTokenClaims | null {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmacSign(body, opts.purpose ?? VIEW_TOKEN_PURPOSE));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  const claims = parseJson<Partial<ViewTokenClaims> | null>(Buffer.from(body, 'base64url').toString('utf8'));
  if (
    !claims ||
    typeof claims.uid !== 'string' ||
    typeof claims.av !== 'number' ||
    typeof claims.c !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.n !== 'string'
  ) {
    return null;
  }
  const now = opts.now ?? Date.now();
  prune(now);
  if (claims.exp <= now) return null;
  if (consumed.has(claims.n)) return null;
  if (opts.consume !== false) consumed.set(claims.n, claims.exp);
  return claims as ViewTokenClaims;
}

/**
 * Re-read a ticket's member: may they still use their computer? Active,
 * internal (team or super), the same credential generation the ticket was
 * issued under, and the `bots` feature on. Sockets call it when they open and
 * every minute after (the viewer keeps an identical private copy).
 */
export async function ticketHolderStatus(
  userId: string,
  authVersion: number,
): Promise<'ok' | 'unauthorized' | 'forbidden'> {
  const user = await getDb().users.getById(userId);
  if (!user || user.status !== 'active' || user.auth_version !== authVersion) return 'unauthorized';
  if (user.role !== 'super' && user.role !== 'team') return 'unauthorized';
  return (await userHasFeature(user.id, user.role, 'bots')) ? 'ok' : 'forbidden';
}
