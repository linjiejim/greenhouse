/**
 * Handing a project task to an Agent (./projects.ts `handTaskToAgent`, spec
 * 20261011-agent-first-class P3e). Root vitest with the transport faked (`api()` mocked).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();

vi.mock('./client', () => ({
  api: (path: string, init?: RequestInit) => apiMock(path, init),
  apiJson: vi.fn(),
}));

import { handTaskToAgent } from './projects';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => apiMock.mockReset());

describe('handTaskToAgent', () => {
  it('posts the Agent and answers the task and the chat it opened', async () => {
    const task = { id: 7, agent_id: 'bot_a', agent_session_id: 's1' };
    apiMock.mockResolvedValueOnce(json(201, { task, session_id: 's1' }));
    expect(await handTaskToAgent(7, 'bot_a')).toEqual({ ok: true, task, sessionId: 's1' });
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe('/api/projects/tasks/7/agent');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ bot_id: 'bot_a' }) });
  });

  it('a refusal keeps its status; no answer (or an unreadable one) is 0', async () => {
    apiMock.mockResolvedValueOnce(json(403, { error: 'Agents are not enabled for this account' }));
    expect(await handTaskToAgent(7, 'bot_a')).toEqual({ ok: false, status: 403 });
    apiMock.mockResolvedValueOnce(json(404, { error: 'Agent not found' }));
    expect(await handTaskToAgent(7, 'bot_x')).toEqual({ ok: false, status: 404 });
    apiMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await handTaskToAgent(7, 'bot_a')).toEqual({ ok: false, status: 0 });
    apiMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    expect(await handTaskToAgent(7, 'bot_a')).toEqual({ ok: false, status: 0 });
  });
});
