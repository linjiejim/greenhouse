/**
 * IM gateway — deep-link pairing.
 *
 * A logged-in Greenhouse user mints a short code (POST /api/im/pair); the
 * platform deep link (e.g. https://t.me/<bot>?start=<code>) carries it to the
 * bot, which redeems it on `/start <code>` and links the platform identity to
 * that Greenhouse user. Codes are single-use and short-lived.
 */

import { randomBytes } from 'node:crypto';
import { getDb, type DatabaseProvider } from '@greenhouse/db';
import { PAIRING_CODE_TTL_MS } from './types.js';

/** A URL-safe, unambiguous pairing code (Telegram start param allows [A-Za-z0-9_-]). */
export function generatePairingCode(): string {
  return randomBytes(12).toString('base64url'); // 16 chars
}

/** True when a pairing code's ISO deadline is in the past. */
export function isPairingExpired(expiresAt: string, now = Date.now()): boolean {
  return new Date(expiresAt).getTime() <= now;
}

/** Mint (and persist) a pairing code for a user + bot. Invalidates prior codes. */
export async function mintPairingCode(
  botId: string,
  userId: string,
  db: DatabaseProvider = getDb(),
): Promise<{ code: string; expiresAt: string }> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
  await db.im.createPairingCode({ code, bot_id: botId, user_id: userId, expires_at: expiresAt });
  return { code, expiresAt };
}

/**
 * Redeem a code for its bot. Returns the linked Greenhouse user id on success
 * (consuming the code), or null if the code is unknown, for another bot, or
 * expired. The code is consumed (single-use) regardless of validity.
 */
export async function redeemPairingCode(
  botId: string,
  code: string,
  db: DatabaseProvider = getDb(),
): Promise<string | null> {
  const row = await db.im.getPairingCode(code);
  if (!row || row.bot_id !== botId) return null;
  await db.im.deletePairingCode(code);
  if (isPairingExpired(row.expires_at)) return null;
  return row.user_id;
}

/** Delete all expired pairing codes. Returns the number swept. */
export async function sweepExpiredPairingCodes(db: DatabaseProvider = getDb()): Promise<number> {
  return db.im.deleteExpiredPairingCodes();
}

/** Build the platform deep link that carries a pairing code to the bot. */
export function buildDeepLink(channel: 'telegram', botUsername: string | null, code: string): string | null {
  if (channel === 'telegram') {
    return botUsername ? `https://t.me/${botUsername}?start=${code}` : null;
  }
  return null;
}
