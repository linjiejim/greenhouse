import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(() => ({ marker: 'stream-result' })),
  createModel: vi.fn(async () => ({ modelId: 'fake-model' })),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: mocks.streamText };
});

vi.mock('../model.js', () => ({
  createModelFromConfig: mocks.createModel,
  buildProviderOptions: () => undefined,
  applyModelOverride: (config: unknown) => config,
  resolveModelConfig: (config: unknown) => config,
  resolvesToDeepSeek: () => false,
}));

import { CHAT_STREAM_TIMEOUT, createChatStreamAsync } from '../chat-engine.js';

describe('chat stream lifecycle bounds', () => {
  it('passes the production total, step, and idle-chunk timeout to AI SDK streamText', async () => {
    await createChatStreamAsync({
      profile: {
        model: { provider: 'openai', model: 'fake-model' },
        max_steps: 3,
        tool_choice: 'auto',
      },
      messages: [{ role: 'user', content: 'list top 10 customers' }],
      tools: {},
      systemPrompt: 'test',
      sessionId: 'session-1',
    });

    expect(CHAT_STREAM_TIMEOUT).toEqual({
      totalMs: 15 * 60_000,
      stepMs: 4 * 60_000,
      chunkMs: 2 * 60_000,
    });
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: CHAT_STREAM_TIMEOUT,
      }),
    );
  });
});
