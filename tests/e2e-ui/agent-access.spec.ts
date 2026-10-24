import { test, expect } from './fixtures';

/**
 * Settings › Agent connections, driven by a real MCP write.
 *
 * A machine client (created by the test super and bound to it) creates a team
 * knowledge doc over /api/mcp. It runs at once — nothing waits in Greenhouse —
 * and shows up under Activity as done, with the document title.
 */

test("an agent's write runs at once and shows up under Activity", async ({ page, api, runId }) => {
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

    const title = `${runId} agent doc`;
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
    const content = ((await call.json()) as { result: { content: Array<{ text: string }> } }).result.content;
    expect(content.at(-1)!.text).toMatch(/^Recorded in Greenhouse as write run_/);

    await page.goto('/#/settings/agent-connections/activity');
    const row = page.getByRole('row', { name: new RegExp(`${runId}-codex`) }).first();
    await expect(row).toContainText(/Done|已执行/);
    await expect(row).toContainText('knowledge.create_doc');
    await expect(row).toContainText(title);
    // Nothing to approve: the page has no approvals tab at all.
    await expect(page.getByRole('tab', { name: /Approvals|待审批/ })).toHaveCount(0);
  } finally {
    await api.delete(`/api/admin/platform/oauth/clients/${client.client_id}`).catch(() => {});
  }
});
