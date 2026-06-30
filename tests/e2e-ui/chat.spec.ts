import { test, expect } from './fixtures';

/**
 * Chat flow with a MOCKED LLM — deterministic, no real model call, no cost.
 *
 * Internal chat path: ChatPage → SessionManager.sendMessage → streamChat (POST /api/chat,
 * NDJSON). On completion ChatPage reloads the session (GET /api/sessions/:id) and renders
 * strictly the server's messages (reconcileMessages). So two routes are stubbed:
 *   - POST /api/chat        → the streamed "LLM" answer (text-delta… + finish)
 *   - GET  /api/sessions/:id → the post-completion reload echoing user + assistant
 * POST /api/sessions stays real (cheap); the created session is deleted in cleanup.
 */

// text-delta chunks must concatenate to exactly this (visible both while streaming and after reload).
const ASSISTANT_REPLY = 'pong from the mocked LLM ✅';
const CHUNKS = ['pong from ', 'the mocked LLM ✅'];

test('chat: sends a message and renders the mocked assistant reply', async ({ page, api }) => {
  let userText = '';
  let sessionId: string | null = null;

  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON() as { messages?: Array<{ content?: string }> };
    userText = body?.messages?.[0]?.content ?? '';
    const ndjson =
      CHUNKS.map((text) => JSON.stringify({ type: 'text-delta', text })).join('\n') +
      '\n' +
      JSON.stringify({ type: 'finish', finishReason: 'stop' }) +
      '\n';
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: ndjson });
  });

  // Post-completion reload — return the persisted-looking user + assistant turn.
  await page.route(/\/api\/sessions\/[^/?]+(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    sessionId = new URL(route.request().url()).pathname.split('/').pop() ?? null;
    const msg = (role: string, content: string, seq: number) => ({
      id: `m-${seq}`,
      session_id: sessionId,
      role,
      content,
      references_: '[]',
      pipeline: '[]',
      reasoning: null,
      images: '[]',
      confidence: null,
      grounded: null,
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      reasoning_tokens: null,
      duration_ms: null,
      created_at: '2026-06-30T00:00:00.000Z',
      seq,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: { id: sessionId, title: 'e2e chat', rating: null, comment: null, profile_id: 'default', status: 'active' },
        messages: [msg('user', userText || 'ping', 1), msg('assistant', ASSISTANT_REPLY, 2)],
        usage: { totalInputTokens: 1, totalOutputTokens: 1, totalCachedTokens: 0, totalReasoningTokens: 0 },
        share_info: null,
      }),
    });
  });

  try {
    await page.goto('/#/chat');
    await page.getByTestId('chat-input').fill('ping from playwright');
    await page.getByTestId('chat-send').click();

    // User bubble shows immediately; assistant bubble shows the streamed + reloaded mock reply.
    await expect(page.getByText('ping from playwright')).toBeVisible();
    await expect(page.getByText(ASSISTANT_REPLY)).toBeVisible();
  } finally {
    // POST /api/sessions was real — delete the empty session it created.
    if (sessionId) await api.delete(`/api/sessions/${sessionId}`).catch(() => {});
  }
});
