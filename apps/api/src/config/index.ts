import deployment from '../../../../greenhouse.config.js';
import { parseGreenhouseConfig } from '@greenhouse/types/config-schema';
import { parseExtensionsEnv, type ExtensionsConfig } from '@greenhouse/types/config';
/**
 * The only module that reads process.env. Everything else receives values from here,
 * so configuration is validated once at startup and tests can build their own.
 */

import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const booleanFlag = z
  .enum(['1', '0', 'true', 'false', ''])
  .optional()
  .transform((value) => value === '1' || value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  GREENHOUSE_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
  AGENT_EVENT_MERGE_MS: z.coerce.number().int().min(0).max(120_000).default(120_000),
  AGENT_EVENT_WAKES_PER_DAY: z.coerce.number().int().min(1).max(1000).default(50),
  /** Public origin of this deployment, used in links we hand out. */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  /** 32 bytes as hex: signs access tokens and hashes refresh tokens. No fallback. */
  TOKEN_SIGNING_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_SIGNING_KEY must be 64 hex characters'),
  /** 32 bytes as hex: encrypts provider and connection secrets. */
  PROVIDER_TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'PROVIDER_TOKEN_ENCRYPTION_KEY must be 64 hex characters'),
  /** 32 bytes as hex: the password vault's own key. Without it the vault is off. */
  VAULT_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'VAULT_ENCRYPTION_KEY must be 64 hex characters')
    .optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  MIGRATE_ON_START: booleanFlag,
  PAUSE_BACKGROUND_RUNS: booleanFlag,
  DISABLE_COMPUTERS: booleanFlag,
  DISABLE_OUTBOUND_MAIL: booleanFlag,
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  TRUSTED_PROXY_IPS: z.string().default(''),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
});

export type AppConfig = Omit<
  z.infer<typeof schema>,
  | 'CORS_ALLOWED_ORIGINS'
  | 'TRUSTED_PROXY_IPS'
  | 'TOKEN_SIGNING_KEY'
  | 'PROVIDER_TOKEN_ENCRYPTION_KEY'
  | 'VAULT_ENCRYPTION_KEY'
> & {
  extensions: ExtensionsConfig['enabled'];
  corsAllowedOrigins: string[];
  trustedProxyIps: string[];
  tokenSigningKey: string;
  providerEncryptionKey: string;
  /** Null when the vault is off. */
  vaultEncryptionKey: string | null;
  /** Raw env, handed only to the provider bootstrap (LLM_*, STT_*, … per docs/product/providers.md). */
  providerEnv: Record<string, string | undefined>;
};

/**
 * The desktop app serves the web bundle from its own scheme, so every API call and socket it
 * makes is cross-origin. Only the shell can be these origins; a web page cannot.
 */
export const DESKTOP_ORIGINS = ['greenhouse://localhost', 'http://greenhouse.localhost'];

const list = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // `KEY=` in a .env file means unset, not an empty value.
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const {
    CORS_ALLOWED_ORIGINS,
    TRUSTED_PROXY_IPS,
    TOKEN_SIGNING_KEY,
    PROVIDER_TOKEN_ENCRYPTION_KEY,
    VAULT_ENCRYPTION_KEY,
    ...rest
  } = parsed.data;
  return {
    ...rest,
    extensions: parseExtensionsEnv(env.GREENHOUSE_EXTENSIONS) ?? parseGreenhouseConfig(deployment).extensions.enabled,
    corsAllowedOrigins: [...new Set([...DESKTOP_ORIGINS, ...list(CORS_ALLOWED_ORIGINS)])],
    trustedProxyIps: list(TRUSTED_PROXY_IPS),
    tokenSigningKey: TOKEN_SIGNING_KEY.toLowerCase(),
    providerEncryptionKey: PROVIDER_TOKEN_ENCRYPTION_KEY.toLowerCase(),
    vaultEncryptionKey: VAULT_ENCRYPTION_KEY?.toLowerCase() ?? null,
    providerEnv: present,
  };
}

/** The one-shot migrator needs only a database URL, never model or signing keys. */
export function loadDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return schema.shape.DATABASE_URL.parse(env.DATABASE_URL);
}

export function loadEnvironment(): void {
  loadDotenv({ path: process.env.GREENHOUSE_ENV_FILE ?? fileURLToPath(new URL('../../../../.env', import.meta.url)) });
}
