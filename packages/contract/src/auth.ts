import { z } from 'zod';

export const CLIENT_KINDS = ['web', 'ios', 'android', 'extension', 'desktop', 'cli'] as const;
export const PASSWORD_MIN_LENGTH = 8;

export const loginInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(256),
  client: z.enum(CLIENT_KINDS).default('web'),
});
export type LoginInput = z.input<typeof loginInputSchema>;

export const tokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  /** Seconds until the access token expires. */
  expires_in: z.number().int(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const refreshInputSchema = z.object({ refresh_token: z.string().min(16).max(256) });
export type RefreshInput = z.infer<typeof refreshInputSchema>;

/** Activation and password reset both finish with a one-time link token and a new password. */
export const completeLinkInputSchema = z.object({
  token: z.string().min(16).max(256),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
  name: z.string().trim().min(1).max(80).optional(),
});
export type CompleteLinkInput = z.infer<typeof completeLinkInputSchema>;

export const linkInfoSchema = z.object({
  purpose: z.enum(['activate', 'reset']),
  email: z.string(),
  name: z.string(),
});
export type LinkInfo = z.infer<typeof linkInfoSchema>;
