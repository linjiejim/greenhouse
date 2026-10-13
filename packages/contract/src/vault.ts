import { z } from 'zod';
import { isoTime } from './common.js';

export const VAULT_POLICIES = ['ask', 'auto'] as const;
export type VaultPolicy = (typeof VAULT_POLICIES)[number];

export const VAULT_LABEL_MAX = 60;
export const VAULT_SITES_MAX = 20;
export const VAULT_AGENTS_MAX = 50;

/**
 * A login in my vault, as every read returns it. Values are write-only: no response ever holds
 * the user name, the password or the authenticator secret, only that they are set and a masked
 * user name.
 */
export const vaultItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Exact origins (`https://github.com`) or `*.example.com` for its subdomains. */
  origins: z.array(z.string()),
  /** `ji***@example.com`. */
  username_hint: z.string(),
  has_username: z.boolean(),
  has_password: z.boolean(),
  has_totp: z.boolean(),
  /** ask: the Agent raises a sign-in card first; auto: it fills without asking. */
  policy: z.enum(VAULT_POLICIES),
  /** Sites where an `ask` login is filled without a card. */
  always_origins: z.array(z.string()),
  /** My Agents that may use it; empty means all of them. */
  agent_ids: z.array(z.string()),
  last_used_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type VaultItem = z.infer<typeof vaultItemSchema>;

const site = z.string().trim().min(1).max(300);

/**
 * A new login. A site is an origin (`https://github.com`, a bare host means https) or
 * `*.example.com`; paths and other schemes are refused. At least one value is required.
 */
export const createVaultItemInputSchema = z.object({
  label: z.string().trim().min(1).max(VAULT_LABEL_MAX),
  origins: z.array(site).min(1).max(VAULT_SITES_MAX),
  username: z.string().max(320).default(''),
  password: z.string().max(1024).default(''),
  /** A base32 secret or an `otpauth://totp/…` link from the site's authenticator set-up. */
  totp: z.string().max(1024).default(''),
  policy: z.enum(VAULT_POLICIES).default('ask'),
  always_origins: z.array(site).max(VAULT_SITES_MAX).default([]),
  agent_ids: z.array(z.string().min(1).max(64)).max(VAULT_AGENTS_MAX).default([]),
});
export type CreateVaultItemInput = z.input<typeof createVaultItemInputSchema>;

/** A change: a value left out stays as it is, an empty one is removed. */
export const updateVaultItemInputSchema = z
  .object({
    label: z.string().trim().min(1).max(VAULT_LABEL_MAX),
    origins: z.array(site).min(1).max(VAULT_SITES_MAX),
    username: z.string().max(320),
    password: z.string().max(1024),
    totp: z.string().max(1024),
    policy: z.enum(VAULT_POLICIES),
    always_origins: z.array(site).max(VAULT_SITES_MAX),
    agent_ids: z.array(z.string().min(1).max(64)).max(VAULT_AGENTS_MAX),
  })
  .partial();
export type UpdateVaultItemInput = z.infer<typeof updateVaultItemInputSchema>;

export const VAULT_OUTCOMES = ['requested', 'filled', 'declined', 'origin_mismatch', 'no_fields', 'failed'] as const;
export const VAULT_APPROVALS = ['auto', 'always', 'member'] as const;

/**
 * One use of my vault by one of my Agents: which login, on which site, and what came of it.
 * `requested` is a sign-in card raised; `declined` the card refused. Never a value.
 */
export const vaultAccessSchema = z.object({
  id: z.string(),
  item_id: z.string().nullable(),
  item_label: z.string(),
  agent_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  origin: z.string(),
  action: z.enum(['fill']),
  outcome: z.enum(VAULT_OUTCOMES),
  /** Why it went ahead: the login fills itself, the site is always allowed, or I approved the card. */
  approval: z.enum(VAULT_APPROVALS).nullable(),
  created_at: isoTime,
});
export type VaultAccess = z.infer<typeof vaultAccessSchema>;
