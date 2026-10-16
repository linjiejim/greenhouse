import { describe, expect, it } from 'vitest';
import { scriptedModel, text } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';

describe('computers without a sandbox', () => {
  it('are not offered, and their routes say why', async () => {
    const model = scriptedModel([text('ok')]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    await app.call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content: 'hi' } });
    await app.services.engine.idle();
    expect(model.tools[0]).not.toContain('computer');
    expect((await app.call('GET', '/api/agents/main/computer', { token: lin.token })).body).toMatchObject({
      state: 'stopped',
    });
    const start = await app.call('POST', '/api/agents/main/computer/start', { token: lin.token });
    expect(start.status).toBe(503);
    expect(start.body.error.code).toBe('computer_unavailable');
  });

  it('respect the member module switch', async () => {
    const app = createTestApp({ SANDBOX_PROVIDER: 'docker' });
    const admin = await app.member('admin');
    const lin = await app.member();
    await app.call('PATCH', `/api/admin/members/${lin.id}`, {
      token: admin.token,
      body: { modules: { computer: false } },
    });
    const start = await app.call('POST', '/api/agents/main/computer/start', { token: lin.token });
    expect(start.status).toBe(403);
  });
});
