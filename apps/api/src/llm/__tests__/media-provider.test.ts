import { afterEach, describe, expect, it } from 'vitest';
import { getImageProviderConfig, getMediaProviderConfig } from '../media-provider.js';

const KEYS = ['LLM_API_KEY', 'LLM_BASE_URL', 'MEDIA_API_KEY', 'MEDIA_BASE_URL', 'IMAGE_API_KEY', 'IMAGE_BASE_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(values: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('media endpoints', () => {
  it('image analysis and generation share the media endpoint, falling back to LLM_*', () => {
    setEnv({ LLM_API_KEY: 'llm', LLM_BASE_URL: 'https://api.deepseek.com' });
    expect(getMediaProviderConfig('x')).toEqual({ apiKey: 'llm', baseUrl: 'https://api.deepseek.com' });
    expect(getImageProviderConfig('x')).toEqual({ apiKey: 'llm', baseUrl: 'https://api.deepseek.com' });
  });

  it('IMAGE_* moves only generation to its own endpoint', () => {
    setEnv({
      LLM_API_KEY: 'llm',
      LLM_BASE_URL: 'https://api.deepseek.com',
      IMAGE_API_KEY: 'img',
      IMAGE_BASE_URL: 'https://api.302ai.cn/v1/',
    });
    expect(getImageProviderConfig('x')).toEqual({ apiKey: 'img', baseUrl: 'https://api.302ai.cn/v1' });
    expect(getMediaProviderConfig('x')).toEqual({ apiKey: 'llm', baseUrl: 'https://api.deepseek.com' });
  });

  it('never pairs a key with a base URL it was not configured for', () => {
    // Base URL without its key: fail rather than ship the LLM/media key there.
    setEnv({ LLM_API_KEY: 'llm', MEDIA_API_KEY: 'media', IMAGE_BASE_URL: 'https://api.302ai.cn/v1' });
    expect(() => getImageProviderConfig('image generation')).toThrow(/IMAGE_API_KEY/);

    // Key without its base URL: ignored, so it never reaches the media endpoint.
    setEnv({ MEDIA_API_KEY: 'media', MEDIA_BASE_URL: 'https://media.example.com/v1', IMAGE_API_KEY: 'img' });
    expect(getImageProviderConfig('x')).toEqual({ apiKey: 'media', baseUrl: 'https://media.example.com/v1' });
  });
});
