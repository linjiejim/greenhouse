import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto.js';
import {
  greenhouseOrigins,
  isGreenhouseOrigin,
  normalizeOriginPattern,
  normalizeOriginPatterns,
  originMatches,
  originOfUrl,
} from '../origin.js';

const prod = { nodeEnv: 'production', forbidden: [] as string[] };
const dev = { nodeEnv: 'development', forbidden: [] as string[] };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof VaultError ? err.code : 'other';
  }
  return undefined;
}

describe('normalizeOriginPattern', () => {
  it('normalises exact origins (case, default port, trailing slash, bare host)', () => {
    expect(normalizeOriginPattern('https://GitHub.com/', prod)).toBe('https://github.com');
    expect(normalizeOriginPattern('github.com', prod)).toBe('https://github.com');
    expect(normalizeOriginPattern('https://github.com:443', prod)).toBe('https://github.com');
    expect(normalizeOriginPattern('https://example.com:8443', prod)).toBe('https://example.com:8443');
  });

  it('converts IDN hosts to punycode', () => {
    expect(normalizeOriginPattern('https://bücher.de', prod)).toBe('https://xn--bcher-kva.de');
    expect(normalizeOriginPattern('*.bücher.de', prod)).toBe('*.xn--bcher-kva.de');
  });

  it('accepts raw IPs exactly', () => {
    expect(normalizeOriginPattern('https://203.0.113.7', prod)).toBe('https://203.0.113.7');
    expect(normalizeOriginPattern('https://[2001:db8::1]:8443', prod)).toBe('https://[2001:db8::1]:8443');
  });

  it('refuses paths, queries, fragments and credentials instead of dropping them', () => {
    expect(codeOf(() => normalizeOriginPattern('https://github.com/login', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('https://github.com/?next=/', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('https://github.com/#x', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('https://user:pw@github.com', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('ftp://example.com', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('javascript:alert(1)', prod))).toBe('origin_invalid');
  });

  it('refuses plain http except localhost / 127.0.0.1 on dev and test runtimes', () => {
    expect(codeOf(() => normalizeOriginPattern('http://example.com', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('http://localhost:3000', prod))).toBe('origin_invalid');
    expect(normalizeOriginPattern('http://localhost:3000', dev)).toBe('http://localhost:3000');
    expect(normalizeOriginPattern('http://127.0.0.1:8080', { ...dev, nodeEnv: 'test' })).toBe('http://127.0.0.1:8080');
    expect(codeOf(() => normalizeOriginPattern('http://192.168.1.2', dev))).toBe('origin_invalid');
  });

  it('accepts explicit wildcards for real domains only', () => {
    expect(normalizeOriginPattern('*.github.com', prod)).toBe('*.github.com');
    expect(normalizeOriginPattern('https://*.GitHub.com/', prod)).toBe('*.github.com');
    expect(normalizeOriginPattern('*.example.com:8443', prod)).toBe('*.example.com:8443');
    expect(codeOf(() => normalizeOriginPattern('*.com', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('*.10.0.0.1', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('http://*.example.com', prod))).toBe('origin_invalid');
    expect(codeOf(() => normalizeOriginPattern('*.example.com/path', prod))).toBe('origin_invalid');
  });

  it("refuses greenhouse's own origins, and wildcards that would cover them", () => {
    const policy = { nodeEnv: 'production', forbidden: ['https://app.example.com'] };
    expect(codeOf(() => normalizeOriginPattern('https://app.example.com', policy))).toBe('origin_forbidden');
    expect(codeOf(() => normalizeOriginPattern('*.example.com', policy))).toBe('origin_forbidden');
    expect(normalizeOriginPattern('https://example.com', policy)).toBe('https://example.com');
  });

  it('de-duplicates and bounds lists', () => {
    expect(normalizeOriginPatterns(['github.com', 'https://github.com/'], prod)).toEqual(['https://github.com']);
    expect(codeOf(() => normalizeOriginPatterns([], prod))).toBe('origin_invalid');
    expect(
      codeOf(() =>
        normalizeOriginPatterns(
          Array.from({ length: 21 }, (_, i) => `s${i}.com`),
          prod,
        ),
      ),
    ).toBe('origin_invalid');
  });
});

describe('originMatches', () => {
  it('matches exact origins only', () => {
    expect(originMatches(['https://github.com'], 'https://github.com')).toBe(true);
    expect(originMatches(['https://github.com'], 'https://github.com.evil.com')).toBe(false);
    expect(originMatches(['https://github.com'], 'https://evilgithub.com')).toBe(false);
    expect(originMatches(['https://github.com'], 'https://gist.github.com')).toBe(false);
    expect(originMatches(['https://github.com'], 'http://github.com')).toBe(false);
  });

  it('is port-exact', () => {
    expect(originMatches(['https://example.com:8443'], 'https://example.com:8443')).toBe(true);
    expect(originMatches(['https://example.com:8443'], 'https://example.com')).toBe(false);
    expect(originMatches(['https://example.com'], 'https://example.com:8443')).toBe(false);
  });

  it('matches wildcards on subdomains only, over https', () => {
    expect(originMatches(['*.github.com'], 'https://gist.github.com')).toBe(true);
    expect(originMatches(['*.github.com'], 'https://a.b.github.com')).toBe(true);
    expect(originMatches(['*.github.com'], 'https://github.com')).toBe(false);
    expect(originMatches(['*.github.com'], 'https://github.com.evil.com')).toBe(false);
    expect(originMatches(['*.github.com'], 'https://evilgithub.com')).toBe(false);
    expect(originMatches(['*.github.com'], 'http://gist.github.com')).toBe(false);
    expect(originMatches(['*.example.com:8443'], 'https://a.example.com:8443')).toBe(true);
    expect(originMatches(['*.example.com:8443'], 'https://a.example.com')).toBe(false);
  });

  it('compares IDN and IP origins in normalised form', () => {
    expect(originMatches(['https://xn--bcher-kva.de'], originOfUrl('https://bücher.de/login'))).toBe(true);
    expect(originMatches(['https://203.0.113.7'], 'https://203.0.113.7')).toBe(true);
    expect(originMatches(['https://203.0.113.7'], 'https://203.0.113.8')).toBe(false);
  });

  it('never matches non-normalised or non-web origins', () => {
    expect(originMatches(['https://github.com'], 'https://GitHub.com')).toBe(false);
    expect(originMatches(['https://github.com'], 'https://github.com/login')).toBe(false);
    expect(originMatches(['https://github.com'], null)).toBe(false);
    expect(originMatches(['https://github.com'], 'null')).toBe(false);
  });
});

describe('originOfUrl', () => {
  it('returns origins for http(s) only', () => {
    expect(originOfUrl('https://github.com/login?x=1')).toBe('https://github.com');
    expect(originOfUrl('about:blank')).toBeNull();
    expect(originOfUrl('data:text/html,hi')).toBeNull();
    expect(originOfUrl('file:///etc/passwd')).toBeNull();
    expect(originOfUrl('chrome://settings')).toBeNull();
    expect(originOfUrl('not a url')).toBeNull();
  });
});

describe('greenhouse origins', () => {
  it('collects the configured base URLs', () => {
    const origins = greenhouseOrigins({
      PUBLIC_BASE_URL: 'https://gh.example.com/',
      WEB_BASE_URL: 'http://localhost:3100',
      CORS_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
    } as NodeJS.ProcessEnv);
    expect(origins.sort()).toEqual(
      ['https://gh.example.com', 'http://localhost:3100', 'https://a.example.com', 'https://b.example.com'].sort(),
    );
    expect(isGreenhouseOrigin('https://gh.example.com', origins)).toBe(true);
    expect(isGreenhouseOrigin('https://github.com', origins)).toBe(false);
  });
});
