/**
 * Service price list loader — reads `config/services.yaml`.
 *
 * Prices every paid call that is not a chat model (models are priced in
 * models.yaml): web search, page reads, image generation, image understanding,
 * with active plugin services added by their registry. Fail-fast like the model catalog: a
 * malformed file stops the boot, because a typo would otherwise silently turn
 * a paid provider into an unpriced one.
 *
 * Unpriced is a legal state (a provider with no price): its calls are recorded
 * with an unknown cost, counted as zero against budgets and flagged 未定价 in
 * Administration › Services & pricing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { TokenPrice } from '@greenhouse/agent-core';
import { SERVICE_UNIT_KINDS, type MeteredService, type ServiceUnitKind } from '@greenhouse/types/metering';
import { billableServices } from './service-registry.js';
import { parseTokenPrice } from './models.js';
const CONFIG_PATH = resolve(import.meta.dirname, 'services.yaml');
/** Services priced in this file (`llm` is priced per model in models.yaml). */
export type PricedService = Exclude<MeteredService, 'llm'>;
/**
 * The providers each service calls, by the name the code uses. Closed so a
 * misspelt provider fails the boot instead of quietly going unpriced.
 */
export const SERVICE_PROVIDERS: Partial<Record<PricedService, readonly string[]>> = {
  web_search: ['tavily', 'firecrawl', 'brave'],
  page_read: ['jina', 'local'],
  image_generation: ['media'],
  vision: ['media'],
};
export interface ServiceProviderPrice {
  provider: string;
  /** Env vars whose presence means "configured"; empty = needs no key. */
  apiKeyEnv: string[];
  /** USD per unit (call / image / minute). */
  price?: number;
  /** Image only: USD per image, by quality → size. */
  priceBySize?: Record<string, Record<string, number>>;
  /** USD per 1M tokens. */
  tokenPrice?: TokenPrice;
}
export interface ServiceDefinition {
  service: PricedService;
  name: string;
  unit: ServiceUnitKind;
  enabled: boolean;
  providers: Record<string, ServiceProviderPrice>;
}
export type ServiceCatalog = Partial<Record<PricedService, ServiceDefinition>>;
const SERVICE_KEYS = new Set(['name', 'unit', 'enabled', 'providers']);
const PROVIDER_KEYS = new Set(['api_key_env', 'price', 'price_by_size', 'token_price']);
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function usd(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where} must be a non-negative number (USD)`);
  }
  return value;
}
function parseProvider(service: PricedService, unit: ServiceUnitKind, id: string, raw: unknown): ServiceProviderPrice {
  const where = `services.yaml: services.${service}.providers.${id}`;
  if (!(SERVICE_PROVIDERS[service] ?? []).includes(id)) {
    throw new Error(`${where}: unknown provider (expected one of ${(SERVICE_PROVIDERS[service] ?? []).join(', ')})`);
  }
  const entry = raw === null || raw === undefined ? {} : raw;
  if (!isRecord(entry)) throw new Error(`${where} must be a mapping`);
  for (const key of Object.keys(entry)) {
    if (!PROVIDER_KEYS.has(key)) throw new Error(`${where}.${key} is not a provider field`);
  }
  const envRaw = entry.api_key_env;
  const apiKeyEnv =
    envRaw === undefined ? [] : typeof envRaw === 'string' ? [envRaw] : Array.isArray(envRaw) ? envRaw : null;
  if (!apiKeyEnv || apiKeyEnv.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error(`${where}.api_key_env must name an env var (or a list of them)`);
  }
  const price = entry.price === undefined ? undefined : usd(entry.price, `${where}.price`);
  if (price !== undefined && unit === 'token') {
    throw new Error(`${where}.price: a per-token service is priced with token_price`);
  }
  let priceBySize: Record<string, Record<string, number>> | undefined;
  if (entry.price_by_size !== undefined) {
    if (unit !== 'image') throw new Error(`${where}.price_by_size only applies to image services`);
    if (!isRecord(entry.price_by_size)) throw new Error(`${where}.price_by_size must map quality → size → USD`);
    priceBySize = {};
    for (const [quality, sizes] of Object.entries(entry.price_by_size)) {
      if (!isRecord(sizes)) throw new Error(`${where}.price_by_size.${quality} must map size → USD`);
      priceBySize[quality] = {};
      for (const [size, value] of Object.entries(sizes)) {
        if (!/^\d+x\d+$/.test(size)) throw new Error(`${where}.price_by_size.${quality}.${size} is not a WxH size`);
        priceBySize[quality]![size] = usd(value, `${where}.price_by_size.${quality}.${size}`);
      }
    }
  }
  const tokenPrice =
    entry.token_price === undefined ? undefined : parseTokenPrice(entry.token_price, `${where}.token_price`);
  if (tokenPrice && unit !== 'token' && unit !== 'image') {
    throw new Error(`${where}.token_price only applies to token or image services`);
  }
  return {
    provider: id,
    apiKeyEnv: apiKeyEnv.map((name) => (name as string).trim()),
    ...(price !== undefined ? { price } : {}),
    ...(priceBySize ? { priceBySize } : {}),
    ...(tokenPrice ? { tokenPrice } : {}),
  };
}
export function parseServiceCatalog(source: string): ServiceCatalog {
  const doc = parseYaml(source) as Record<string, unknown> | null;
  const rawServices = doc?.services;
  if (rawServices === undefined || rawServices === null) return {};
  if (!isRecord(rawServices)) throw new Error('services.yaml: `services` must be a mapping');
  const catalog: ServiceCatalog = {};
  for (const [id, raw] of Object.entries(rawServices)) {
    if (!(id in SERVICE_PROVIDERS)) {
      throw new Error(
        `services.yaml: unknown service "${id}" (models are priced in models.yaml; expected one of ${Object.keys(SERVICE_PROVIDERS).join(', ')})`,
      );
    }
    const service = id as PricedService;
    if (!isRecord(raw)) throw new Error(`services.yaml: services.${id} must be a mapping`);
    for (const key of Object.keys(raw)) {
      if (!SERVICE_KEYS.has(key)) throw new Error(`services.yaml: services.${id}.${key} is not a service field`);
    }
    const unit = raw.unit;
    if (typeof unit !== 'string' || !(SERVICE_UNIT_KINDS as readonly string[]).includes(unit)) {
      throw new Error(`services.yaml: services.${id}.unit must be one of ${SERVICE_UNIT_KINDS.join(', ')}`);
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      throw new Error(`services.yaml: services.${id}.enabled must be a boolean`);
    }
    const providersRaw = raw.providers ?? {};
    if (!isRecord(providersRaw)) throw new Error(`services.yaml: services.${id}.providers must be a mapping`);
    const providers: Record<string, ServiceProviderPrice> = {};
    for (const [providerId, providerRaw] of Object.entries(providersRaw)) {
      providers[providerId] = parseProvider(service, unit as ServiceUnitKind, providerId, providerRaw);
    }
    catalog[service] = {
      service,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
      unit: unit as ServiceUnitKind,
      enabled: raw.enabled !== false,
      providers,
    };
  }
  return catalog;
}
let catalog: ServiceCatalog | null = null;
/** Load the price list. Idempotent; call once from main(). */
export function initServiceCatalog(): ServiceCatalog {
  if (catalog) return catalog;
  if (!existsSync(CONFIG_PATH)) throw new Error(`service price list not found at ${CONFIG_PATH}`);
  catalog = parseServiceCatalog(readFileSync(CONFIG_PATH, 'utf-8'));
  return catalog;
}
export function getServiceCatalog(): ServiceCatalog {
  return {
    ...(catalog ?? initServiceCatalog()),
    ...Object.fromEntries(billableServices().map((entry) => [entry.service, entry])),
  };
}
/** Test seam: install a parsed catalog (pass null to reload from disk next time). */
export function setServiceCatalogForTests(next: ServiceCatalog | null): void {
  catalog = next;
}
/** The price entry for one provider of one service, if the file declares it. */
export function getServiceProviderPrice(service: PricedService, provider: string): ServiceProviderPrice | undefined {
  return getServiceCatalog()[service]?.providers[provider];
}
/** A provider is configured when any of its key env vars is set, or it needs none. */
export function isServiceProviderConfigured(entry: Pick<ServiceProviderPrice, 'apiKeyEnv'>): boolean {
  return entry.apiKeyEnv.length === 0 || entry.apiKeyEnv.some((name) => Boolean(process.env[name]?.trim()));
}
