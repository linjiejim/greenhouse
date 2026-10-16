/**
 * Provider secrets are write-only: sealed with AES-256-GCM, bound to their row and column, and
 * opened only inside the server to build a client. The `k1:` prefix names the key generation.
 */

import { decrypt, encrypt } from '@greenhouse/utils/crypto';

const PREFIX = 'k1:';

export function sealSecrets(key: Buffer, providerId: string, secrets: Record<string, string>): string | null {
  const present = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''));
  if (!Object.keys(present).length) return null;
  return PREFIX + encrypt(JSON.stringify(present), key, `providers:${providerId}:secrets_enc`);
}

export function openSecrets(key: Buffer, providerId: string, sealed: string | null): Record<string, string> {
  if (!sealed) return {};
  if (!sealed.startsWith(PREFIX)) throw new Error(`Unknown secret key generation for provider ${providerId}`);
  return JSON.parse(decrypt(sealed.slice(PREFIX.length), key, `providers:${providerId}:secrets_enc`)) as Record<
    string,
    string
  >;
}
