/**
 * Vendor presets: the adapter, base URL and a few known models. Admins can type any model id
 * the vendor offers; the list here only fills the form.
 */

export interface LlmPreset {
  id: string;
  label: string;
  adapter: 'openai' | 'openai-compatible' | 'anthropic' | 'gemini';
  config: { baseUrl?: string; defaultModel?: string; models?: { id: string; reasoning?: boolean; vision?: boolean }[] };
  docsUrl?: string;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    adapter: 'openai',
    config: { defaultModel: 'gpt-5-mini', models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    adapter: 'anthropic',
    config: {
      defaultModel: 'claude-sonnet-4-5',
      models: [{ id: 'claude-sonnet-4-5', vision: true }, { id: 'claude-haiku-4-5' }],
    },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    adapter: 'gemini',
    config: { defaultModel: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }] },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    adapter: 'openai-compatible',
    config: {
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-chat',
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner', reasoning: true }],
    },
  },
  {
    id: 'kimi',
    label: 'Kimi',
    adapter: 'openai-compatible',
    config: { baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k2-0905-preview' },
  },
  {
    id: 'qwen',
    label: '通义千问',
    adapter: 'openai-compatible',
    config: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
      models: [{ id: 'qwen-max' }, { id: 'qwen-plus' }],
    },
  },
  {
    id: 'doubao',
    label: '豆包',
    adapter: 'openai-compatible',
    config: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    adapter: 'openai-compatible',
    config: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.6' },
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    adapter: 'openai-compatible',
    config: { baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M2' },
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    adapter: 'openai-compatible',
    config: { baseUrl: 'https://api.siliconflow.cn/v1' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    adapter: 'openai-compatible',
    config: { baseUrl: 'https://openrouter.ai/api/v1' },
  },
  { id: 'groq', label: 'Groq', adapter: 'openai-compatible', config: { baseUrl: 'https://api.groq.com/openai/v1' } },
  { id: 'xai', label: 'xAI', adapter: 'openai-compatible', config: { baseUrl: 'https://api.x.ai/v1' } },
  { id: 'mistral', label: 'Mistral', adapter: 'openai-compatible', config: { baseUrl: 'https://api.mistral.ai/v1' } },
  {
    id: 'together',
    label: 'Together',
    adapter: 'openai-compatible',
    config: { baseUrl: 'https://api.together.xyz/v1' },
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    adapter: 'openai-compatible',
    config: { baseUrl: 'http://localhost:11434/v1' },
  },
];
