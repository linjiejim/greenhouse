/**
 * Password hashing unit tests — scrypt hash/verify.
 */

import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../apps/api/src/auth/password.js';

describe('Password Hashing (scrypt)', () => {
  it('hashes and verifies a password', async () => {
    const password = 'my-secure-password-123';
    const hash = await hashPassword(password);
    const valid = await verifyPassword(password, hash);
    expect(valid).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct-password');
    const valid = await verifyPassword('wrong-password', hash);
    expect(valid).toBe(false);
  });

  it('produces different hashes for same password (random salt)', async () => {
    const password = 'same-password';
    const h1 = await hashPassword(password);
    const h2 = await hashPassword(password);
    expect(h1).not.toBe(h2);
  });

  it('hash format is salt:key', async () => {
    const hash = await hashPassword('test');
    const parts = hash.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBe(64); // 32 bytes = 64 hex chars
    expect(parts[1].length).toBe(128); // 64 bytes = 128 hex chars
  });

  it('handles empty password', async () => {
    const hash = await hashPassword('');
    const valid = await verifyPassword('', hash);
    expect(valid).toBe(true);

    const invalid = await verifyPassword('not-empty', hash);
    expect(invalid).toBe(false);
  });

  it('handles unicode passwords', async () => {
    const password = '密码🔒パスワード';
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('rejects malformed hash', async () => {
    expect(await verifyPassword('test', '')).toBe(false);
    expect(await verifyPassword('test', 'no-colon')).toBe(false);
    expect(await verifyPassword('test', ':')).toBe(false);
  });
});
