import { z } from 'zod';
import { isoTime } from './common.js';

export const PROVIDER_CAPABILITIES = [
  'llm',
  'stt',
  'tts',
  'image',
  'video',
  'sandbox',
  'search',
  'storage',
  'mail',
  'im',
  'push',
] as const;
export const capabilitySchema = z.enum(PROVIDER_CAPABILITIES);
export type ProviderCapability = z.infer<typeof capabilitySchema>;

export const providerCheckSchema = z.object({
  at: isoTime,
  ok: z.boolean(),
  latency_ms: z.number().int().optional(),
  error: z.string().optional(),
});

export const providerInstanceSchema = z.object({
  id: z.string(),
  capability: capabilitySchema,
  kind: z.string(),
  preset: z.string().nullable(),
  name: z.string(),
  source: z.enum(['env', 'workspace', 'personal', 'builtin']),
  config: z.record(z.string(), z.unknown()),
  /** Which secret fields hold a value. The values themselves are never returned. */
  secrets_set: z.array(z.string()),
  enabled: z.boolean(),
  /** Env and built-in instances are read-only. */
  editable: z.boolean(),
  last_check: providerCheckSchema.nullable(),
});
export type ProviderInstance = z.infer<typeof providerInstanceSchema>;

export const providerPolicySchema = z.object({
  allow_personal: z.boolean(),
  personal_counts_toward_budget: z.boolean(),
});

export const capabilityStateSchema = z.object({
  capability: capabilitySchema,
  /** The fallback order an admin arranges: the saved binding, else env then workspace instances. */
  order: z.array(z.string()),
  /** The instances that would serve now, in order: enabled and with their keys filled in. */
  effective: z.array(z.string()),
  /** Whether an admin has saved a binding. */
  bound: z.boolean(),
  defaults: z.record(z.string(), z.unknown()),
  policy: providerPolicySchema,
  instances: z.array(providerInstanceSchema),
});
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const createProviderInputSchema = z.object({
  capability: capabilitySchema,
  kind: z.string().min(1).max(40),
  preset: z.string().max(40).optional(),
  name: z.string().trim().min(1).max(60),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.string().max(4000)).default({}),
});
export type CreateProviderInput = z.input<typeof createProviderInputSchema>;

export const updateProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    config: z.record(z.string(), z.unknown()),
    /** Only the fields given are replaced; an empty string clears one. */
    secrets: z.record(z.string(), z.string().max(4000)),
    enabled: z.boolean(),
  })
  .partial();
export type UpdateProviderInput = z.infer<typeof updateProviderInputSchema>;

export const bindingInputSchema = z.object({
  /** The fallback order. An empty list turns the capability off, env instances included. */
  instance_ids: z.array(z.string()).max(20),
  /** For llm: `default`, `strong` and `fast`, each `instance/model`. */
  defaults: z.record(z.string(), z.unknown()).default({}),
  policy: providerPolicySchema.partial().default({}),
});
export type BindingInput = z.input<typeof bindingInputSchema>;

export const catalogAdapterSchema = z.object({
  capability: capabilitySchema,
  kind: z.string(),
  label: z.string(),
  config_schema: z.unknown(),
  secret_keys: z.array(z.string()),
  required_secrets: z.array(z.string()),
  presets: z.array(z.object({ id: z.string(), label: z.string(), config: z.record(z.string(), z.unknown()) })),
});
export type CatalogAdapter = z.infer<typeof catalogAdapterSchema>;

/** 管理 → 服务. */
export const adminProvidersSchema = z.object({
  capabilities: z.array(capabilityStateSchema),
  catalog: z.array(catalogAdapterSchema),
});
export type AdminProviders = z.infer<typeof adminProvidersSchema>;

export const myCapabilitySchema = z.object({
  capability: capabilitySchema,
  /** False once an admin stops allowing personal keys; my instances stay listed so I can delete them. */
  allowed: z.boolean(),
  /** What serves me now: my own key, the workspace's, or nothing. */
  active: z.enum(['personal', 'workspace', 'none']),
  instances: z.array(providerInstanceSchema),
});
export type MyCapability = z.infer<typeof myCapabilitySchema>;

/** 设置 → 我的服务: capabilities that allow personal keys, and any where I still have one. */
export const myProvidersSchema = z.object({
  capabilities: z.array(myCapabilitySchema),
  catalog: z.array(catalogAdapterSchema),
});
export type MyProviders = z.infer<typeof myProvidersSchema>;
