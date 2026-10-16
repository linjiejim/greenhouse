/** An Agent's mailbox as its owner manages it: the address, its prefix, who may wake it. */

import { describe, expect, it } from 'vitest';
import { AGENT_DOMAIN, mailApp } from './setup.js';

describe('Agent 邮箱', () => {
  it('gives each Agent its own address on first look, and only its owner sees it', async () => {
    const { call, lin, member, mailbox } = await mailApp();
    const first = await mailbox(lin.token);
    expect(first).toMatchObject({
      available: true,
      domain: AGENT_DOMAIN,
      local_part: expect.stringMatching(/^greeny-/),
    });
    expect(await mailbox(lin.token)).toEqual(first);

    const helper = await call('POST', '/api/agents', { token: lin.token, body: { name: '小蒲' } });
    const other = await mailbox(lin.token, helper.body.id);
    // A name without ASCII letters still gets an address.
    expect(other.local_part).toMatch(/^agent-[a-z0-9]{4}$/);
    expect(other.address).not.toBe(first.address);

    const mei = await member('member', 'mei@acme.test');
    expect((await call('GET', `/api/agents/${helper.body.id}/mailbox`, { token: mei.token })).status).toBe(404);
    expect((await call('GET', `/api/agents/${helper.body.id}/mail`, { token: mei.token })).status).toBe(404);
  });

  it('changes the prefix, refusing taken, reserved and malformed ones', async () => {
    const { call, lin, member, mailbox } = await mailApp();
    await mailbox(lin.token);
    const renamed = await call('PATCH', '/api/agents/main/mailbox', {
      token: lin.token,
      body: { local_part: 'Lin.Helper' },
    });
    expect(renamed.body).toMatchObject({ address: `lin.helper@${AGENT_DOMAIN}`, local_part: 'lin.helper' });

    const mei = await member('member', 'mei@acme.test');
    await mailbox(mei.token);
    const taken = await call('PATCH', '/api/agents/main/mailbox', {
      token: mei.token,
      body: { local_part: 'lin.helper' },
    });
    expect(taken).toMatchObject({ status: 409, body: { error: { code: 'mailbox_taken' } } });
    const reserved = await call('PATCH', '/api/agents/main/mailbox', {
      token: mei.token,
      body: { local_part: 'postmaster' },
    });
    expect(reserved.body.error.code).toBe('mailbox_reserved');
    const bad = await call('PATCH', '/api/agents/main/mailbox', {
      token: mei.token,
      body: { local_part: 'no spaces' },
    });
    expect(bad.status).toBe(400);
  });

  it('keeps the address system mail comes from for the workspace', async () => {
    const { call, lin, mailbox } = await mailApp({ env: { MAIL_FROM: `Greenhouse <gh@${AGENT_DOMAIN}>` } });
    await mailbox(lin.token);
    const system = await call('PATCH', '/api/agents/main/mailbox', { token: lin.token, body: { local_part: 'gh' } });
    expect(system.body.error.code).toBe('mailbox_reserved');
  });

  it('keeps a sender list besides the owner and the members', async () => {
    const { call, lin, mailbox } = await mailApp();
    await mailbox(lin.token);
    const added = await call('POST', '/api/agents/main/mailbox/senders', {
      token: lin.token,
      body: { address: 'Partner@Example.com' },
    });
    expect(added.status).toBe(201);
    expect(added.body.senders).toEqual([{ address: 'partner@example.com', created_at: expect.any(String) }]);
    const off = await call('PATCH', '/api/agents/main/mailbox', { token: lin.token, body: { allow_members: false } });
    expect(off.body.allow_members).toBe(false);
    const removed = await call('DELETE', '/api/agents/main/mailbox/senders/partner%40example.com', {
      token: lin.token,
    });
    expect(removed.body.senders).toEqual([]);
    expect(
      (await call('POST', '/api/agents/main/mailbox/senders', { token: lin.token, body: { address: 'nope' } })).status,
    ).toBe(400);
  });
});
