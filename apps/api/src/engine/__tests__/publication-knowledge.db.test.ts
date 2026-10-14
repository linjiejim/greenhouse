import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, members, messages, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { scriptedModel, text, toolCall } from './model.js';

async function setup() {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const owner = await app.member();
  const reader = await app.member();
  const other = await app.member();
  const agent = await app.services.agents.create(owner.id, { name: 'Reference', role: 'Research' });
  const folder = await app.services.knowledge.createFolder(owner.id, { name: 'Granted', space: 'personal' });
  const child = await app.services.knowledge.createFolder(owner.id, { name: 'Child', folder_id: folder.id });
  const outside = await app.services.knowledge.createFolder(owner.id, { name: 'Outside', space: 'personal' });
  const granted = await app.services.knowledge.createDoc(owner.id, {
    title: 'Grant needle',
    content: 'needle granted',
    folder_id: child.id,
  });
  const root = await app.services.knowledge.createDoc(owner.id, { title: 'Root needle', content: 'needle secret' });
  const privateFolder = await app.services.knowledge.agentFolder(
    { id: agent.id, ownerId: owner.id, name: agent.name },
    true,
  );
  const privateDoc = await app.services.knowledge.createDoc(owner.id, {
    title: 'Private needle',
    content: 'needle private',
    folder_id: privateFolder!.id,
  });
  const theirs = await app.services.knowledge.createDoc(reader.id, {
    title: 'Reader needle',
    content: 'needle reader',
  });
  const shared = await app.services.knowledge.createDoc(owner.id, {
    title: 'Shared needle',
    content: 'needle team',
    space: 'team',
  });
  const publish = (ids: string[]) =>
    app.call('PUT', `/api/agents/${agent.id}/publication`, {
      token: owner.token,
      body: { audience: [{ type: 'member', id: reader.id }], folder_ids: ids },
    });
  await publish([folder.id]);
  const thread = await app.services.conversations.ensureDirect(reader.id, agent.id);
  async function send(calls: Parameters<typeof toolCall>[1][]) {
    scripts.push(...calls.map((args, i) => toolCall('knowledge_query', args, `call_${i}`)), text('Read the sources.'));
    const sent = await app.call('POST', `/api/conversations/${thread.id}/messages`, {
      token: reader.token,
      body: { content: 'Read knowledge' },
    });
    await app.services.engine.idle();
    return getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')))
      .orderBy(runSteps.key);
  }
  return {
    ...app,
    scripts,
    model,
    owner,
    reader,
    other,
    agent,
    folder,
    child,
    outside,
    granted,
    root,
    privateFolder,
    privateDoc,
    theirs,
    shared,
    publish,
    thread,
    send,
  };
}

describe('public Agent knowledge grants', () => {
  it('confines search, list and reads to the current subtree, gives viewer access and sources, and grants no member access', async () => {
    const s = await setup();
    const steps = await s.send([
      { action: 'search', query: 'needle' },
      { action: 'list' },
      { action: 'read', doc_id: s.granted.id },
      ...[s.root, s.privateDoc, s.theirs, s.shared].map((doc) => ({ action: 'read', doc_id: doc.id })),
      { action: 'list', folder_id: s.outside.id },
      { action: 'search', query: 'needle', folder_id: s.outside.id },
    ]);
    expect(steps[0]!.output).toMatchObject({ results: [expect.objectContaining({ id: s.granted.id })] });
    expect(steps[1]!.output).toMatchObject({
      items: [{ type: 'folder', id: s.folder.id, name: 'Granted', access: 'viewer' }],
    });
    expect(steps[2]).toMatchObject({ status: 'succeeded', output: { access: 'viewer', content: 'needle granted' } });
    expect(steps.slice(3).every((step) => step.status === 'failed')).toBe(true);
    expect(s.model.tools[0]).toContain('knowledge_query');
    expect(s.model.tools[0]).not.toContain('knowledge_mutation');
    const view = await s.call('GET', `/api/conversations/${s.thread.id}/messages`, { token: s.reader.token });
    expect(view.body.items.at(-1).citations).toContainEqual({
      kind: 'doc',
      id: s.granted.id,
      title: s.granted.title,
      url: `#/knowledge/${s.granted.id}`,
    });
    expect((await s.call('GET', `/api/knowledge/docs/${s.granted.id}`, { token: s.reader.token })).status).toBe(404);
    expect(
      (
        await s.call('POST', '/api/conversations', {
          token: s.other.token,
          body: { kind: 'direct', agent_id: s.agent.id },
        })
      ).status,
    ).toBe(404);
  });

  it('ends reads and sources on moves, grant removal and owner module removal', async () => {
    const s = await setup();
    await s.send([{ action: 'read', doc_id: s.granted.id }]);
    await s.services.knowledge.updateDoc(s.owner.id, s.granted.id, { folder_id: s.outside.id });
    expect((await s.send([{ action: 'read', doc_id: s.granted.id }]))[0]!.status).toBe('failed');
    const view = await s.call('GET', `/api/conversations/${s.thread.id}/messages`, { token: s.reader.token });
    expect(view.body.items.flatMap((m: { citations: unknown[] }) => m.citations)).toEqual([]);
    await s.services.knowledge.updateDoc(s.owner.id, s.granted.id, { folder_id: s.child.id });
    await getDb()
      .update(members)
      .set({ modules: { knowledge: false } })
      .where(eq(members.id, s.owner.id));
    expect((await s.send([{ action: 'read', doc_id: s.granted.id }]))[0]!.status).toBe('failed');
    await getDb().update(members).set({ modules: {} }).where(eq(members.id, s.owner.id));
    await s.publish([]);
    s.scripts.push(text('No knowledge tools.'));
    await s.call('POST', `/api/conversations/${s.thread.id}/messages`, {
      token: s.reader.token,
      body: { content: 'Read' },
    });
    await s.services.engine.idle();
    expect(s.model.tools.at(-1)).not.toContain('knowledge_query');
    expect(await getDb().select().from(messages).where(eq(messages.conversationId, s.thread.id))).not.toHaveLength(0);
  });

  it('rejects grants of foreign, team, archived and Agent private folders, including descendants', async () => {
    const s = await setup();
    const foreign = await s.services.knowledge.createFolder(s.other.id, { name: 'Foreign' });
    const team = await s.services.knowledge.createFolder(s.owner.id, { name: 'Workspace', space: 'team' });
    const privateChild = await s.services.knowledge.createFolder(s.owner.id, {
      name: 'Private child',
      folder_id: s.privateFolder!.id,
    });
    await s.services.knowledge.archiveFolder(s.owner.id, s.outside.id);
    for (const id of [foreign.id, team.id, s.privateFolder!.id, privateChild.id, s.outside.id, 'missing'])
      expect((await s.publish([id])).status).toBe(400);
  });
  it('rechecks private-folder moves, archives, publication state, audience and both members at read time', async () => {
    const s = await setup();
    const read = () =>
      s.services.knowledge.getDoc(s.reader.id, s.granted.id, { as: { agentId: s.agent.id }, signed: false });
    await s.services.knowledge.archiveDoc(s.owner.id, s.granted.id);
    await expect(read()).rejects.toMatchObject({ code: 'not_found' });
    await s.services.knowledge.restoreDoc(s.owner.id, s.granted.id);
    await s.services.knowledge.updateFolder(s.owner.id, s.folder.id, { folder_id: s.privateFolder!.id });
    await expect(read()).rejects.toMatchObject({ code: 'not_found' });
    await s.services.knowledge.updateFolder(s.owner.id, s.folder.id, { folder_id: null });
    await s.publish([]);
    await expect(read()).rejects.toMatchObject({ code: 'not_found' });
    await s.publish([s.folder.id]);
    await getDb().update(members).set({ status: 'disabled' }).where(eq(members.id, s.owner.id));
    await expect(read()).rejects.toMatchObject({ code: 'not_found' });
    await getDb().update(members).set({ status: 'active' }).where(eq(members.id, s.owner.id));
    await getDb()
      .update(members)
      .set({ modules: { knowledge: false } })
      .where(eq(members.id, s.reader.id));
    await expect(read()).rejects.toMatchObject({ code: 'forbidden' });
    await getDb().update(members).set({ modules: {} }).where(eq(members.id, s.reader.id));
    await s.call('DELETE', `/api/agents/${s.agent.id}/publication`, { token: s.owner.token });
    await expect(read()).rejects.toMatchObject({ code: 'not_found' });
  });
});
