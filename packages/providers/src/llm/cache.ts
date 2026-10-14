/**
 * Prompt caching. The engine marks where a prompt's stable prefix ends with a neutral marker in
 * a message's provider options (CACHE_BREAKPOINT): the end of the system prompt, the end of the
 * transcript the next turn keeps, the newest message of each call. A vendor that caches only
 * where it is told (Anthropic) gets the marks translated by its adapter; OpenAI-compatible
 * services and DeepSeek cache a repeated prefix by themselves and ignore them.
 */

import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider';

/** The neutral mark, merged into a message's `providerOptions`. */
export const CACHE_BREAKPOINT = { greenhouse: { cacheBreakpoint: true } };

type Message = LanguageModelV4Prompt[number];

/** Anthropic: a marked message ends a cached prefix (`cacheControl`); the neutral mark itself is dropped. */
function toAnthropic(message: Message): Message {
  const options = message.providerOptions;
  if (!options?.greenhouse) return message;
  const { greenhouse, ...rest } = options;
  if (!greenhouse.cacheBreakpoint) return { ...message, providerOptions: rest };
  return {
    ...message,
    providerOptions: { ...rest, anthropic: { ...rest.anthropic, cacheControl: { type: 'ephemeral' } } },
  } as Message;
}

export function withAnthropicCache(model: LanguageModelV4): LanguageModelV4 {
  const marked = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => ({
    ...options,
    prompt: options.prompt.map(toAnthropic),
  });
  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => model.doGenerate(marked(options)),
    doStream: (options) => model.doStream(marked(options)),
  };
}
