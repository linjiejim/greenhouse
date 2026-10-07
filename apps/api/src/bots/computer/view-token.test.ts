import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAccessToken } from '../../auth/token.js';
import { createViewToken, TERMINAL_TOKEN_PURPOSE, verifyViewToken, VIEW_TOKEN_TTL_MS } from './view-token.js';

beforeAll(() => {
  process.env.TOKEN_SIGNING_KEY ??= randomBytes(32).toString('hex');
});

const user = { id: 'user-1', authVersion: 3 };

describe('computer view tickets', () => {
  it('binds the member, credential generation and container', () => {
    const { token, expires_at } = createViewToken(user, 'gh-computer-ns-user1', { now: 1_000_000 });
    expect(Date.parse(expires_at)).toBe(1_000_000 + VIEW_TOKEN_TTL_MS);
    expect(verifyViewToken(token, { now: 1_000_500 })).toMatchObject({
      uid: 'user-1',
      av: 3,
      c: 'gh-computer-ns-user1',
    });
  });

  it('is single use', () => {
    const { token } = createViewToken(user, 'c');
    expect(verifyViewToken(token)).not.toBeNull();
    expect(verifyViewToken(token)).toBeNull();
  });

  it('can be checked without being consumed', () => {
    const { token } = createViewToken(user, 'c');
    expect(verifyViewToken(token, { consume: false })).not.toBeNull();
    expect(verifyViewToken(token)).not.toBeNull();
    expect(verifyViewToken(token)).toBeNull();
  });

  it('expires after 60 s', () => {
    const { token } = createViewToken(user, 'c', { now: 2_000_000 });
    expect(verifyViewToken(token, { now: 2_000_000 + VIEW_TOKEN_TTL_MS })).toBeNull();
  });

  it('rejects tampering, garbage and other token families', () => {
    const { token } = createViewToken(user, 'c');
    const [body, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ uid: 'someone-else', av: 3, c: 'c', exp: Date.now() + 60_000, n: 'x' }),
    ).toString('base64url');
    expect(verifyViewToken(`${forged}.${signature}`)).toBeNull();
    expect(verifyViewToken(`${body}.${'0'.repeat(signature!.length)}`)).toBeNull();
    expect(verifyViewToken('')).toBeNull();
    expect(verifyViewToken('no-dot')).toBeNull();
    expect(verifyViewToken(null)).toBeNull();
    // An access token is signed under another purpose and never opens the viewer.
    expect(verifyViewToken(createAccessToken('user-1', 'team', 3))).toBeNull();
  });

  it('keeps the viewer and the terminal apart: a ticket opens only the socket it was issued for', () => {
    const terminal = createViewToken(user, 'c', { purpose: TERMINAL_TOKEN_PURPOSE }).token;
    const viewer = createViewToken(user, 'c').token;
    // Checked crosswise first without consuming: a refusal must not burn the ticket either.
    expect(verifyViewToken(terminal)).toBeNull(); // the viewer's default purpose
    expect(verifyViewToken(viewer, { purpose: TERMINAL_TOKEN_PURPOSE })).toBeNull();
    expect(verifyViewToken(terminal, { purpose: TERMINAL_TOKEN_PURPOSE })).toMatchObject({ uid: 'user-1', c: 'c' });
    expect(verifyViewToken(terminal, { purpose: TERMINAL_TOKEN_PURPOSE })).toBeNull(); // single use
    expect(verifyViewToken(viewer)).not.toBeNull();
    expect(verifyViewToken(createAccessToken('user-1', 'team', 3), { purpose: TERMINAL_TOKEN_PURPOSE })).toBeNull();
  });
});
