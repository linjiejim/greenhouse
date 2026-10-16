/** The shared API client against the real app: publishing, usage, budgets and avatars. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TokenPair } from '@greenhouse/contract';
import { createApiClient } from '@greenhouse/contract/client';
import { scriptedModel, text } from '../engine/__tests__/model.js';
import { createTestApp, TEST_PASSWORD } from '../testing.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('the API client', () => {
  it('reaches publishing, usage, budgets and avatars', async () => {
    const model = scriptedModel([text('Hello from Helper.')]);
    const { app, services, member } = createTestApp(
      { STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-client-')) },
      { languageModel: model.languageModel },
    );
    await member('admin', 'admin@example.com');
    const lin = await member('member', 'lin@example.com');
    const chen = await member('member', 'chen@example.com');
    const clientFor = async (email: string) => {
      let stored: TokenPair | null = null;
      const client = createApiClient({
        baseUrl: '',
        tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
        fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
      });
      await client.auth.login(email, TEST_PASSWORD);
      return client;
    };
    const asLin = await clientFor('lin@example.com');
    const asChen = await clientFor('chen@example.com');
    const asAdmin = await clientFor('admin@example.com');

    const helper = await asLin.agents.create({ name: 'Helper' });
    const published = await asLin.publication.publish(helper.id, { audience: [{ type: 'member', id: chen.id }] });
    expect(published).toMatchObject({ published: true, version: 1 });
    expect((await asLin.publication.get(helper.id)).audience).toHaveLength(1);
    const shared = await asChen.publication.shared();
    expect(shared.items.map((agent) => agent.owner.id)).toEqual([lin.id]);

    const thread = await asChen.conversations.create({ kind: 'direct', agent_id: helper.id });
    await asChen.conversations.send(thread.id, { content: 'hi' });
    await services.engine.idle();
    expect((await asLin.usage.agent(helper.id)).turns.total).toBe(1);
    expect((await asLin.usage.agentActivity(helper.id)).items[0]).toMatchObject({ mine: false, title: '' });
    expect((await asChen.usage.mine('30d')).period.name).toBe('30d');

    const admin = asAdmin.admin;
    expect((await admin.usage({ group_by: 'agent' })).group_by).toBe('agent');
    const budget = await admin.budgets.save({
      scope_type: 'member',
      scope_id: chen.id,
      unit: 'tokens',
      monthly_limit: 10,
    });
    expect((await admin.budgets.list()).items.map((item) => item.id)).toEqual([budget.id]);
    await admin.budgets.remove(budget.id);
    expect((await admin.publicAgents.list()).items.map((item) => item.id)).toEqual([helper.id]);
    expect((await admin.publicAgents.pause(helper.id)).paused_at).not.toBeNull();
    expect((await admin.publicAgents.resume(helper.id)).paused_at).toBeNull();
    await asLin.publication.unpublish(helper.id);
    expect((await asChen.publication.shared()).items).toEqual([]);

    // An avatar: upload, set, and an <img>-ready URL that needs no header.
    const picture = await asLin.files.upload(new File([PNG], 'me.png', { type: 'image/png' }), { purpose: 'avatar' });
    const me = await asLin.me.update({ avatar_file_id: picture.id });
    const image = await app.request(me.avatar_url!);
    expect(image.headers.get('content-type')).toBe('image/png');
  });
});
