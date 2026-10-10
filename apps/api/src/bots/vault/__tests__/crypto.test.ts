import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '@greenhouse/utils/crypto';
import {
  VaultError,
  decryptVaultField,
  encryptVaultField,
  isCurrentVaultCiphertext,
  isVaultAvailable,
  vaultAad,
  vaultKeyId,
} from '../crypto.js';

const KEY = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);
const THIRD = 'c3'.repeat(32);
const ENV = ['VAULT_ENCRYPTION_KEY', 'VAULT_ENCRYPTION_KEY_PREVIOUS', 'PROVIDER_TOKEN_ENCRYPTION_KEY'] as const;
const original = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

function setKeys(keys: Partial<Record<(typeof ENV)[number], string>>): void {
  for (const name of ENV) {
    if (keys[name] === undefined) delete process.env[name];
    else process.env[name] = keys[name];
  }
}

function expectReenter(read: () => unknown): void {
  try {
    read();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).code).toBe('vault_unavailable');
    expect((err as VaultError).message).toMatch(/re-enter/);
  }
}

beforeEach(() => setKeys({}));
afterEach(() => {
  for (const name of ENV) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

describe('vault field crypto', () => {
  it('binds each ciphertext to its user, item and field', () => {
    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
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
    expect(isVaultAvailable()).toBe(false);
    expect(() => encryptVaultField('u1', 'vlt_1', 'password', 'x')).toThrow(/not available/);

    // Right length, not hex: Buffer.from(…, 'hex') would silently truncate it.
    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: 'zz'.repeat(32) });
    expect(isVaultAvailable()).toBe(false);
    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(16) });
    expect(isVaultAvailable()).toBe(false);

    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
    expect(isVaultAvailable()).toBe(true);
    setKeys({ VAULT_ENCRYPTION_KEY: KEY });
    expect(isVaultAvailable()).toBe(true);
  });

  it('never quietly falls back to the provider key when the vault key is mistyped', () => {
    setKeys({ VAULT_ENCRYPTION_KEY: 'zz'.repeat(32), PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
    expect(isVaultAvailable()).toBe(false);
    expect(() => encryptVaultField('u1', 'vlt_1', 'password', 'x')).toThrow(/not available/);
  });

  it('says which key wrote an entry, without revealing anything about the key', () => {
    setKeys({ VAULT_ENCRYPTION_KEY: KEY });
    const ciphertext = encryptVaultField('u1', 'vlt_1', 'password', 'hunter2');
    const kid = vaultKeyId(Buffer.from(KEY, 'hex'));
    expect(kid).toMatch(/^[0-9a-f]{8}$/);
    expect(vaultKeyId(Buffer.from(OTHER, 'hex'))).not.toBe(kid);
    expect(ciphertext.startsWith(`gv1.${kid}.`)).toBe(true);
    expect(isCurrentVaultCiphertext(ciphertext)).toBe(true);
  });

  it('reads entries from before the version prefix with the provider key, and counts them for rekeying', () => {
    setKeys({ VAULT_ENCRYPTION_KEY: OTHER, PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
    const legacy = encrypt('hunter2', Buffer.from(KEY, 'hex'), vaultAad('u1', 'vlt_1', 'password'));
    expect(decryptVaultField('u1', 'vlt_1', 'password', legacy)).toBe('hunter2');
    expect(isCurrentVaultCiphertext(legacy)).toBe(false);
    // Still bound to its row.
    expect(() => decryptVaultField('u2', 'vlt_1', 'password', legacy)).toThrow(VaultError);
  });

  it('gives the vault its own key: entries under the provider key keep working until rekeyed', () => {
    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
    const before = encryptVaultField('u1', 'vlt_1', 'password', 'hunter2');
    setKeys({ VAULT_ENCRYPTION_KEY: OTHER, PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
    expect(decryptVaultField('u1', 'vlt_1', 'password', before)).toBe('hunter2');
    expect(isCurrentVaultCiphertext(before)).toBe(false);
    const after = encryptVaultField('u1', 'vlt_1', 'password', 'hunter2');
    expect(isCurrentVaultCiphertext(after)).toBe(true);
    // The provider key alone no longer reads what the vault key wrote.
    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
    expectReenter(() => decryptVaultField('u1', 'vlt_1', 'password', after));
  });

  it('rotates: the previous key still reads, only the current one writes, and dropping it ends that', () => {
    setKeys({ VAULT_ENCRYPTION_KEY: KEY, PROVIDER_TOKEN_ENCRYPTION_KEY: THIRD });
    const old = encryptVaultField('u1', 'vlt_1', 'totp', 'JBSWY3DPEHPK3PXP');
    setKeys({ VAULT_ENCRYPTION_KEY: OTHER, VAULT_ENCRYPTION_KEY_PREVIOUS: KEY, PROVIDER_TOKEN_ENCRYPTION_KEY: THIRD });
    expect(decryptVaultField('u1', 'vlt_1', 'totp', old)).toBe('JBSWY3DPEHPK3PXP');
    expect(isCurrentVaultCiphertext(old)).toBe(false);
    const rekeyed = encryptVaultField('u1', 'vlt_1', 'totp', 'JBSWY3DPEHPK3PXP');
    expect(rekeyed.startsWith(`gv1.${vaultKeyId(Buffer.from(OTHER, 'hex'))}.`)).toBe(true);

    setKeys({ VAULT_ENCRYPTION_KEY: OTHER, PROVIDER_TOKEN_ENCRYPTION_KEY: THIRD });
    expect(decryptVaultField('u1', 'vlt_1', 'totp', rekeyed)).toBe('JBSWY3DPEHPK3PXP');
    expectReenter(() => decryptVaultField('u1', 'vlt_1', 'totp', old));
  });

  it('reports a key it no longer has, or a tampered entry, as one to re-enter — no crypto details', () => {
    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
    const ciphertext = encryptVaultField('u1', 'vlt_1', 'password', 'hunter2');
    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: OTHER });
    expectReenter(() => decryptVaultField('u1', 'vlt_1', 'password', ciphertext));

    setKeys({ PROVIDER_TOKEN_ENCRYPTION_KEY: KEY });
    const payload = ciphertext.split('.')[2]!;
    const flipped = `${payload[0] === 'A' ? 'B' : 'A'}${payload.slice(1)}`;
    expectReenter(() => decryptVaultField('u1', 'vlt_1', 'password', ciphertext.replace(payload, flipped)));
  });
});
