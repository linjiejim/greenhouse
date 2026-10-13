/**
 * The only module that reads process.env. Everything else receives values from here,
 * so configuration is validated once at startup and tests can build their own.
 */

import { z } from 'zod';

const booleanFlag = z
  .enum(['1', '0', 'true', 'false', ''])
  .optional()
  .transform((value) => value === '1' || value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /** Public origin of this deployment, used in links we hand out. */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  /** 32 bytes as hex: signs access tokens and hashes refresh tokens. No fallback. */
  TOKEN_SIGNING_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_SIGNING_KEY must be 64 hex characters'),
  /** 32 bytes as hex: encrypts provider and connection secrets. */
  PROVIDER_TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'PROVIDER_TOKEN_ENCRYPTION_KEY must be 64 hex characters'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  MIGRATE_ON_START: booleanFlag,
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  TRUSTED_PROXY_IPS: z.string().default(''),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
});

export type AppConfig = Omit<
  z.infer<typeof schema>,
  'CORS_ALLOWED_ORIGINS' | 'TRUSTED_PROXY_IPS' | 'TOKEN_SIGNING_KEY' | 'PROVIDER_TOKEN_ENCRYPTION_KEY'
> & {
  corsAllowedOrigins: string[];
  trustedProxyIps: string[];
  tokenSigningKey: string;
  providerEncryptionKey: string;
  /** Raw env, handed only to the provider bootstrap (LLM_*, STT_*, … per docs/product/providers.md). */
  providerEnv: Record<string, string | undefined>;
};

const list = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const { CORS_ALLOWED_ORIGINS, TRUSTED_PROXY_IPS, TOKEN_SIGNING_KEY, PROVIDER_TOKEN_ENCRYPTION_KEY, ...rest } =
    parsed.data;
  return {
    ...rest,
    corsAllowedOrigins: list(CORS_ALLOWED_ORIGINS),
    trustedProxyIps: list(TRUSTED_PROXY_IPS),
    tokenSigningKey: TOKEN_SIGNING_KEY.toLowerCase(),
    providerEncryptionKey: PROVIDER_TOKEN_ENCRYPTION_KEY.toLowerCase(),
    providerEnv: { ...env },
  };
}
