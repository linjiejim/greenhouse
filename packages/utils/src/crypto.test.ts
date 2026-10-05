import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, parseHexKey } from './crypto.js';

const key = randomBytes(32);

describe('AES-256-GCM', () => {
  it('round-trips without AAD (the historical format)', () => {
    const ciphertext = encrypt('hunter2 · 密码', key);
    expect(decrypt(ciphertext, key)).toBe('hunter2 · 密码');
  });

  it('round-trips with AAD', () => {
    const ciphertext = encrypt('s3cret', key, 'vault:u1:vlt_1:password');
    expect(decrypt(ciphertext, key, 'vault:u1:vlt_1:password')).toBe('s3cret');
  });

  it('refuses a ciphertext moved to another field, item or user', () => {
    const ciphertext = encrypt('s3cret', key, 'vault:u1:vlt_1:password');
    expect(() => decrypt(ciphertext, key, 'vault:u1:vlt_1:username')).toThrow();
    expect(() => decrypt(ciphertext, key, 'vault:u1:vlt_2:password')).toThrow();
    expect(() => decrypt(ciphertext, key, 'vault:u2:vlt_1:password')).toThrow();
  });

  it('refuses AAD-bound data decrypted without AAD, and vice versa', () => {
    const bound = encrypt('s3cret', key, 'vault:u1:vlt_1:password');
    expect(() => decrypt(bound, key)).toThrow();
    const unbound = encrypt('s3cret', key);
    expect(() => decrypt(unbound, key, 'vault:u1:vlt_1:password')).toThrow();
  });

  it('refuses tampered data and the wrong key', () => {
    const ciphertext = encrypt('s3cret', key, 'aad');
    const packed = Buffer.from(ciphertext, 'base64');
    packed[14] = packed[14]! ^ 0xff;
    expect(() => decrypt(packed.toString('base64'), key, 'aad')).toThrow();
    expect(() => decrypt(ciphertext, randomBytes(32), 'aad')).toThrow();
    expect(() => decrypt('AAAA', key)).toThrow(/too short/);
  });

  it('uses a fresh IV per call', () => {
    expect(encrypt('same', key, 'aad')).not.toBe(encrypt('same', key, 'aad'));
  });
});

describe('parseHexKey', () => {
  it('requires a 64-char key', () => {
    expect(() => parseHexKey('', 'K')).toThrow(/K env var is required/);
    expect(() => parseHexKey('abcd', 'K')).toThrow(/64 hex chars/);
    expect(parseHexKey('ab'.repeat(32))).toHaveLength(32);
  });
});
