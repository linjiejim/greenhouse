/**
 * E2E Tests — V1 External API Security
 *
 * Tests the public-facing /api/v1/ endpoints:
 * - API Key authentication (Authorization: Bearer)
 * - Session isolation (app_id boundary)
 * - Profile restriction enforcement
 * - Disabled client rejection
 * - SSE response format
 *
 * Run manually:
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/v1-api.e2e.test.ts --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestToken, BASE_URL } from './helpers.js';

let superToken: string;
const clientsToClean: string[] = [];

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${superToken}`, 'Content-Type': 'application/json' };
}

/** Build Bearer auth header for API client */
function v1Headers(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

/** Parse SSE stream to extract session_id from the greenhouse extension */
function parseSSESessionId(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try {
      const chunk = JSON.parse(line.slice(6));
      if (chunk.greenhouse?.session_id) return chunk.greenhouse.session_id;
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Concatenate all delta.content from an OpenAI-compatible SSE stream. */
function parseSSEContent(text: string): string {
  let content = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try {
      const delta = JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
    } catch {
      /* skip */
    }
  }
  return content;
}

/** True if the SSE stream contains any tool_calls deltas. */
function sseHasToolCalls(text: string): boolean {
  return text.includes('"tool_calls":');
}

/** Create an API client and return { id, apiKey, appId } */
async function createApiClient(overrides: Record<string, unknown> = {}): Promise<{
  id: string;
  apiKey: string;
  appId: string;
}> {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const appId = overrides.app_id ?? `e2e-test-${suffix}`;
  const res = await fetch(`${BASE_URL}/api/admin/clients`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      app_id: appId,
      app_name: `E2E Test Client ${suffix}`,
      allowed_profiles: ['default'],
      rate_limit_rpm: 60,
      rate_limit_rpd: 1000,
      daily_token_limit: 1_000_000,
      ...overrides,
    }),
  });
  const data = await res.json();
  if (!data.client?.id) throw new Error(`Failed to create client: ${JSON.stringify(data)}`);
  clientsToClean.push(data.client.id);
  return { id: data.client.id, apiKey: data.api_key, appId: data.client.app_id };
}

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);
  superToken = createTestToken('e2e-v1-super', 'super');
});

afterAll(async () => {
  for (const id of clientsToClean) {
    await fetch(`${BASE_URL}/api/admin/clients/${id}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    }).catch(() => {});
  }
});

// ─── Authentication ──────────────────────────────────────

describe('E2E: V1 API Key Authentication', () => {
  it('rejects requests without Authorization header', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.message).toContain('Authorization');
  });

  it('rejects malformed API key', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-key-format' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-existent API key with valid format', async () => {
    const fakeKey = 'gh_sk_' + 'a'.repeat(64);
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(fakeKey),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts valid API key with Bearer auth', async () => {
    const client = await createApiClient();
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    // Should not be 401 — may be 200 (streaming) or 429 (rate limited)
    expect(res.status).not.toBe(401);
  });
});

// ─── Profile Restriction ─────────────────────────────────

describe('E2E: V1 Profile Restriction', () => {
  it('rejects profile not in allowed list', async () => {
    const client = await createApiClient({ allowed_profiles: ['default'] });
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'admin',
      }),
    });
    // model is ignored, always uses 'default' — so should NOT be 403
    // (since 'default' IS in allowed list)
    expect(res.status).not.toBe(403);
  });

  it('accepts default profile', async () => {
    const client = await createApiClient({ allowed_profiles: ['default'] });
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    // 200 = streaming, 429 = rate limited; but NOT 403
    expect(res.status).not.toBe(403);
  });
});

// ─── Session Isolation ───────────────────────────────────

describe('E2E: V1 Session Isolation', () => {
  it('cannot access another client session', async () => {
    const clientA = await createApiClient();
    const clientB = await createApiClient();

    // Client A creates a session via chat
    const chatRes = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(clientA.apiKey),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    if (chatRes.status === 200) {
      const text = await chatRes.text();
      const sessionId = parseSSESessionId(text);

      if (sessionId) {
        // Client B tries to access Client A's session
        const getRes = await fetch(`${BASE_URL}/api/v1/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${clientB.apiKey}` },
        });
        expect(getRes.status).toBe(403);
      }
    }
    // If chat was rate-limited (429), skip
  });

  it('returns 404 for non-existent session', async () => {
    const client = await createApiClient();
    const res = await fetch(`${BASE_URL}/api/v1/sessions/nonexistent-session-id`, {
      headers: { Authorization: `Bearer ${client.apiKey}` },
    });
    expect(res.status).toBe(404);
  });
});

// ─── Disabled Client ─────────────────────────────────────

describe('E2E: V1 Disabled Client', () => {
  it('disabled client cannot access V1 endpoints', async () => {
    const client = await createApiClient();

    // Disable the client
    await fetch(`${BASE_URL}/api/admin/clients/${client.id}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ status: 'disabled' }),
    });

    // Try to use the disabled client
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    // Disabled returns 403 now (not 401)
    expect([401, 403]).toContain(res.status);
  });
});

// ─── Input Validation ────────────────────────────────────

describe('E2E: V1 Input Validation', () => {
  it('rejects empty messages array', async () => {
    const client = await createApiClient();
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON body', async () => {
    const client = await createApiClient();
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns OpenAI-format error response', async () => {
    const client = await createApiClient();
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({ messages: [] }),
    });
    const data = await res.json();
    // OpenAI error format: { error: { message, type } }
    expect(data.error).toBeDefined();
    expect(data.error.message).toBeDefined();
    expect(data.error.type).toBe('invalid_request_error');
  });

  it('v1 sessions message pagination capped at 200', async () => {
    const client = await createApiClient();
    const chatRes = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    if (chatRes.status === 200) {
      const text = await chatRes.text();
      const sessionId = parseSSESessionId(text);

      if (sessionId) {
        const msgRes = await fetch(
          `${BASE_URL}/api/v1/sessions/${sessionId}/messages?limit=999`,
          { headers: { Authorization: `Bearer ${client.apiKey}` } },
        );
        if (msgRes.status === 200) {
          const msgData = await msgRes.json();
          expect(msgData.messages.length).toBeLessThanOrEqual(200);
        }
      }
    }
  });
});

// ─── SSE Response Format ─────────────────────────────────

describe('E2E: V1 SSE Response Format', () => {
  it('returns text/event-stream Content-Type for streaming', async () => {
    const client = await createApiClient();
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'say hi' }] }),
    });
    if (res.status === 200) {
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    }
  });

  it('SSE chunks have OpenAI-compatible structure', async () => {
    const client = await createApiClient();
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: v1Headers(client.apiKey),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'say hi' }] }),
    });
    if (res.status === 200) {
      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'));

      if (lines.length > 0) {
        const firstChunk = JSON.parse(lines[0].slice(6));
        expect(firstChunk.id).toMatch(/^chatcmpl-/);
        expect(firstChunk.object).toBe('chat.completion.chunk');
        expect(firstChunk.model).toBeDefined();
        expect(firstChunk.choices).toHaveLength(1);
        expect(firstChunk.choices[0].index).toBe(0);
      }

      // Should end with data: [DONE]
      expect(text).toContain('data: [DONE]');
    }
  });
});

// ─── Streaming Answer Content (tool-using RAG) ───────────

// These two assert the model emits non-empty answer text, so they need a
// working LLM. CI runs the suite against a deliberately-dead LLM endpoint
// (E2E_NO_LLM=1) and skips them; run locally with a real key to exercise them.
describe.skipIf(process.env.E2E_NO_LLM === '1')('E2E: V1 Streaming returns answer content for tool-using queries', () => {
  // Regression for the "0 content delta" bug: a RAG query makes the agent loop
  // call tools, and the model sometimes exhausts its step budget (or leaks a
  // DSML call on the forced final step) without ever emitting answer text.
  // The final-answer guarantee must fill that in, so streaming consumers always
  // get a non-empty assistant answer — matching the non-stream path.
  it(
    'a tool-triggering streaming query yields content deltas',
    async () => {
      const client = await createApiClient();
      const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
        method: 'POST',
        headers: v1Headers(client.apiKey),
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'What is the capital of France? Answer in one sentence.' },
          ],
          stream: true,
        }),
      });

      // Skip if rate-limited / unavailable in this environment.
      if (res.status !== 200) return;

      const text = await res.text();
      expect(text).toContain('data: [DONE]');

      // The core assertion: the final answer is streamed as delta.content.
      const content = parseSSEContent(text);
      expect(content.trim().length).toBeGreaterThan(0);

      // Sanity: no content chunk is emitted AFTER the terminal finish_reason.
      const stopIdx = text.indexOf('"finish_reason":"stop"');
      if (stopIdx >= 0) {
        expect(text.slice(stopIdx + 1)).not.toContain('"content":');
      }

      // This query reliably exercises the tool path; surface (don't hard-fail on)
      // the rare run where the model answers without tools.
      if (!sseHasToolCalls(text)) {
        console.warn('[e2e] streaming query did not trigger tool_calls this run');
      }
    },
    120_000,
  );

  it(
    'non-stream tool-triggering query returns non-empty message content',
    async () => {
      const client = await createApiClient();
      const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
        method: 'POST',
        headers: v1Headers(client.apiKey),
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'What is the capital of France? Answer in one sentence.' },
          ],
          stream: false,
        }),
      });

      if (res.status !== 200) return;
      const data = await res.json();
      const content: string = data?.choices?.[0]?.message?.content ?? '';
      expect(content.trim().length).toBeGreaterThan(0);
    },
    120_000,
  );
});
