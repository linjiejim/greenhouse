/** The vault's pure parts: sealing, sites, one-time codes and masked user names. */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../http/errors.js';
import { createVaultCrypto } from '../crypto.js';
import { normalizeSite, normalizeSites, originMatches } from '../origin.js';
import { maskUsername } from '../service.js';
import { currentTotp, decodeBase32, parseTotp, totpAt, totpSecretText } from '../totp.js';

const KEY = 'c'.repeat(64);
const SECRET = 'correct horse battery staple';

describe('sealing vault values', () => {
  const crypto = createVaultCrypto(KEY);

  it('opens only where it was sealed: same member, row and column', () => {
    const sealed = crypto.seal('mbr_a', 'vlt_1', 'password_enc', SECRET);
    expect(sealed.startsWith('k1:')).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(crypto.open('mbr_a', 'vlt_1', 'password_enc', sealed)).toBe(SECRET);
    for (const [member, item, column] of [
      ['mbr_b', 'vlt_1', 'password_enc'],
      ['mbr_a', 'vlt_2', 'password_enc'],
      ['mbr_a', 'vlt_1', 'username_enc'],
    ] as const) {
      const error = (() => {
        try {
          crypto.open(member, item, column, sealed);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'vault_unreadable' });
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
    expect(() => crypto.open('mbr_a', 'vlt_1', 'password_enc', `${sealed.slice(0, -4)}AAAA`)).toThrow(
      /no longer be opened/,
    );
    expect(() => crypto.open('mbr_a', 'vlt_1', 'password_enc', sealed.slice(3))).toThrow(/no longer be opened/);
  });

  it('is off without its key, and a different key cannot open what it sealed', () => {
    const off = createVaultCrypto(null);
    expect(off.available).toBe(false);
    expect(() => off.seal('mbr_a', 'vlt_1', 'password_enc', SECRET)).toThrow(/not set up/);
    const sealed = crypto.seal('mbr_a', 'vlt_1', 'password_enc', SECRET);
    expect(() => createVaultCrypto('d'.repeat(64)).open('mbr_a', 'vlt_1', 'password_enc', sealed)).toThrow(
      /no longer be opened/,
    );
  });
});

describe('vault sites', () => {
  const policy = { nodeEnv: 'production', forbidden: ['https://greenhouse.test'] };

  it('stores exact origins and explicit wildcards', () => {
    expect(normalizeSite('github.com', policy)).toBe('https://github.com');
    expect(normalizeSite('HTTPS://GitHub.com/', policy)).toBe('https://github.com');
    expect(normalizeSite('https://example.com:443', policy)).toBe('https://example.com');
    expect(normalizeSite('https://example.com:8443', policy)).toBe('https://example.com:8443');
    expect(normalizeSite('*.example.com', policy)).toBe('*.example.com');
    expect(normalizeSites(['github.com', 'https://github.com'], policy)).toEqual(['https://github.com']);
  });

  it('refuses paths, credentials, other schemes, plain http, broad wildcards and Greenhouse itself', () => {
    const code = (input: string, nodeEnv = 'production') => {
      try {
        normalizeSite(input, { ...policy, nodeEnv });
        return 'ok';
      } catch (error) {
        return (error as ApiError).code;
      }
    };
    expect(code('https://github.com/login')).toBe('origin_invalid');
    expect(code('https://user@github.com')).toBe('origin_invalid');
    expect(code('ftp://github.com')).toBe('origin_invalid');
    expect(code('http://github.com')).toBe('origin_invalid');
    expect(code('http://localhost:8765')).toBe('origin_invalid');
    expect(code('http://localhost:8765', 'test')).toBe('ok');
    expect(code('*.com')).toBe('origin_invalid');
    expect(code('*.10.0.0.1')).toBe('origin_invalid');
    expect(code('http://*.example.com')).toBe('origin_invalid');
    expect(code('https://greenhouse.test')).toBe('origin_forbidden');
    expect(code('*.example.com', 'production')).toBe('ok');
    expect(normalizeSite.bind(null, '*.example.com', { ...policy, forbidden: ['https://gh.example.com'] })).toThrow(
      /Greenhouse itself/,
    );
    expect(() => normalizeSites([], policy)).toThrow(/at least one/);
  });

  it('matches a page origin exactly, or a subdomain over https for a wildcard', () => {
    const sites = ['https://github.com', '*.example.com'];
    expect(originMatches(sites, 'https://github.com')).toBe(true);
    expect(originMatches(sites, 'https://gist.github.com')).toBe(false);
    expect(originMatches(sites, 'https://login.example.com')).toBe(true);
    expect(originMatches(sites, 'https://example.com')).toBe(false);
    expect(originMatches(sites, 'http://login.example.com')).toBe(false);
    expect(originMatches(sites, 'https://login.example.com:8443')).toBe(false);
    expect(originMatches(sites, 'https://evil-example.com')).toBe(false);
    expect(originMatches(sites, 'https://github.com/path')).toBe(false);
    expect(originMatches(sites, null)).toBe(false);
  });
});

describe('one-time codes', () => {
  // RFC 6238 appendix B, SHA-1, 8 digits.
  const rfc = `otpauth://totp/Example:lin?secret=${'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'}&digits=8&algorithm=SHA1`;

  it('computes the RFC test vectors', () => {
    const config = parseTotp(rfc);
    expect(totpAt(config, 59_000)).toBe('94287082');
    expect(totpAt(config, 1_111_111_109_000)).toBe('07081804');
    expect(totpAt(config, 20_000_000_000_000)).toBe('65353130');
  });

  it('takes base32 the way set-up pages show it, and refuses what cannot be a TOTP secret', () => {
    expect(decodeBase32('gezd gnbv-gy3t qojq====')).toEqual(decodeBase32('GEZDGNBVGY3TQOJQ'));
    expect(parseTotp('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')).toMatchObject({ digits: 6, period: 30 });
    expect(() => parseTotp('not base32!')).toThrow(/base32/);
    expect(() => parseTotp('GEZDGNBV')).toThrow(/too short/);
    expect(() => parseTotp('otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQGEZD&counter=1')).toThrow(/time-based/);
    expect(() => parseTotp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZD&digits=4')).toThrow(/6 to 8/);
    expect(totpSecretText(rfc)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('says how long the current code stays good', () => {
    const now = currentTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 61_000);
    expect(now.code).toMatch(/^\d{6}$/);
    expect(now.validForSec).toBe(29);
  });
});

describe('masked user names', () => {
  it('keeps enough to tell logins apart', () => {
    expect(maskUsername('lin@example.com')).toBe('li***@example.com');
    expect(maskUsername('a@example.com')).toBe('a***@example.com');
    expect(maskUsername('linjie')).toBe('li***e');
    expect(maskUsername('jim')).toBe('j***');
    expect(maskUsername('  ')).toBe('');
  });
});
