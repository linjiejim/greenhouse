import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto.js';
import { currentTotp, decodeBase32, parseTotpSecret, totpAt, type TotpConfig } from '../totp.js';

// RFC 6238 Appendix B: seeds are the ASCII strings below, 8 digits, 30 s.
const seeds = {
  sha1: Buffer.from('12345678901234567890'),
  sha256: Buffer.from('12345678901234567890123456789012'),
  sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
};
const vectors: Array<[number, string, string, string]> = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

describe('RFC 6238 test vectors', () => {
  for (const [time, sha1, sha256, sha512] of vectors) {
    it(`T=${time}`, () => {
      const at = (algorithm: TotpConfig['algorithm']) =>
        totpAt({ secret: seeds[algorithm], digits: 8, period: 30, algorithm }, time * 1000);
      expect(at('sha1')).toBe(sha1);
      expect(at('sha256')).toBe(sha256);
      expect(at('sha512')).toBe(sha512);
    });
  }
});

describe('base32', () => {
  it('decodes RFC 4648 with spaces, dashes, padding and lower case', () => {
    // "12345678901234567890" in base32.
    const canonical = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(decodeBase32(canonical).toString()).toBe('12345678901234567890');
    expect(decodeBase32('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq====').toString()).toBe('12345678901234567890');
  });

  it('refuses invalid characters', () => {
    expect(() => decodeBase32('GEZD1NBV')).toThrow(VaultError);
    expect(() => decodeBase32('')).toThrow(VaultError);
  });
});

describe('parseTotpSecret', () => {
  it('reads a bare base32 secret with RFC defaults', () => {
    const config = parseTotpSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(config).toMatchObject({ digits: 6, period: 30, algorithm: 'sha1' });
    // RFC vector truncated to 6 digits.
    expect(totpAt(config, 59_000)).toBe('287082');
  });

  it('reads otpauth:// URIs with digits, period and algorithm', () => {
    const config = parseTotpSecret(
      'otpauth://totp/GitHub:jim?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub&digits=8&period=60&algorithm=SHA256',
    );
    expect(config).toMatchObject({ digits: 8, period: 60, algorithm: 'sha256' });
  });

  it('refuses HOTP, missing secrets and bad parameters', () => {
    const code = (input: string) => {
      try {
        parseTotpSecret(input);
      } catch (err) {
        return (err as VaultError).code;
      }
      return null;
    };
    expect(code('otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1')).toBe('totp_invalid');
    expect(code('otpauth://totp/x?issuer=a')).toBe('totp_invalid');
    expect(code('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=4')).toBe('totp_invalid');
    expect(code('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=MD5')).toBe('totp_invalid');
    expect(code('GEZDGNBV')).toBe('totp_invalid'); // 5 bytes: too short to be a real secret
  });
});

describe('currentTotp', () => {
  it('reports the code and the seconds it stays valid', () => {
    const now = 1111111109_000;
    const result = currentTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', now);
    expect(result.code).toBe('081804');
    expect(result.validForSec).toBe(30 - (1111111109 % 30));
  });
});
