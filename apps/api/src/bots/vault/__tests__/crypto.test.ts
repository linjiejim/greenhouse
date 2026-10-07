import { afterEach, describe, expect, it } from 'vitest';
import { VaultError, decryptVaultField, encryptVaultField, isVaultAvailable, vaultAad } from '../crypto.js';

const KEY = 'a1'.repeat(32);
const original = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
  else process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = original;
});

describe('vault field crypto', () => {
  it('binds each ciphertext to its user, item and field', () => {
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
    const ciphertext = encryptVaultField('u1', 'vlt_1', 'password', 'hunter2');
    expect(ciphertext).not.toContain('hunter2');
    expect(decryptVaultField('u1', 'vlt_1', 'password', ciphertext)).toBe('hunter2');
    for (const [user, item, field] of [
      ['u2', 'vlt_1', 'password'],
      ['u1', 'vlt_2', 'password'],
      ['u1', 'vlt_1', 'username'],
    ] as const) {
      expect(() => decryptVaultField(user, item, field, ciphertext)).toThrow(VaultError);
    }
    expect(vaultAad('u1', 'vlt_1', 'totp')).toBe('vault:u1:vlt_1:totp');
  });

  it('is unavailable without a well-formed 64-hex key', () => {
    delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    expect(isVaultAvailable()).toBe(false);
    expect(() => encryptVaultField('u1', 'vlt_1', 'password', 'x')).toThrow(/not available/);

    // Right length, not hex: Buffer.from(…, 'hex') would silently truncate it.
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = 'zz'.repeat(32);
    expect(isVaultAvailable()).toBe(false);
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(16);
    expect(isVaultAvailable()).toBe(false);

    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
    expect(isVaultAvailable()).toBe(true);
  });

  it('reports a rotated key as an entry to re-enter, without crypto details', () => {
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
    const ciphertext = encryptVaultField('u1', 'vlt_1', 'password', 'hunter2');
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = 'b2'.repeat(32);
    try {
      decryptVaultField('u1', 'vlt_1', 'password', ciphertext);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).code).toBe('vault_unavailable');
      expect((err as VaultError).message).toMatch(/re-enter/);
    }
  });
});
