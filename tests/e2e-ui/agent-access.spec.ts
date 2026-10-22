import { test, expect } from './fixtures';

/**
 * Settings › Agent connections, driven by a real MCP write.
 *
 * A machine client (created by the test super and bound to it) asks to create
 * a team knowledge doc over /api/mcp; the write waits for approval. The super
 * opens the approval link the agent was given, approves on the card, and the
 * request moves to Activity as done.
 */

test('a held agent write is approved from its card and shows up as done', async ({ page, api, runId }) => {
  const me = (await (await api.get('/api/auth/me')).json()) as { user?: { id: string }; id?: string };
  const userId = me.user?.id ?? me.id!;
  const created = await api.post('/api/admin/platform/oauth/machine-clients', {
    data: { client_name: `${runId}-codex`, bound_user_id: userId, scopes: ['mcp:read', 'mcp:write', 'mcp:knowledge'] },
  });
  expect(created.status()).toBe(201);
  const client = (await created.json()) as { client_id: string; client_secret: string };

  try {
    // The Vite dev server proxies /api only; the OAuth endpoints live on the API port.
    const apiOrigin = `http://localhost:${process.env.API_PORT || 3000}`;
    const token = await api.post(`${apiOrigin}/oauth/token`, {
      form: {
        grant_type: 'client_credentials',
        client_id: client.client_id,
        client_secret: client.client_secret,
        scope: 'mcp:read mcp:write mcp:knowledge',
      },
      headers: { Authorization: '' },
    });
    expect(token.status()).toBe(200);
    const accessToken = ((await token.json()) as { access_token: string }).access_token;

    const title = `${runId} approved doc`;
    const call = await api.post('/api/mcp', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream' },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'knowledge_mutation',
          arguments: { action: 'knowledge.create_doc', scope: 'team', title, content: 'from e2e' },
        },
      },
    });
    const pending = JSON.parse(
      ((await call.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    );
    expect(pending.status).toBe('needs_approval');

    await page.goto(`/#/settings/agent-connections/requests/${pending.request_id}`);
    const card = page.getByTestId(`agent-write-request-${pending.request_id}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(`${runId}-codex`);
    await expect(card).toContainText('knowledge.create_doc');
    await expect(card).toContainText(title);

    await card.getByRole('button', { name: /^(Approve|批准)$/ }).click();
    await expect(card).toHaveCount(0);

    await page.getByRole('tab', { name: /Activity|写入记录/ }).click();
    const row = page.getByRole('row', { name: new RegExp(`${runId}-codex`) }).first();
    await expect(row).toContainText(/Done|已执行/);
  } finally {
    await api.delete(`/api/admin/platform/oauth/clients/${client.client_id}`).catch(() => {});
  }
});
