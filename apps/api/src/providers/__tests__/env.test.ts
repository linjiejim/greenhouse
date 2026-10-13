import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { providersFromEnv } from '../env.js';

describe('providers from env', () => {
  it('builds the LLM instance from a preset and the model aliases', () => {
    const { instances, defaults } = providersFromEnv({
      LLM_PROVIDER: 'deepseek',
      LLM_API_KEY: 'sk-1',
      LLM_MODEL_STRONG: 'deepseek-reasoner',
    });
    expect(instances).toEqual([
      {
        id: 'env-llm',
        capability: 'llm',
        kind: 'openai-compatible',
        preset: 'deepseek',
        name: 'DeepSeek',
        config: {
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
          models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        },
        secrets: { apiKey: 'sk-1' },
      },
    ]);
    expect(defaults.llm).toEqual({ default: 'env-llm/deepseek-chat', strong: 'env-llm/deepseek-reasoner' });
  });

  it('reads a bare base URL as an OpenAI-compatible endpoint', () => {
    const [llm] = providersFromEnv({
      LLM_BASE_URL: 'https://gateway.example.com/v1',
      LLM_MODEL: 'm1',
      LLM_API_KEY: 'k',
    }).instances;
    expect(llm).toMatchObject({
      kind: 'openai-compatible',
      config: { baseUrl: 'https://gateway.example.com/v1', defaultModel: 'm1' },
    });
  });

  it('ignores names it does not know and leaves out empty keys', () => {
    expect(providersFromEnv({ LLM_PROVIDER: 'nope', SEARCH_PROVIDER: 'nope' }).instances).toEqual([]);
    const [llm] = providersFromEnv({ LLM_PROVIDER: 'ollama', LLM_MODEL: 'qwen3' }).instances;
    expect(llm!.secrets).toEqual({});
  });

  it('reads speech, image and a search fallback order', () => {
    const { instances } = providersFromEnv({
      STT_PROVIDER: 'groq',
      STT_API_KEY: 'gsk',
      TTS_PROVIDER: 'minimax',
      TTS_API_KEY: 'mm',
      TTS_VOICE: 'female-shaonv',
      IMAGE_PROVIDER: 'openai',
      IMAGE_API_KEY: 'sk-img',
      SEARCH_PROVIDER: 'tavily, brave, nope',
      TAVILY_API_KEY: 'tv',
      BRAVE_API_KEY: 'bv',
    });
    expect(instances.map((instance) => [instance.id, instance.kind, instance.preset])).toEqual([
      ['env-stt', 'openai-compatible', 'groq'],
      ['env-tts', 'minimax', null],
      ['env-image', 'openai-compatible', 'openai'],
      ['env-search-tavily', 'tavily', null],
      ['env-search-brave', 'brave', null],
    ]);
    expect(instances[0]).toMatchObject({
      config: { baseUrl: 'https://api.groq.com/openai/v1' },
      secrets: { apiKey: 'gsk' },
    });
    expect(instances[1]!.config).toMatchObject({ voice: 'female-shaonv' });
  });

  it('reads S3 and local storage', () => {
    const [s3] = providersFromEnv({
      STORAGE_PROVIDER: 's3',
      STORAGE_ENDPOINT: 'https://cos.ap-shanghai.myqcloud.com',
      STORAGE_BUCKET: 'files',
      STORAGE_ACCESS_KEY_ID: 'id',
      STORAGE_SECRET_ACCESS_KEY: 'secret',
      STORAGE_FORCE_PATH_STYLE: 'false',
    }).instances;
    expect(s3).toMatchObject({
      kind: 's3',
      config: { endpoint: 'https://cos.ap-shanghai.myqcloud.com', bucket: 'files', forcePathStyle: false },
      secrets: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });
    const [local] = providersFromEnv({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: '/data' }).instances;
    expect(local).toMatchObject({ kind: 'local', config: { root: '/data' } });
  });

  it('reads several instances, defaults and policy from PROVIDERS_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'providers-'));
    const file = join(dir, 'providers.yaml');
    writeFileSync(
      file,
      [
        'llm:',
        '  - id: corp-deepseek',
        '    kind: openai-compatible',
        '    preset: deepseek',
        '    api_key_env: DEEPSEEK_KEY',
        '    models:',
        '      - { id: deepseek-chat, context_window: 128000, tools: true }',
        '  - id: Bad Id',
        '    kind: openai',
        '  - id: corp-claude',
        '    kind: anthropic',
        '    api_key_env: MISSING_KEY',
        'videos:',
        '  - id: x',
        '    kind: y',
        'defaults:',
        '  llm: { default: corp-deepseek/deepseek-chat }',
        'policy:',
        '  llm: { allow_personal: true }',
      ].join('\n'),
    );
    const result = providersFromEnv({ PROVIDERS_FILE: file, DEEPSEEK_KEY: 'sk-file' });
    expect(result.instances.map((instance) => instance.id)).toEqual(['corp-deepseek', 'corp-claude']);
    expect(result.instances[0]).toMatchObject({
      preset: 'deepseek',
      config: {
        baseUrl: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-chat', contextWindow: 128000, tools: true }],
      },
      secrets: { apiKey: 'sk-file' },
    });
    expect(result.instances[1]!.secrets).toEqual({});
    expect(result.defaults.llm).toEqual({ default: 'corp-deepseek/deepseek-chat' });
    expect(result.policies.llm).toEqual({ allowPersonal: true, personalCountsTowardBudget: false });
  });
});
