/**
 * Resolution and management of provider instances (docs/product/providers.md §4).
 *
 * A member gets, in order: their own instance (when the policy allows it), then the workspace
 * order, which is the saved binding, or else env instances followed by workspace instances, or
 * else the built-ins. State is read on every call, so a change applies at once. Secrets are
 * sealed in the database and opened only to build a client.
 */

import { eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  AdminProviders,
  CapabilityState,
  CatalogAdapter,
  MyProviders,
  ProviderInstance,
  bindingInputSchema,
  createProviderInputSchema,
  updateProviderInputSchema,
} from '@greenhouse/contract';
import {
  getDb,
  providerBindings,
  providers,
  transaction,
  type ProviderBindingRow,
  type ProviderCheck,
  type ProviderPolicy,
  type ProviderRow,
} from '@greenhouse/db';
import {
  CAPABILITIES,
  getAdapter,
  isDeepSeekFamily,
  listAdapters,
  pinnedFetch,
  withFallback,
  type AnyAdapter,
  type Capability,
  type ClientByCapability,
  type LanguageModelV4,
  type ModelInfo,
} from '@greenhouse/providers';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { audit, changedFields } from '../audit.js';
import type { AppConfig } from '../config/index.js';
import { ApiError, conflict, forbidden, invalidInput, notFound } from '../http/errors.js';
import { assertPublicEndpoint } from '../security/network.js';
import { publicFetch } from '../security/public-fetch.js';
import { providersFromEnv, type EnvInstance } from './env.js';
import { openSecrets, sealSecrets } from './secrets.js';
import { meter, type UsageContext } from './usage.js';

type CreateInput = z.output<typeof createProviderInputSchema>;
type UpdateInput = z.output<typeof updateProviderInputSchema>;
type BindingSave = z.output<typeof bindingInputSchema>;
type Scope = 'workspace' | 'personal';
type Source = ProviderInstance['source'];

/** Capabilities a member may bring their own key for; shared infrastructure never. */
export const PERSONAL_CAPABILITIES: readonly Capability[] = ['llm', 'stt', 'tts', 'image', 'video', 'search'];
export const LLM_ALIASES = ['default', 'strong', 'fast'] as const;
const DEFAULT_POLICY: Required<ProviderPolicy> = { allowPersonal: false, personalCountsTowardBudget: false };
const TEST_TIMEOUT_MS = 20_000;

const BUILTINS: EnvInstance[] = [
  {
    id: 'builtin-storage',
    capability: 'storage',
    kind: 'local',
    preset: null,
    name: '本地磁盘',
    config: { root: 'data/files' },
    secrets: {},
  },
];

interface Instance {
  id: string;
  capability: Capability;
  kind: string;
  preset: string | null;
  name: string;
  source: Source;
  ownerId: string | null;
  config: Record<string, unknown>;
  secretsSet: string[];
  secrets(): Record<string, string>;
  enabled: boolean;
  lastCheck: ProviderCheck | null;
}

interface View {
  capability: Capability;
  /** Env, workspace and built-in instances: everything an admin manages. */
  all: Instance[];
  personal: Instance[];
  /** The workspace order, before dropping instances that cannot serve. */
  order: Instance[];
  binding: ProviderBindingRow | null;
  policy: Required<ProviderPolicy>;
  defaults: Record<string, unknown>;
}

interface Target {
  instance: Instance;
  modelId: string;
}

export interface Resolved<C extends Capability> {
  client: ClientByCapability[C];
  instance: { id: string; kind: string; name: string; source: Source };
}

/** A language model plus what the agent loop needs to know about the first model it tries. */
export interface ResolvedModel {
  model: LanguageModelV4;
  /** `instance/model` of the first target. */
  ref: string;
  modelId: string;
  deepseek: boolean;
  reasoning?: boolean;
  vision?: boolean;
  contextWindow?: number;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

function splitRef(ref: string): { instanceId: string; modelId: string } | null {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { instanceId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** Error text from a vendor can echo a request; never let it carry a key back out. */
function redact(message: string, secrets: Record<string, string>): string {
  let text = message;
  for (const secret of Object.values(secrets)) if (secret.length >= 6) text = text.split(secret).join('***');
  return text.slice(0, 300);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000} seconds.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createProvidersService(deps: { config: AppConfig; fetch?: typeof fetch }) {
  const key = Buffer.from(deps.config.providerEncryptionKey, 'hex');
  const env = providersFromEnv(deps.config.providerEnv);
  const fixed = [...env.instances, ...BUILTINS];
  const fixedChecks = new Map<string, ProviderCheck>();
  // Admin and env instances may use any address (a local Ollama); a member's go only to public ones.
  const network = deps.fetch ?? fetch;
  const memberNetwork = deps.fetch ?? publicFetch;

  const fromFixed = (entry: EnvInstance, source: 'env' | 'builtin'): Instance => ({
    ...entry,
    source,
    ownerId: null,
    secretsSet: Object.keys(entry.secrets),
    secrets: () => entry.secrets,
    enabled: true,
    lastCheck: fixedChecks.get(entry.id) ?? null,
  });

  const openRow = (row: ProviderRow): Record<string, string> => {
    try {
      return openSecrets(key, row.id, row.secretsEnc);
    } catch (error) {
      logger.warn(`[providers] cannot open the secrets of ${row.id}; treating them as missing`, {
        error: toErrorMessage(error),
      });
      return {};
    }
  };

  const fromRow = (row: ProviderRow): Instance => {
    const secrets = openRow(row);
    return {
      id: row.id,
      capability: row.capability,
      kind: row.kind,
      preset: row.preset,
      name: row.name,
      source: row.scope,
      ownerId: row.ownerId,
      config: row.config,
      secretsSet: Object.keys(secrets),
      secrets: () => secrets,
      enabled: row.enabled,
      lastCheck: row.lastCheck,
    };
  };

  function view(capability: Capability, rows: ProviderRow[], bindings: ProviderBindingRow[]): View {
    const own = rows.filter((row) => row.capability === capability).map(fromRow);
    const fromEnv = env.instances.filter((entry) => entry.capability === capability).map((e) => fromFixed(e, 'env'));
    const builtins = BUILTINS.filter((entry) => entry.capability === capability).map((e) => fromFixed(e, 'builtin'));
    const workspace = own.filter((instance) => instance.source === 'workspace');
    const all = [...fromEnv, ...workspace, ...builtins];
    const binding = bindings.find((entry) => entry.capability === capability) ?? null;
    const configured = [...fromEnv, ...workspace];
    const order = binding
      ? binding.instanceIds.flatMap((id) => all.filter((instance) => instance.id === id))
      : configured.length
        ? configured
        : builtins;
    return {
      capability,
      all,
      personal: own.filter((instance) => instance.source === 'personal'),
      order,
      binding,
      policy: { ...DEFAULT_POLICY, ...env.policies[capability], ...binding?.policy },
      defaults: binding ? binding.defaults : (env.defaults[capability] ?? {}),
    };
  }

  async function load(capability?: Capability): Promise<View[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(providers)
      .where(capability ? eq(providers.capability, capability) : undefined)
      .orderBy(providers.createdAt, providers.id);
    const bindings = await db
      .select()
      .from(providerBindings)
      .where(capability ? eq(providerBindings.capability, capability) : undefined);
    return (capability ? [capability] : CAPABILITIES).map((entry) => view(entry, rows, bindings));
  }

  const viewOf = async (capability: Capability) => (await load(capability))[0]!;

  function adapterOf(instance: Pick<Instance, 'capability' | 'kind'>): AnyAdapter {
    const adapter = getAdapter(instance.capability, instance.kind);
    if (!adapter)
      throw new ApiError(503, 'provider_unavailable', `No adapter for ${instance.capability}:${instance.kind}.`);
    return adapter;
  }

  function usable(instance: Instance): boolean {
    const adapter = getAdapter(instance.capability, instance.kind);
    if (!adapter || !instance.enabled) return false;
    return (adapter.requiredSecrets ?? []).every((field) => instance.secretsSet.includes(field));
  }

  /** Who serves a member, in order. A personal instance serves only its owner, and only when allowed. */
  function chainFor(current: View, ctx: UsageContext): Instance[] {
    const mine =
      ctx.memberId && ctx.personal !== false && current.policy.allowPersonal
        ? current.personal.filter((instance) => instance.ownerId === ctx.memberId && usable(instance))
        : [];
    return [...mine, ...current.order.filter(usable)];
  }

  function rawClient(instance: Instance) {
    const adapter = adapterOf(instance);
    const config = adapter.configSchema.parse(instance.config);
    const inner = instance.source === 'personal' ? memberNetwork : network;
    const created = adapter.create({
      config,
      secrets: instance.secrets(),
      fetch: pinnedFetch(adapter.endpoints(config), inner),
    });
    return { adapter, config, created };
  }

  const client = <C extends Capability>(instance: Instance, ctx: UsageContext): ClientByCapability[C] =>
    meter<C>(instance, rawClient(instance).created as ClientByCapability[C], ctx);

  const publicView = (instance: Instance): ProviderInstance => ({
    id: instance.id,
    capability: instance.capability,
    kind: instance.kind,
    preset: instance.preset,
    name: instance.name,
    source: instance.source,
    config: instance.config,
    secrets_set: instance.secretsSet,
    enabled: instance.enabled,
    editable: instance.source === 'workspace' || instance.source === 'personal',
    last_check: instance.lastCheck
      ? {
          at: instance.lastCheck.at,
          ok: instance.lastCheck.ok,
          latency_ms: instance.lastCheck.latencyMs,
          error: instance.lastCheck.error,
        }
      : null,
  });

  const capabilityState = (current: View): CapabilityState => ({
    capability: current.capability,
    order: current.order.map((instance) => instance.id),
    effective: current.order.filter(usable).map((instance) => instance.id),
    bound: !!current.binding,
    defaults: current.defaults,
    policy: {
      allow_personal: current.policy.allowPersonal,
      personal_counts_toward_budget: current.policy.personalCountsTowardBudget,
    },
    instances: current.all.map(publicView),
  });

  function catalog(capabilities: readonly Capability[] = CAPABILITIES): CatalogAdapter[] {
    return listAdapters()
      .filter((adapter) => capabilities.includes(adapter.capability))
      .map((adapter) => ({
        capability: adapter.capability,
        kind: adapter.kind,
        label: adapter.label,
        config_schema: z.toJSONSchema(adapter.configSchema, { io: 'input', unrepresentable: 'any' }),
        secret_keys: [...adapter.secretKeys],
        required_secrets: [...(adapter.requiredSecrets ?? [])],
        presets: (adapter.presets ?? []).map((preset) => ({
          id: preset.id,
          label: preset.label,
          config: preset.config,
        })),
      }));
  }

  const modelInfo = (instance: Instance, modelId: string): ModelInfo | undefined =>
    ((instance.config.models as ModelInfo[] | undefined) ?? []).find((model) => model.id === modelId);

  const modelsOf = (instance: Instance): string[] => {
    const listed = ((instance.config.models as { id: string }[] | undefined) ?? []).map((model) => model.id);
    const preferred = instance.config.defaultModel as string | undefined;
    return [...new Set([...(preferred ? [preferred] : []), ...listed])];
  };

  function explicitTarget(ref: string, chain: Instance[]): Target | null {
    const parsed = splitRef(ref);
    const instance = parsed && chain.find((candidate) => candidate.id === parsed.instanceId);
    return instance && modelsOf(instance).includes(parsed.modelId) ? { instance, modelId: parsed.modelId } : null;
  }

  /**
   * An alias resolves to the member's own key first, then the workspace default for the alias
   * (strong and fast fall back to default), then each instance's preferred model. Every target
   * after the first is a fallback for retriable failures.
   */
  function aliasTargets(alias: string, chain: Instance[], defaults: Record<string, unknown>): Target[] {
    const targets: Target[] = [];
    const add = (target: Target | null) => {
      if (target && !targets.some((entry) => entry.instance.id === target.instance.id)) targets.push(target);
    };
    const own = chain[0]?.source === 'personal' ? chain[0] : null;
    if (own && modelsOf(own)[0]) add({ instance: own, modelId: modelsOf(own)[0]! });
    for (const name of [alias, 'default']) {
      const ref = defaults[name];
      if (typeof ref === 'string') add(explicitTarget(ref, chain));
    }
    for (const instance of chain) if (modelsOf(instance)[0]) add({ instance, modelId: modelsOf(instance)[0]! });
    return targets;
  }

  /** Vendor addresses from presets and adapter defaults: public https by construction. */
  function knownOrigins(adapter: AnyAdapter): Set<string> {
    const origins = new Set<string>();
    for (const config of [{}, ...(adapter.presets ?? []).map((preset) => preset.config)]) {
      try {
        for (const endpoint of adapter.endpoints(adapter.configSchema.parse(config)) ?? []) {
          const url = new URL(endpoint);
          if (url.protocol === 'https:') origins.add(url.origin);
        }
      } catch {
        // This preset needs more settings before it has an address.
      }
    }
    return origins;
  }

  /** Validates config and secret fields against the adapter; a member's endpoints must be public. */
  async function prepare(
    capability: Capability,
    kind: string,
    config: Record<string, unknown>,
    secrets: Record<string, string> | undefined,
    scope: Scope,
  ) {
    const adapter = getAdapter(capability, kind);
    if (!adapter) throw invalidInput(`There is no ${capability} adapter called "${kind}".`);
    const parsed = adapter.configSchema.safeParse(config);
    if (!parsed.success) {
      throw invalidInput(
        'The settings are invalid.',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    const unknownSecrets = Object.keys(secrets ?? {}).filter((field) => !adapter.secretKeys.includes(field));
    if (unknownSecrets.length) throw invalidInput(`Unknown secret fields: ${unknownSecrets.join(', ')}.`);
    let endpoints: string[] | null;
    try {
      endpoints = adapter.endpoints(parsed.data);
    } catch (error) {
      throw invalidInput(toErrorMessage(error));
    }
    if (scope === 'personal') {
      if (!endpoints?.length) throw invalidInput('This service cannot use a personal key.');
      const known = knownOrigins(adapter);
      for (const endpoint of endpoints) {
        if (known.has(new URL(endpoint).origin)) continue;
        try {
          await assertPublicEndpoint(endpoint);
        } catch (error) {
          throw invalidInput(toErrorMessage(error));
        }
      }
    }
    return { adapter, config: parsed.data as Record<string, unknown> };
  }

  async function uniqueId(...candidates: (string | null | undefined)[]): Promise<string> {
    const base = candidates.map((text) => slug(text ?? '')).find(Boolean) ?? 'provider';
    const rows = await getDb()
      .select({ id: providers.id })
      .from(providers)
      .where(like(providers.id, `${base}%`));
    const taken = new Set([...fixed.map((entry) => entry.id), ...rows.map((row) => row.id)]);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (!taken.has(id)) return id;
    }
  }

  async function ownRow(id: string, scope: Scope, memberId: string): Promise<ProviderRow> {
    const [row] = await getDb().select().from(providers).where(eq(providers.id, id)).for('update');
    if (row && row.scope === scope && (scope === 'workspace' || row.ownerId === memberId)) return row;
    if (scope === 'workspace' && fixed.some((entry) => entry.id === id)) {
      throw forbidden('Instances from env vars and built-ins are read-only.');
    }
    throw notFound('Provider');
  }

  async function assertPersonalAllowed(capability: Capability) {
    const current = await viewOf(capability);
    if (!PERSONAL_CAPABILITIES.includes(capability) || !current.policy.allowPersonal) {
      throw forbidden('Your admin has not allowed personal keys for this service.');
    }
  }

  async function saveBinding(
    capability: Capability,
    values: { instanceIds: string[]; defaults: Record<string, unknown>; policy: ProviderPolicy },
    actorId: string,
  ) {
    const row = { capability, ...values, updatedBy: actorId, updatedAt: new Date().toISOString() };
    await getDb()
      .insert(providerBindings)
      .values(row)
      .onConflictDoUpdate({
        target: providerBindings.capability,
        set: { ...row, version: sql`${providerBindings.version} + 1` },
      });
  }

  /** A deleted instance leaves the order and every default that pointed at it. */
  async function dropFromBinding(capability: Capability, id: string, actorId: string) {
    const current = await viewOf(capability);
    if (!current.binding) return;
    const defaults = Object.fromEntries(
      Object.entries(current.binding.defaults).filter(
        ([, ref]) => !(typeof ref === 'string' && ref.startsWith(`${id}/`)),
      ),
    );
    await saveBinding(
      capability,
      { instanceIds: current.binding.instanceIds.filter((entry) => entry !== id), defaults, policy: current.policy },
      actorId,
    );
  }

  async function runCheck(instance: Instance): Promise<ProviderInstance> {
    const started = Date.now();
    let check: ProviderCheck;
    try {
      if (!instance.enabled) throw new Error('This instance is turned off.');
      if (!usable(instance)) throw new Error('Fill in the required keys first.');
      // A test is not usage: the client is not metered.
      const { adapter, config, created } = rawClient(instance);
      await withTimeout(
        adapter.test ? adapter.test(created, config) : Promise.resolve(),
        adapter.testTimeoutMs ?? TEST_TIMEOUT_MS,
      );
      check = { at: new Date().toISOString(), ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      check = {
        at: new Date().toISOString(),
        ok: false,
        latencyMs: Date.now() - started,
        error: redact(toErrorMessage(error), instance.secrets()),
      };
    }
    if (instance.source === 'env' || instance.source === 'builtin') fixedChecks.set(instance.id, check);
    else await getDb().update(providers).set({ lastCheck: check }).where(eq(providers.id, instance.id));
    return publicView({ ...instance, lastCheck: check });
  }

  return {
    /** The first instance that can serve the member, with a client that records usage; null when none. */
    async resolve<C extends Capability>(capability: C, ctx: UsageContext): Promise<Resolved<C> | null> {
      const instance = chainFor(await viewOf(capability), ctx)[0];
      if (!instance) return null;
      return {
        client: client<C>(instance, ctx),
        instance: { id: instance.id, kind: instance.kind, name: instance.name, source: instance.source },
      };
    },

    /** Every instance that can serve the member, in fallback order, each with a metered client. */
    async chain<C extends Capability>(capability: C, ctx: UsageContext): Promise<Resolved<C>[]> {
      return chainFor(await viewOf(capability), ctx).map((instance) => ({
        client: client<C>(instance, ctx),
        instance: { id: instance.id, kind: instance.kind, name: instance.name, source: instance.source },
      }));
    },

    /** Whether a capability can serve at all, for hiding the tools and UI that need it. */
    async available(capability: Capability, ctx: UsageContext = {}): Promise<boolean> {
      return chainFor(await viewOf(capability), ctx).length > 0;
    },

    /** For /health: which capabilities the workspace can serve, without personal keys. */
    async status(): Promise<Record<Capability, boolean>> {
      const views = await load();
      return Object.fromEntries(views.map((entry) => [entry.capability, entry.order.some(usable)])) as Record<
        Capability,
        boolean
      >;
    },

    /**
     * A language model for `instance/model` or an alias (default, strong, fast). An explicit
     * reference must name a model the instance lists; an alias falls back across the chain.
     */
    async languageModel(ref: string, ctx: UsageContext): Promise<ResolvedModel> {
      const current = await viewOf('llm');
      const chain = chainFor(current, ctx);
      if (!chain.length) throw new ApiError(503, 'llm_not_configured', 'No model service is configured yet.');
      const model = (target: Target) => client<'llm'>(target.instance, ctx).languageModel(target.modelId);
      let targets: Target[];
      if ((LLM_ALIASES as readonly string[]).includes(ref)) {
        targets = aliasTargets(ref, chain, current.defaults);
        if (!targets.length) throw new ApiError(503, 'llm_not_configured', 'The model service has no model set.');
      } else {
        const target = explicitTarget(ref, chain);
        if (!target) throw new ApiError(400, 'model_unavailable', `The model "${ref}" is not available.`);
        targets = [target];
      }
      const first = targets[0]!;
      const info = modelInfo(first.instance, first.modelId);
      return {
        model: withFallback(targets.map(model)),
        ref: `${first.instance.id}/${first.modelId}`,
        modelId: first.modelId,
        deepseek: isDeepSeekFamily(first.modelId, first.instance.config.baseUrl as string | undefined),
        ...(info?.reasoning !== undefined ? { reasoning: info.reasoning } : {}),
        ...(info?.vision !== undefined ? { vision: info.vision } : {}),
        ...(info?.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
      };
    },

    /**
     * Whether a model reference may be saved on an Agent or a conversation. Aliases always may:
     * they resolve when a turn runs. `instance/model` must name a model the member can reach.
     */
    async modelAvailable(ref: string, ctx: UsageContext): Promise<boolean> {
      if ((LLM_ALIASES as readonly string[]).includes(ref)) return true;
      return !!explicitTarget(ref, chainFor(await viewOf('llm'), ctx));
    },

    async adminView(): Promise<AdminProviders> {
      return { capabilities: (await load()).map(capabilityState), catalog: catalog() };
    },

    async myView(memberId: string): Promise<MyProviders> {
      const isAllowed = (entry: View) => entry.policy.allowPersonal && PERSONAL_CAPABILITIES.includes(entry.capability);
      const views = (await load()).filter(
        (entry) => isAllowed(entry) || entry.personal.some((instance) => instance.ownerId === memberId),
      );
      return {
        capabilities: views.map((entry) => {
          const mine = entry.personal.filter((instance) => instance.ownerId === memberId);
          const allowed = isAllowed(entry);
          const active = allowed && mine.some(usable) ? 'personal' : entry.order.some(usable) ? 'workspace' : 'none';
          return { capability: entry.capability, allowed, active, instances: mine.map(publicView) };
        }),
        catalog: catalog(views.filter(isAllowed).map((entry) => entry.capability)),
      };
    },

    async create(actorId: string, scope: Scope, input: CreateInput): Promise<ProviderInstance> {
      if (scope === 'personal') await assertPersonalAllowed(input.capability);
      const { adapter, config } = await prepare(input.capability, input.kind, input.config, input.secrets, scope);
      if (input.preset && !adapter.presets?.some((preset) => preset.id === input.preset)) {
        throw invalidInput(`${adapter.label} has no preset called "${input.preset}".`);
      }
      try {
        return await transaction(async (db) => {
          const id = await uniqueId(input.name, input.preset, input.kind);
          const [row] = await db
            .insert(providers)
            .values({
              id,
              capability: input.capability,
              kind: input.kind,
              preset: input.preset ?? null,
              name: input.name,
              scope,
              ownerId: scope === 'personal' ? actorId : null,
              config,
              secretsEnc: sealSecrets(key, id, input.secrets),
              createdBy: actorId,
            })
            .returning();
          if (scope === 'workspace') {
            // A saved order would otherwise leave the new instance unused.
            const current = await viewOf(input.capability);
            if (current.binding) {
              await saveBinding(
                input.capability,
                {
                  instanceIds: [...current.binding.instanceIds, id],
                  defaults: current.defaults,
                  policy: current.policy,
                },
                actorId,
              );
            }
          }
          await audit({
            actorId,
            action: 'provider.create',
            resourceType: 'provider',
            resourceId: id,
            summary: `${scope} ${input.capability}:${input.kind}`,
          });
          return publicView(fromRow(row!));
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('provider_id_taken', 'Try again or choose a different name.');
        throw error;
      }
    },

    async update(actorId: string, scope: Scope, id: string, input: UpdateInput): Promise<ProviderInstance> {
      return transaction(async (db) => {
        const row = await ownRow(id, scope, actorId);
        const { adapter, config } = await prepare(
          row.capability,
          row.kind,
          input.config ?? row.config,
          input.secrets,
          scope,
        );
        const endpointsOf = (settings: Record<string, unknown>) => {
          try {
            return JSON.stringify(adapter.endpoints(adapter.configSchema.parse(settings)));
          } catch {
            return null;
          }
        };
        // A key belongs to its endpoint: moving the endpoint drops the stored secrets.
        const moved = input.config !== undefined && endpointsOf(config) !== endpointsOf(row.config);
        const secrets = { ...(moved ? {} : openRow(row)), ...input.secrets };
        const [updated] = await db
          .update(providers)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            config,
            secretsEnc: sealSecrets(key, row.id, secrets),
            ...(input.config !== undefined || input.secrets !== undefined ? { lastCheck: null } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(providers.id, id))
          .returning();
        const toggled = input.enabled !== undefined && input.enabled !== row.enabled;
        await audit({
          actorId,
          action: toggled ? (input.enabled ? 'provider.enable' : 'provider.disable') : 'provider.update',
          resourceType: 'provider',
          resourceId: id,
          summary: changedFields(input) + (moved ? '; endpoint moved, secrets cleared' : ''),
        });
        return publicView(fromRow(updated!));
      });
    },

    async remove(actorId: string, scope: Scope, id: string): Promise<void> {
      await transaction(async (db) => {
        const row = await ownRow(id, scope, actorId);
        await db.delete(providers).where(eq(providers.id, id));
        if (scope === 'workspace') await dropFromBinding(row.capability, id, actorId);
        await audit({ actorId, action: 'provider.delete', resourceType: 'provider', resourceId: id, summary: scope });
      });
    },

    async test(actorId: string, scope: Scope, id: string): Promise<ProviderInstance> {
      const entry = scope === 'workspace' ? fixed.find((candidate) => candidate.id === id) : undefined;
      const instance = entry
        ? fromFixed(entry, BUILTINS.includes(entry) ? 'builtin' : 'env')
        : fromRow(await ownRow(id, scope, actorId));
      return runCheck(instance);
    },

    /** 复制为可编辑: an env instance becomes a workspace instance that takes its place in the order. */
    async copy(actorId: string, id: string): Promise<ProviderInstance> {
      const entry = env.instances.find((candidate) => candidate.id === id);
      if (!entry) throw notFound('Env instance');
      return transaction(async (db) => {
        const before = await viewOf(entry.capability);
        const copyId = await uniqueId(entry.name, entry.preset, entry.kind);
        const [row] = await db
          .insert(providers)
          .values({
            id: copyId,
            capability: entry.capability,
            kind: entry.kind,
            preset: entry.preset,
            name: entry.name,
            config: entry.config,
            secretsEnc: sealSecrets(key, copyId, entry.secrets),
            createdBy: actorId,
          })
          .returning();
        const order = before.order.map((instance) => instance.id);
        const instanceIds = order.includes(id)
          ? order.map((other) => (other === id ? copyId : other))
          : [...order, copyId];
        const defaults = Object.fromEntries(
          Object.entries(before.defaults).map(([name, ref]) => [
            name,
            typeof ref === 'string' && ref.startsWith(`${id}/`) ? `${copyId}/${ref.slice(id.length + 1)}` : ref,
          ]),
        );
        await saveBinding(entry.capability, { instanceIds, defaults, policy: before.policy }, actorId);
        await audit({
          actorId,
          action: 'provider.copy',
          resourceType: 'provider',
          resourceId: copyId,
          summary: `from ${id}`,
        });
        return publicView(fromRow(row!));
      });
    },

    /** Order, defaults and policy for one capability. */
    async setBinding(actorId: string, capability: Capability, input: BindingSave): Promise<CapabilityState> {
      return transaction(async () => {
        const current = await viewOf(capability);
        const known = new Map(current.all.map((instance) => [instance.id, instance]));
        const instanceIds = [...new Set(input.instance_ids)];
        const unknown = instanceIds.filter((id) => !known.has(id));
        if (unknown.length) throw invalidInput(`Unknown instances: ${unknown.join(', ')}.`);
        if (input.policy.allow_personal && !PERSONAL_CAPABILITIES.includes(capability)) {
          throw invalidInput(`Personal keys are not available for ${capability}.`);
        }
        if (capability === 'llm') {
          const chain = instanceIds.map((id) => known.get(id)!);
          for (const [name, ref] of Object.entries(input.defaults)) {
            if (!(LLM_ALIASES as readonly string[]).includes(name))
              throw invalidInput(`Unknown model alias "${name}".`);
            if (typeof ref !== 'string' || !explicitTarget(ref, chain)) {
              throw invalidInput(`${name} must name a model of an instance in the order, as instance/model.`);
            }
          }
        }
        const policy: ProviderPolicy = {
          allowPersonal: input.policy.allow_personal ?? current.policy.allowPersonal,
          personalCountsTowardBudget:
            input.policy.personal_counts_toward_budget ?? current.policy.personalCountsTowardBudget,
        };
        await saveBinding(capability, { instanceIds, defaults: input.defaults, policy }, actorId);
        await audit({
          actorId,
          action: 'provider.binding',
          resourceType: 'provider_binding',
          resourceId: capability,
          summary: instanceIds.join(' > ') || 'off',
        });
        return capabilityState(await viewOf(capability));
      });
    },
  };
}

export type ProvidersService = ReturnType<typeof createProvidersService>;
