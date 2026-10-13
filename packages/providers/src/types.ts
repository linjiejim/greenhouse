/**
 * The Provider contract (docs/product/providers.md §5). An adapter knows one protocol or
 * vendor API; an instance is an adapter plus config plus secrets; the API resolves which
 * instance serves a capability for a member.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { z } from 'zod';

export const CAPABILITIES = [
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
export type Capability = (typeof CAPABILITIES)[number];

export interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

export interface LlmClient {
  /** A model that only talks to this instance's endpoint. */
  languageModel(modelId: string): LanguageModelV4;
  /** Models this instance offers (from its config or preset). */
  models(): ModelInfo[];
}

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  size?: number;
  contentType?: string;
}

export interface StorageClient {
  put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void>;
  /** null when the object does not exist. */
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number; contentType?: string } | null>;
  /** Idempotent: a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** A time-limited GET URL, when the backend supports it. */
  presignGet?(key: string, options: { expiresInSeconds: number; filename?: string }): string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface PageContent {
  url: string;
  title: string;
  /** Readable text or Markdown. */
  content: string;
}

export interface SearchClient {
  search(query: string, options?: { limit?: number }): Promise<SearchResult[]>;
  /** Read one page, when the provider offers a reader. */
  read?(url: string): Promise<PageContent>;
}

export interface SttClient {
  transcribe(input: { audio: Uint8Array; mimeType: string; language?: string; prompt?: string }): Promise<{
    text: string;
    durationSeconds?: number;
  }>;
}

export interface TtsClient {
  synthesize(input: { text: string; voice?: string; format?: 'mp3' | 'wav' | 'opus'; speed?: number }): Promise<{
    audio: Uint8Array;
    mimeType: string;
  }>;
}

export interface GeneratedImage {
  data: Uint8Array;
  mimeType: string;
}

export interface ImageClient {
  generate(input: { prompt: string; size?: string; n?: number }): Promise<{ images: GeneratedImage[] }>;
}

export interface ClientByCapability {
  llm: LlmClient;
  stt: SttClient;
  tts: TtsClient;
  image: ImageClient;
  search: SearchClient;
  storage: StorageClient;
  video: never;
  sandbox: never;
  mail: never;
  im: never;
  push: never;
}

export interface ProviderPreset {
  id: string;
  label: string;
  /** Pre-filled, non-secret config (base URL, models, defaults). */
  config: Record<string, unknown>;
  docsUrl?: string;
}

export interface CreateInput<Config> {
  config: Config;
  secrets: Record<string, string>;
  /** fetch pinned to the instance endpoint; adapters must use it for every request. */
  fetch: typeof fetch;
}

export interface ProviderAdapter<C extends Capability = Capability, Config = Record<string, unknown>> {
  capability: C;
  kind: string;
  label: string;
  configSchema: z.ZodType<Config>;
  /** Secret fields; the UI writes them and nothing ever reads them back. */
  secretKeys: readonly string[];
  /** Secret fields that must be present to create a client. */
  requiredSecrets?: readonly string[];
  presets?: readonly ProviderPreset[];
  /**
   * The origins this instance may talk to. Credentials are sent nowhere else; a null entry
   * list (local disk) means no network at all.
   */
  endpoints(config: Config): string[] | null;
  create(input: CreateInput<Config>): ClientByCapability[C];
  /** The cheapest real call that proves the instance works; throws on failure. */
  test?(client: ClientByCapability[C], config: Config): Promise<void>;
  /** How long that call may take, when it is slower than the default 20 s (image generation). */
  testTimeoutMs?: number;
}

export type AnyAdapter = ProviderAdapter<Capability, any>;
