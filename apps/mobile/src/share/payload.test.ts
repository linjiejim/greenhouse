import { describe, expect, it } from 'vitest';
import { sharePayload, tokenExpiry } from './payload';

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: 1_800_000_000 })}.sig`;
const station = { id: 'st-a', name: 'Acme', baseUrl: 'https://acme.example/' };

describe('the share extension’s session', () => {
  it('carries the active station and its access token, never more', () => {
    const payload = sharePayload({ station, accessToken: jwt, memberName: 'Maya' });
    expect(payload).toEqual({
      v: 1,
      stationId: 'st-a',
      stationName: 'Acme',
      baseUrl: 'https://acme.example',
      accessToken: jwt,
      memberName: 'Maya',
      expiresAt: 1_800_000_000,
    });
    expect(JSON.stringify(payload)).not.toContain('refresh');
  });

  it('is cleared when nobody is signed in on the active station', () => {
    expect(sharePayload({ station, accessToken: null, memberName: 'Maya' })).toBeNull();
    expect(sharePayload({ station: null, accessToken: jwt, memberName: 'Maya' })).toBeNull();
    expect(sharePayload({ station, accessToken: jwt, memberName: null })).toBeNull();
    expect(sharePayload({ station: { ...station, baseUrl: 'javascript:x' }, accessToken: jwt, memberName: 'M' })).toBeNull();
  });

  it('reads a token’s expiry, or none', () => {
    expect(tokenExpiry(jwt)).toBe(1_800_000_000);
    expect(tokenExpiry('opaque')).toBeNull();
  });
});
