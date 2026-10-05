/**
 * TOTP (RFC 6238) — the vault computes one-time codes server-side and fills
 * them straight into the page; neither the secret nor the code reaches a Bot.
 *
 * Accepts what authenticator set-up screens hand out: a base32 secret (any
 * case, spaces/dashes/padding tolerated) or an `otpauth://totp/…` URI with
 * optional `digits` (6–8), `period` (seconds) and `algorithm`
 * (SHA1/SHA256/SHA512). HOTP (counter-based) is refused: it needs server-side
 * counter state the vault does not keep.
 */

import { createHmac } from 'node:crypto';
import { VaultError } from './crypto.js';

export interface TotpConfig {
  secret: Buffer;
  digits: number;
  period: number;
  algorithm: 'sha1' | 'sha256' | 'sha512';
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function invalid(message: string): never {
  throw new VaultError('totp_invalid', message);
}

/** RFC 4648 base32 → bytes. */
export function decodeBase32(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) invalid('The authenticator secret is empty');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) invalid('The authenticator secret is not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Parse a stored secret (base32 or otpauth:// URI) into a TOTP configuration. */
export function parseTotpSecret(input: string): TotpConfig {
  const value = input.trim();
  if (!/^otpauth:/i.test(value)) {
    const secret = decodeBase32(value);
    if (secret.length < 10) invalid('The authenticator secret is too short');
    return { secret, digits: 6, period: 30, algorithm: 'sha1' };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('The otpauth:// link is not valid');
  }
  if (url.host.toLowerCase() !== 'totp') invalid('Only time-based (TOTP) codes are supported');
  const secretParam = url.searchParams.get('secret');
  if (!secretParam) invalid('The otpauth:// link has no secret');
  const secret = decodeBase32(secretParam);
  if (secret.length < 10) invalid('The authenticator secret is too short');

  const digits = Number(url.searchParams.get('digits') ?? 6);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) invalid('Codes must have 6 to 8 digits');
  const period = Number(url.searchParams.get('period') ?? 30);
  if (!Number.isInteger(period) || period < 10 || period > 300) invalid('The code period must be 10–300 seconds');
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toLowerCase().replace('-', '');
  if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512') {
    invalid('Unsupported code algorithm');
  }
  return { secret, digits, period, algorithm };
}

/** The code for a moment in time (RFC 6238 §4, dynamic truncation per RFC 4226 §5.3). */
export function totpAt(config: TotpConfig, unixMs: number): string {
  const counter = Math.floor(unixMs / 1000 / config.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(config.algorithm, config.secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % 10 ** config.digits).padStart(config.digits, '0');
}

/** The current code and how many seconds it stays valid. */
export function currentTotp(input: string, now = Date.now()): { code: string; validForSec: number; digits: number } {
  const config = parseTotpSecret(input);
  const elapsed = Math.floor(now / 1000) % config.period;
  return { code: totpAt(config, now), validForSec: config.period - elapsed, digits: config.digits };
}
