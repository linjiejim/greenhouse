/**
 * Connector and connection secrets are write-only: sealed with AES-256-GCM under
 * PROVIDER_TOKEN_ENCRYPTION_KEY, bound to their table, row and column, and opened only inside
 * the server to make a call. The `k1:` prefix names the key generation, as for providers.
 */

import { decrypt, encrypt } from '@greenhouse/utils/crypto';

const PREFIX = 'k1:';

/** Where a sealed value lives: a copy pasted into another row or column does not open. */
export const placeOf = {
  sharedKey: (connectorId: string) => `connectors:${connectorId}:auth_enc`,
  oauthClient: (connectorId: string) => `connectors:${connectorId}:oauth_client_enc`,
  connection: (connectionId: string) => `connections:${connectionId}:secrets_enc`,
  /** The OAuth `state` a member's browser carries to the provider and back. */
  signInState: 'connectors:oauth_state',
};

export function seal(key: Buffer, place: string, value: unknown): string {
  return PREFIX + encrypt(JSON.stringify(value), key, place);
}

/** The value, or null when it is missing, sealed for another place, or under another key. */
export function unseal<T>(key: Buffer, place: string, sealed: string | null | undefined): T | null {
  if (!sealed?.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(decrypt(sealed.slice(PREFIX.length), key, place)) as T;
  } catch {
    return null;
  }
}

/**
 * Takes every known secret out of a message: a transport error can echo a header, or a URL with
 * the key encoded in its query.
 */
export function redact(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    const forms = new Set([secret, encodeURIComponent(secret), new URLSearchParams({ k: secret }).toString().slice(2)]);
    for (const form of [...forms].sort((a, b) => b.length - a.length)) text = text.split(form).join('***');
  }
  return text;
}
