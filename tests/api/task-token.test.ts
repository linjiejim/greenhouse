/**
 * Cloud Agent task token unit tests — signing, validation, family separation.
 */

import { describe, it, expect } from 'vitest';

// Set env before importing
process.env.TOKEN_SIGNING_KEY = '11'.repeat(32);

import { createTaskToken, validateTaskToken, TASK_TOKEN_GRACE_MS } from '../../apps/api/src/auth/task-token.js';
import { createAccessToken, validateAccessToken } from '../../apps/api/src/auth/token.js';

describe('Cloud Agent task token', () => {
  it('round-trips uid/runId and expires after wall budget + grace', () => {
    const token = createTaskToken('user-1', 'car_abc', 60_000);
    expect(token.startsWith('lpct_')).toBe(true);

    const payload = validateTaskToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.uid).toBe('user-1');
    expect(payload!.runId).toBe('car_abc');

    const expectedExp = Math.floor((Date.now() + 60_000 + TASK_TOKEN_GRACE_MS) / 1000);
    expect(Math.abs(payload!.exp - expectedExp)).toBeLessThanOrEqual(2);
  });

  it('rejects tampered payloads', () => {
    const token = createTaskToken('user-1', 'car_abc', 60_000);
    const [payloadStr, sig] = token.slice('lpct_'.length).split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'user-2', runId: 'car_abc', exp: 9999999999 })).toString(
      'base64url',
    );
    expect(validateTaskToken(`lpct_${forged}.${sig}`)).toBeNull();
    expect(validateTaskToken(`lpct_${payloadStr}.${'0'.repeat(64)}`)).toBeNull();
  });

  it('rejects expired tokens', () => {
    // Negative wall budget pushes exp (budget + grace) into the past.
    const token = createTaskToken('user-1', 'car_abc', -TASK_TOKEN_GRACE_MS - 120_000);
    expect(validateTaskToken(token)).toBeNull();
  });

  it('rejects garbage and empty-claim tokens', () => {
    expect(validateTaskToken('')).toBeNull();
    expect(validateTaskToken('lpct_')).toBeNull();
    expect(validateTaskToken('lpct_abc')).toBeNull();
    expect(validateTaskToken('not-a-token')).toBeNull();

    const empty = Buffer.from(JSON.stringify({ uid: '', runId: 'r', exp: 9999999999 })).toString('base64url');
    // Even a correctly-signed token with an empty uid is rejected (sig won't
    // match here anyway, but the shape check must not accept empty claims).
    expect(validateTaskToken(`lpct_${empty}.${'0'.repeat(64)}`)).toBeNull();
  });

  it('is mutually unverifiable with access tokens (purpose separation)', () => {
    // An access token can never validate as a task token…
    const access = createAccessToken('user-1', 'team', 1);
    expect(validateTaskToken(`lpct_${access}`)).toBeNull();
    expect(validateTaskToken(access)).toBeNull();

    // …and a task token can never validate as an access token.
    const task = createTaskToken('user-1', 'car_abc', 60_000);
    expect(validateAccessToken(task)).toBeNull();
    expect(validateAccessToken(task.slice('lpct_'.length))).toBeNull();
  });
});
