import { describe, expect, it } from 'vitest';
import { normalizeSite, normalizeTotpSecret, parseSiteLines, secretWrite } from './vault-fields';

describe('normalizeSite', () => {
  it('keeps exact https origins and trims what the address bar adds', () => {
    expect(normalizeSite('https://github.com')).toBe('https://github.com');
    expect(normalizeSite('  github.com/login?return_to=%2F ')).toBe('https://github.com');
    expect(normalizeSite('HTTPS://GitHub.com:8443/settings')).toBe('https://github.com:8443');
    expect(normalizeSite('https://github.com:443/')).toBe('https://github.com');
  });

  it('treats a look-alike host as its own site, never as a match for the real one', () => {
    expect(normalizeSite('github.com.evil.com')).toBe('https://github.com.evil.com');
  });

  it('only includes subdomains when written as an explicit wildcard', () => {
    expect(normalizeSite('*.example.com')).toBe('*.example.com');
    expect(normalizeSite('https://*.Example.com/')).toBe('*.example.com');
    expect(normalizeSite('*.example.com:8443')).toBe('*.example.com:8443');
    expect(normalizeSite('*.example.com/path')).toBeNull();
    expect(normalizeSite('*.com')).toBeNull();
    expect(normalizeSite('*.10.0.0.1')).toBeNull();
    expect(normalizeSite('https://a*.example.com')).toBeNull();
  });

  it('refuses plain http except for local development hosts', () => {
    expect(normalizeSite('http://github.com')).toBeNull();
    expect(normalizeSite('http://localhost:3100')).toBe('http://localhost:3100');
    expect(normalizeSite('http://127.0.0.1:8080/login')).toBe('http://127.0.0.1:8080');
  });

  it('rejects things that are not sites', () => {
    expect(normalizeSite('ftp://example.com')).toBeNull();
    expect(normalizeSite('https://user:secret@github.com')).toBeNull();
    expect(normalizeSite('github')).toBeNull();
    expect(normalizeSite('999.1.1.1')).toBeNull();
    expect(normalizeSite('')).toBeNull();
  });

  it('accepts raw IPs and converts international domain names to punycode', () => {
    expect(normalizeSite('10.0.0.8')).toBe('https://10.0.0.8');
    expect(normalizeSite('例子.中国')).toBe('https://xn--fsqu00a.xn--fiqs8s');
    expect(normalizeSite('*.例子.中国')).toBe('*.xn--fsqu00a.xn--fiqs8s');
  });
});

describe('parseSiteLines', () => {
  it('dedupes, skips blank lines and reports bad lines by number', () => {
    const parsed = parseSiteLines('github.com\n\nhttps://github.com/login\nnot a site\n*.example.com');
    expect(parsed.origins).toEqual(['https://github.com', '*.example.com']);
    expect(parsed.invalid).toEqual([{ line: 4, value: 'not a site' }]);
  });
});

describe('normalizeTotpSecret', () => {
  it('accepts base32 setup keys as printed (spaces, dashes, lower case)', () => {
    expect(normalizeTotpSecret('jbsw y3dp ehpk 3pxp')).toBe('JBSWY3DPEHPK3PXP');
    expect(normalizeTotpSecret('JBSW-Y3DP-EHPK-3PXP')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('accepts otpauth://totp links as-is', () => {
    const uri = 'otpauth://totp/GitHub:mia?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
    expect(normalizeTotpSecret(uri)).toBe(uri);
  });

  it('rejects counters, short keys and non-base32 text', () => {
    expect(normalizeTotpSecret('otpauth://hotp/GitHub:mia?secret=JBSWY3DPEHPK3PXP&counter=1')).toBeNull();
    expect(normalizeTotpSecret('otpauth://totp/GitHub:mia?issuer=GitHub')).toBeNull();
    expect(normalizeTotpSecret('JBSWY3DP')).toBeNull();
    expect(normalizeTotpSecret('123456 789012 345678')).toBeNull();
  });
});

describe('secretWrite', () => {
  it('maps the write-only field to keep / remove / replace', () => {
    expect(secretWrite({ value: '', clear: false })).toBeUndefined();
    expect(secretWrite({ value: 'typed', clear: true })).toBe('');
    expect(secretWrite({ value: 'hunter2', clear: false })).toBe('hunter2');
    expect(secretWrite({ value: 'jbsw y3dp ehpk 3pxp', clear: false }, normalizeTotpSecret)).toBe('JBSWY3DPEHPK3PXP');
  });
});
