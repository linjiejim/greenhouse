/**
 * Crypto module unit tests — AES-256-GCM encryption/decryption.
 *
 * Tests auth/crypto.ts (provider tokens).
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

// Generate test keys
const TEST_PROVIDER_KEY = randomBytes(32).toString('hex');

// Set env before importing
process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = TEST_PROVIDER_KEY;

import {
  encryptToken,
  decryptToken,
  isEncryptionConfigured as isProviderConfigured,
} from '../../apps/api/src/auth/crypto.js';

describe('Auth Crypto (Provider Tokens)', () => {
  it('encrypts and decrypts a string round-trip', () => {
    const plaintext = 'sk-abc123-secret-token-value';
    const encrypted = encryptToken(plaintext);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same input (random IV)', () => {
    const plaintext = 'same-input-token';
    const a = encryptToken(plaintext);
    const b = encryptToken(plaintext);
    expect(a).not.toBe(b); // Different IVs → different output
  });

  it('handles empty string', () => {
    const encrypted = encryptToken('');
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe('');
  });

  it('handles long strings', () => {
    const plaintext = 'x'.repeat(10000);
    const encrypted = encryptToken(plaintext);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('handles unicode characters', () => {
    const plaintext = '你好世界 🌱 こんにちは';
    const encrypted = encryptToken(plaintext);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('detects tampered ciphertext (GCM auth tag)', () => {
    const encrypted = encryptToken('secret-value');
    const bytes = Buffer.from(encrypted, 'base64');
    // Flip a byte in the ciphertext (not IV, not tag)
    bytes[15] ^= 0xff;
    const tampered = bytes.toString('base64');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('rejects truncated ciphertext', () => {
    const encrypted = encryptToken('secret');
    const truncated = encrypted.slice(0, 10);
    expect(() => decryptToken(truncated)).toThrow();
  });

  it('fails with wrong key', () => {
    const encrypted = encryptToken('secret');
    const originalKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    expect(() => decryptToken(encrypted)).toThrow();
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it('reports encryption configured', () => {
    expect(isProviderConfigured()).toBe(true);
  });
});

describe('Key Validation', () => {
  it('rejects invalid key length for provider tokens', () => {
    const originalKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = 'too-short';
    expect(() => encryptToken('test')).toThrow(/64 hex chars/);
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it('rejects missing key for provider tokens', () => {
    const originalKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken('test')).toThrow();
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = originalKey;
  });
});
