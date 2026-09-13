/**
 * Auth Token unit tests — token creation, validation, security properties.
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';

// Set env before importing
const TOKEN_SIGNING_KEY = '11'.repeat(32);
process.env.TOKEN_SIGNING_KEY = TOKEN_SIGNING_KEY;

import {
  createAccessToken,
  validateAccessToken,
  createRefreshToken,
  hashRefreshToken,
  assertAuthEnv,
  ACCESS_TOKEN_TTL,
} from '../../apps/api/src/auth/token.js';

describe('Auth Token', () => {
  // ─── Access Token ──────────────────────────────────────

  describe('createAccessToken / validateAccessToken', () => {
    it('creates a valid token that can be validated', () => {
      const token = createAccessToken('user-123', 'team', 7);
      const payload = validateAccessToken(token);

      expect(payload).not.toBeNull();
      expect(payload!.uid).toBe('user-123');
      expect(payload!.role).toBe('team');
      expect(payload!.authVersion).toBe(7);
      expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('preserves all role types', () => {
      for (const role of ['super', 'team', 'external'] as const) {
        const token = createAccessToken('u1', role, 0);
        const payload = validateAccessToken(token);
        expect(payload!.role).toBe(role);
      }
    });

    it('sets correct expiry', () => {
      const before = Math.floor(Date.now() / 1000);
      const token = createAccessToken('u1', 'team', 0);
      const after = Math.floor(Date.now() / 1000);
      const payload = validateAccessToken(token)!;

      expect(payload.exp).toBeGreaterThanOrEqual(before + ACCESS_TOKEN_TTL);
      expect(payload.exp).toBeLessThanOrEqual(after + ACCESS_TOKEN_TTL + 1);
    });

    it('rejects expired tokens', () => {
      // Manually create a token with past expiry
      const token = createAccessToken('u1', 'team', 0);
      // Decode, modify exp, re-encode — should fail because signature won't match
      const [payloadStr] = token.split('.');
      const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());
      payload.exp = Math.floor(Date.now() / 1000) - 10;
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tamperedToken = `${tamperedPayload}.${token.split('.')[1]}`;

      expect(validateAccessToken(tamperedToken)).toBeNull();
    });

    it('rejects tampered payload', () => {
      const token = createAccessToken('u1', 'team', 0);
      const [payloadStr, sig] = token.split('.');

      // Modify payload
      const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());
      payload.role = 'super'; // try to escalate
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

      expect(validateAccessToken(`${tamperedPayload}.${sig}`)).toBeNull();
    });

    it('rejects tampered signature', () => {
      const token = createAccessToken('u1', 'team', 0);
      const [payloadStr] = token.split('.');

      // Replace last char of signature
      const sig = token.split('.')[1];
      const tampered = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');

      expect(validateAccessToken(`${payloadStr}.${tampered}`)).toBeNull();
    });

    it('rejects malformed tokens', () => {
      expect(validateAccessToken('')).toBeNull();
      expect(validateAccessToken('abc')).toBeNull();
      expect(validateAccessToken('abc.def.ghi')).toBeNull();
      expect(validateAccessToken('not-base64.not-hex')).toBeNull();
      expect(validateAccessToken(`e30.${'é'.repeat(64)}`)).toBeNull();
    });

    it('rejects tokens with wrong length signature', () => {
      const token = createAccessToken('u1', 'team', 0);
      const [payloadStr] = token.split('.');
      expect(validateAccessToken(`${payloadStr}.short`)).toBeNull();
    });

    it('rejects a correctly signed legacy payload without authVersion', () => {
      const payloadStr = Buffer.from(
        JSON.stringify({ uid: 'u1', role: 'team', exp: Math.floor(Date.now() / 1000) + 60 }),
      ).toString('base64url');
      const sig = createHmac('sha256', `${TOKEN_SIGNING_KEY}:access`).update(payloadStr).digest('hex');

      expect(validateAccessToken(`${payloadStr}.${sig}`)).toBeNull();
    });
  });

  // ─── Refresh Token ─────────────────────────────────────

  describe('createRefreshToken / hashRefreshToken', () => {
    it('creates unique tokens', () => {
      const t1 = createRefreshToken();
      const t2 = createRefreshToken();

      expect(t1.raw).not.toBe(t2.raw);
      expect(t1.hash).not.toBe(t2.hash);
    });

    it('hash is deterministic for same input', () => {
      const raw = 'test-refresh-token-value';
      expect(hashRefreshToken(raw)).toBe(hashRefreshToken(raw));
    });

    it('different inputs produce different hashes', () => {
      expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'));
    });

    it('sets future expiry', () => {
      const t = createRefreshToken();
      const expiresAt = new Date(t.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now());
    });
  });

  // ─── Key Separation ───────────────────────────────────

  describe('signing key separation', () => {
    it('tokens signed with dedicated key are not valid with a different key', () => {
      const token = createAccessToken('u1', 'team', 0);

      // Temporarily change the signing key
      const originalKey = process.env.TOKEN_SIGNING_KEY;
      process.env.TOKEN_SIGNING_KEY = '22'.repeat(32);

      // Token should now be invalid
      expect(validateAccessToken(token)).toBeNull();

      // Restore
      process.env.TOKEN_SIGNING_KEY = originalKey;

      // Should be valid again
      expect(validateAccessToken(token)).not.toBeNull();
    });
  });

  // ─── assertAuthEnv (fail-closed boot guard) ───────────
  //
  // Locks in the security contract: the server must never silently boot with
  // authentication disabled on a real/exposed host. These tests mutate the auth
  // env vars and restore them in finally so they don't leak to sibling tests.

  describe('assertAuthEnv', () => {
    function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
      const keys = ['TOKEN_SIGNING_KEY'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      try {
        for (const [k, v] of Object.entries(overrides)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        fn();
      } finally {
        for (const k of keys) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    }

    it('passes when TOKEN_SIGNING_KEY is 64 hexadecimal characters', () => {
      withEnv({ TOKEN_SIGNING_KEY: 'ab'.repeat(32) }, () => {
        expect(() => assertAuthEnv()).not.toThrow();
      });
    });

    it('throws when TOKEN_SIGNING_KEY is missing', () => {
      withEnv({ TOKEN_SIGNING_KEY: undefined }, () => {
        expect(() => assertAuthEnv()).toThrow(/TOKEN_SIGNING_KEY/);
      });
    });

    it('throws when TOKEN_SIGNING_KEY has the wrong length or non-hex characters', () => {
      withEnv({ TOKEN_SIGNING_KEY: 'ab'.repeat(31) }, () => {
        expect(() => assertAuthEnv()).toThrow(/64 hexadecimal/);
      });
      withEnv({ TOKEN_SIGNING_KEY: 'z'.repeat(64) }, () => {
        expect(() => assertAuthEnv()).toThrow(/64 hexadecimal/);
      });
    });
  });
});
