/**
 * One-time codes (TOTP, RFC 6238), computed at the moment of a fill and typed straight into the
 * page: neither the secret nor the code reaches an Agent. Takes what authenticator set-up pages
 * hand out: a base32 secret (any case; spaces, dashes and padding ignored) or an
 * `otpauth://totp/…` link with optional digits (6–8), period and algorithm. Counter-based codes
 * (HOTP) are refused: they need state the vault does not keep.
 */

import { createHmac } from 'node:crypto';
import { ApiError } from '../../http/errors.js';

export interface TotpConfig {
  secret: Buffer;
  digits: number;
  period: number;
  algorithm: 'sha1' | 'sha256' | 'sha512';
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const invalid = (message: string): never => {
  throw new ApiError(400, 'totp_invalid', message);
};

/** RFC 4648 base32 to bytes. */
export function decodeBase32(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) invalid('The authenticator secret is empty.');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) invalid('The authenticator secret is not valid base32.');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A stored secret (base32 or otpauth link) as a TOTP configuration. */
export function parseTotp(input: string): TotpConfig {
  const value = input.trim();
  if (!/^otpauth:/i.test(value)) {
    const secret = decodeBase32(value);
    if (secret.length < 10) invalid('The authenticator secret is too short.');
    return { secret, digits: 6, period: 30, algorithm: 'sha1' };
  }
  let url!: URL;
  try {
    url = new URL(value);
  } catch {
    invalid('The otpauth:// link is not valid.');
  }
  if (url.host.toLowerCase() !== 'totp') invalid('Only time-based codes (TOTP) are supported.');
  const secret = decodeBase32(url.searchParams.get('secret') ?? invalid('The otpauth:// link has no secret.'));
  if (secret.length < 10) invalid('The authenticator secret is too short.');
  const digits = Number(url.searchParams.get('digits') ?? 6);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) invalid('Codes must have 6 to 8 digits.');
  const period = Number(url.searchParams.get('period') ?? 30);
  if (!Number.isInteger(period) || period < 10 || period > 300) invalid('The code period must be 10 to 300 seconds.');
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toLowerCase().replace('-', '');
  if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512')
    invalid('That code algorithm is not supported.');
  return { secret, digits, period, algorithm: algorithm as TotpConfig['algorithm'] };
}

/** The code at a moment (RFC 6238 §4, truncation per RFC 4226 §5.3). */
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

/** The current code and how many seconds it stays good. */
export function currentTotp(input: string, now = Date.now()): { code: string; validForSec: number } {
  const config = parseTotp(input);
  return { code: totpAt(config, now), validForSec: config.period - (Math.floor(now / 1000) % config.period) };
}

/** The base32 form of a stored secret, so a page that shows it is redacted too. */
export function totpSecretText(input: string): string {
  const value = input.trim();
  const raw = /^otpauth:/i.test(value) ? (new URL(value).searchParams.get('secret') ?? '') : value;
  return raw.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
}
