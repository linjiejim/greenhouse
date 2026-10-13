import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { z } from 'zod';
import type { LlmClient, ModelInfo, ProviderAdapter } from '../types.js';
import { isDeepSeekFamily } from './models.js';
import { LLM_PRESETS } from './presets.js';

export const modelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  /** US dollars per million tokens, set by an admin: what usage costs and USD budgets count. */
  price: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cachedInput: z.number().nonnegative().optional(),
    })
    .optional(),
});

export const llmConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  models: z.array(modelInfoSchema).default([]),
  defaultModel: z.string().optional(),
});
export type LlmConfig = z.infer<typeof llmConfigSchema>;

const models = (config: LlmConfig): ModelInfo[] =>
  config.models.length ? config.models : config.defaultModel ? [{ id: config.defaultModel }] : [];

/** One tiny generation: the cheapest call that proves the key, endpoint and model work. */
async function ping(client: LlmClient, config: LlmConfig) {
  const modelId = config.defaultModel ?? models(config)[0]?.id;
  if (!modelId) throw new Error('Add at least one model before testing.');
  await generateText({ model: client.languageModel(modelId), prompt: 'Reply with OK.', maxOutputTokens: 5 });
}

function llmAdapter(
  kind: string,
  label: string,
  defaultBaseUrl: string | null,
  build: (input: {
    baseUrl: string;
    apiKey: string;
    fetch: typeof fetch;
  }) => (modelId: string) => ReturnType<LlmClient['languageModel']>,
  options: { requireKey?: boolean } = {},
): ProviderAdapter<'llm', LlmConfig> {
  const baseUrlOf = (config: LlmConfig) => {
    const baseUrl = config.baseUrl ?? defaultBaseUrl;
    if (!baseUrl) throw new Error(`${label} needs a base URL.`);
    return baseUrl;
  };
  return {
    capability: 'llm',
    kind,
    label,
    configSchema: llmConfigSchema as z.ZodType<LlmConfig>,
    secretKeys: ['apiKey'],
    requiredSecrets: options.requireKey === false ? [] : ['apiKey'],
    presets: LLM_PRESETS.filter((preset) => preset.adapter === kind),
    endpoints: (config) => [baseUrlOf(config)],
    create: ({ config, secrets, fetch }) => {
      const languageModel = build({ baseUrl: baseUrlOf(config), apiKey: secrets.apiKey ?? '', fetch });
      return { languageModel, models: () => models(config) };
    },
    test: ping,
  };
}

export const openaiAdapter = llmAdapter(
  'openai',
  'OpenAI',
  'https://api.openai.com/v1',
  ({ baseUrl, apiKey, fetch }) => {
    const provider = createOpenAI({ apiKey, baseURL: baseUrl, fetch });
    return (modelId) => provider.responses(modelId);
  },
);

export const openaiCompatibleAdapter = llmAdapter(
  'openai-compatible',
  'OpenAI 兼容',
  null,
  ({ baseUrl, apiKey, fetch }) => {
    const generic = createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: baseUrl,
      apiKey,
      fetch,
      includeUsage: true,
    });
    const deepseek = createDeepSeek({ apiKey, baseURL: baseUrl, fetch });
    return (modelId) => (isDeepSeekFamily(modelId, baseUrl) ? deepseek.chat(modelId) : generic.chatModel(modelId));
  },
  { requireKey: false },
);

export const anthropicAdapter = llmAdapter(
  'anthropic',
  'Anthropic',
  'https://api.anthropic.com/v1',
  ({ baseUrl, apiKey, fetch }) => {
    const provider = createAnthropic({ apiKey, baseURL: baseUrl, fetch });
    return (modelId) => provider(modelId);
  },
);

export const geminiAdapter = llmAdapter(
  'gemini',
  'Google Gemini',
  'https://generativelanguage.googleapis.com/v1beta',
  ({ baseUrl, apiKey, fetch }) => {
    const provider = createGoogleGenerativeAI({ apiKey, baseURL: baseUrl, fetch });
    return (modelId) => provider(modelId);
  },
);

export const LLM_ADAPTERS = [openaiAdapter, openaiCompatibleAdapter, anthropicAdapter, geminiAdapter];
