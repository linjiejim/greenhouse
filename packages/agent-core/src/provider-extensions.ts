/**
 * Provider extension registries — runtime hooks a downstream fork calls at
 * startup to re-add native LLM providers and per-provider behavior WITHOUT
 * editing model.ts / chat-engine.ts (both live in this versioned package, so a
 * fork consuming @greenhouse/agent-core over npm cannot edit them).
 *
 * The kernel ships OpenAI-compatible only (see model.ts); every registry here is
 * EMPTY upstream. A fork installs the native `@ai-sdk/*` SDKs in ITS OWN code and
 * registers, before the first model is created:
 *   - a provider factory        → createModelDirect() dispatches unknown providers here
 *   - a provider-options builder → buildProviderOptions() returns its providerOptions
 *   - a language-model middleware → chat-engine wraps the model for that provider
 *     (e.g. a DeepSeek reasoning / DSML interceptor)
 *
 * Fork example (call once at startup):
 *   registerProviderFactory('deepseek', async ({ model, apiKey, baseUrl }) => {
 *     const { createDeepSeek } = await import('@ai-sdk/deepseek');
 *     return createDeepSeek({ apiKey, baseURL: baseUrl })(model);
 *   });
 *   registerProviderMiddleware('deepseek', myDsmlInterceptor);
 */

import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type { ModelConfig } from './model.js';

export interface ProviderFactoryArgs {
  model: string;
  apiKey: string;
  baseUrl?: string;
}
export type ProviderFactory = (args: ProviderFactoryArgs) => Promise<LanguageModelV3>;
export type ProviderOptionsBuilder = (config: ModelConfig) => unknown;

const providerFactories = new Map<string, ProviderFactory>();
const providerOptionsBuilders = new Map<string, ProviderOptionsBuilder>();
const providerMiddleware = new Map<string, LanguageModelMiddleware>();

/** Register a factory for a non-built-in provider (e.g. 'deepseek', 'anthropic'). */
export function registerProviderFactory(provider: string, factory: ProviderFactory): void {
  providerFactories.set(provider, factory);
}
export function getProviderFactory(provider: string): ProviderFactory | undefined {
  return providerFactories.get(provider);
}

/** Register a providerOptions builder for a provider (AI SDK `providerOptions`). */
export function registerProviderOptionsBuilder(provider: string, builder: ProviderOptionsBuilder): void {
  providerOptionsBuilders.set(provider, builder);
}
export function getProviderOptionsBuilder(provider: string): ProviderOptionsBuilder | undefined {
  return providerOptionsBuilders.get(provider);
}

/** Register a LanguageModelMiddleware applied to models of a given provider. */
export function registerProviderMiddleware(provider: string, middleware: LanguageModelMiddleware): void {
  providerMiddleware.set(provider, middleware);
}
export function getProviderMiddleware(provider: string): LanguageModelMiddleware | undefined {
  return providerMiddleware.get(provider);
}

/** Providers a fork has registered a factory for (diagnostics / guard tests). */
export function listRegisteredProviders(): string[] {
  return [...providerFactories.keys()];
}
