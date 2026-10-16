import { describe, expect, it } from 'vitest';
import { loadConfig } from '../index.js';

const REQUIRED = {
  DATABASE_URL: 'postgresql://localhost/greenhouse',
  TOKEN_SIGNING_KEY: 'A'.repeat(64),
  PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
};

describe('loadConfig', () => {
  it('defaults to all and memory, and validates release configuration', () => {
    expect(loadConfig(REQUIRED)).toMatchObject({ GREENHOUSE_ROLE: 'all', RATE_LIMIT_STORE: 'memory' });
    expect(loadConfig({ ...REQUIRED, GREENHOUSE_ROLE: 'worker', RATE_LIMIT_STORE: 'postgres' })).toMatchObject({
      GREENHOUSE_ROLE: 'worker',
      RATE_LIMIT_STORE: 'postgres',
    });
    expect(() => loadConfig({ ...REQUIRED, GREENHOUSE_ROLE: 'other' })).toThrow(/GREENHOUSE_ROLE/);
    expect(() => loadConfig({ ...REQUIRED, RATE_LIMIT_STORE: 'redis' })).toThrow(/RATE_LIMIT_STORE/);
  });

  it('treats empty variables from a .env file as unset', () => {
    const config = loadConfig({ ...REQUIRED, BOOTSTRAP_ADMIN_EMAIL: '', PUBLIC_URL: ' ', LLM_PROVIDER: '' });
    expect(config.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(config.PUBLIC_URL).toBe('http://localhost:3000');
    expect(config.providerEnv.LLM_PROVIDER).toBeUndefined();
    expect(config.tokenSigningKey).toBe('a'.repeat(64));
  });

  it('refuses to start without its keys', () => {
    expect(() => loadConfig({ DATABASE_URL: REQUIRED.DATABASE_URL, TOKEN_SIGNING_KEY: 'short' })).toThrow(
      /TOKEN_SIGNING_KEY.*PROVIDER_TOKEN_ENCRYPTION_KEY|PROVIDER_TOKEN_ENCRYPTION_KEY/,
    );
  });

  it('keeps the vault off without its own key, and refuses a malformed one', () => {
    expect(loadConfig(REQUIRED).vaultEncryptionKey).toBeNull();
    expect(loadConfig({ ...REQUIRED, VAULT_ENCRYPTION_KEY: 'C'.repeat(64) }).vaultEncryptionKey).toBe('c'.repeat(64));
    expect(() => loadConfig({ ...REQUIRED, VAULT_ENCRYPTION_KEY: 'not-hex' })).toThrow(/VAULT_ENCRYPTION_KEY/);
  });
});
