/**
 * What the title generator actually puts on the wire.
 *
 * Regression (2026-09-15, letpot-dev): `flash` became an env-derived
 * `openai-compatible` catalog entry pointing at DeepSeek. Built with the
 * generic OpenAI client, `providerOptions.deepseek.thinking = disabled` was
 * silently dropped, V4 reasoned by default, all 60 output tokens went to
 * reasoning (`finish_reason: length`, empty content), and every new session
 * was titled with the user's raw first message — while the log still said
 * "Generated". This pins the request body, not the SDK: `thinking.type` must
 * be `disabled` and the call must go to the DeepSeek endpoint.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '@greenhouse/agent-core';

vi.mock('@greenhouse/db', () => ({ getDb: () => ({}) }));
vi.mock('../usage-budget.js', () => ({ createProviderAttemptBudgetHook: () => undefined }));

import { generateSessionTitle } from '../title.js';

const KEY_ENV = 'TEST_TITLE_WIRE_KEY';
const USER_MESSAGE = '我们 CRM 里一共有多少家客户？其中 S 级有几家？请用 CRM 工具查询后回答，简短。';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

const captured: Captured[] = [];

/** An OpenAI-shaped chat completion; `content` is what the model "said". */
function completion(content: string, finishReason: 'stop' | 'length' = 'stop') {
  return {
    id: 'cmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function stubFetch(content: string, finishReason: 'stop' | 'length' = 'stop') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(completion(content, finishReason)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeAll(() => {
  process.env[KEY_ENV] = 'test-key';
  setModelRegistry({
    flash: {
      name: 'Default model',
      providers: [
        {
          provider: 'openai-compatible',
          model: 'deepseek-v4-flash',
          apiKeyEnv: KEY_ENV,
          baseUrl: 'https://api.deepseek.com',
        },
      ],
    },
  });
});

afterEach(() => {
  captured.length = 0;
  vi.unstubAllGlobals();
});

afterAll(() => {
  setModelRegistry(DEFAULT_MODEL_REGISTRY);
  delete process.env[KEY_ENV];
});

describe('generateSessionTitle on the wire', () => {
  it('asks DeepSeek with thinking switched off and stores the returned title', async () => {
    stubFetch('CRM客户总数与S级数量查询');

    const title = await generateSessionTitle(USER_MESSAGE, { userId: 'u1', sessionId: 's1' });

    expect(title).toBe('CRM客户总数与S级数量查询');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(captured[0].body).toMatchObject({
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      max_tokens: 60,
    });
  });

  it('falls back to the user words when the budget was spent on reasoning', async () => {
    stubFetch('', 'length');

    const title = await generateSessionTitle(USER_MESSAGE, { userId: 'u1', sessionId: 's1' });

    // 45 chars: short enough to be kept whole by fallbackTitle.
    expect(title).toBe(USER_MESSAGE);
  });
});
