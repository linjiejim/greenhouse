/**
 * The knowledge tools in real turns: reading with the asker's rights and citing what was read,
 * writes waiting for the member's approval and then written as the Agent, and the Agent's own
 * private reference folder (no card, out of sight of everyone but the Agent and its owner).
 */

import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { docs, docVersions, folders, getDb, messages, requests, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { scriptedModel, text, toolCall } from './model.js';

async function setup() {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const lin = await app.member();
  const chen = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  async function send(conversationId: string, content: string) {
    const sent = await app.call('POST', `/api/conversations/${conversationId}/messages`, {
      token: lin.token,
      body: { content },
    });
    await app.services.engine.idle();
    return sent.body as { run_id: string };
  }
  const steps = (runId: string) =>
    getDb().select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.startedAt));
  const reply = async (runId: string) =>
    (
      await getDb()
        .select()
        .from(messages)
        .where(and(eq(messages.runId, runId), eq(messages.role, 'assistant')))
    )[0]!;
  return { scripts, model, app, lin, chen, main, send, steps, reply };
}

describe('knowledge tools in a turn', () => {
  it('read with the asker’s rights and show what they read as sources', async () => {
    const { scripts, model, app, lin, chen, main, send, steps, reply } = await setup();
    const handbook = await app.services.knowledge.createDoc(lin.id, {
      title: 'Handbook',
      content: 'Expenses are filed by Friday.',
      space: 'team',
    });
    const secret = await app.services.knowledge.createDoc(chen.id, { title: 'Chen only', content: 'private' });
    scripts.push(
      toolCall('knowledge_query', { action: 'read', doc_id: handbook.id }),
      toolCall('knowledge_query', { action: 'read', doc_id: secret.id }, 'call_2'),
      text('File expenses by Friday.'),
    );
    const sent = await send(main.id, 'when are expenses due?');
    expect(model.tools[0]).toEqual(expect.arrayContaining(['knowledge_query', 'knowledge_mutation']));
    const [read, refused] = await steps(sent.run_id);
    expect(read).toMatchObject({ toolName: 'knowledge_query', status: 'succeeded' });
    expect(read!.output).toMatchObject({
      id: handbook.id,
      title: 'Handbook',
      link: `#/knowledge/${handbook.id}`,
      version: 1,
      content: 'Expenses are filed by Friday.',
    });
    // Another member's personal doc is not there for this member's Agent.
    expect(refused).toMatchObject({ status: 'failed', error: { message: 'Doc not found.' } });
    const answer = await reply(sent.run_id);
    expect(answer.citations).toEqual([
      { kind: 'doc', id: handbook.id, title: 'Handbook', url: `#/knowledge/${handbook.id}` },
    ]);
    expect(answer.steps).toEqual(expect.arrayContaining([expect.objectContaining({ summary: '读了《Handbook》' })]));

    // A search result is a source only when the reply links to it.
    scripts.push(
      toolCall('knowledge_query', { action: 'search', query: 'expenses' }),
      text(`See [Handbook](#/knowledge/${handbook.id}).`),
    );
    const searched = await send(main.id, 'find the expenses rule');
    const [search] = await steps(searched.run_id);
    expect(search!.output).toMatchObject({
      results: [expect.objectContaining({ id: handbook.id, title: 'Handbook', where: 'team' })],
    });
    expect((await reply(searched.run_id)).citations).toEqual([
      { kind: 'doc', id: handbook.id, title: 'Handbook', url: `#/knowledge/${handbook.id}` },
    ]);
  });

  it('wait for the member’s approval to change shared docs, then write as the Agent', async () => {
    const { scripts, app, lin, chen, main, send, steps } = await setup();
    const plan = await app.services.knowledge.createDoc(lin.id, {
      title: 'Plan',
      content: 'Ship in May.\n',
      space: 'team',
    });
    const theirs = await app.services.knowledge.createDoc(chen.id, { title: 'Chen only', content: 'private' });
    scripts.push(
      // A doc the member cannot see, a stale version or an edit that does not apply is refused at
      // once: no card asks about it.
      toolCall('knowledge_mutation', { action: 'comment', doc_id: theirs.id, body: 'Hello' }, 'call_0'),
      toolCall('knowledge_mutation', { action: 'edit', doc_id: plan.id, version: 7, content: 'x' }, 'call_00'),
      toolCall(
        'knowledge_mutation',
        { action: 'edit', doc_id: plan.id, version: 1, edits: [{ find: 'April', replace: 'June' }] },
        'call_000',
      ),
      toolCall('knowledge_mutation', {
        action: 'edit',
        doc_id: plan.id,
        version: 1,
        edits: [{ find: 'May', replace: 'June' }],
        change_note: 'New date',
      }),
      text('Updated the plan.'),
    );
    const sent = await send(main.id, 'move the plan to June');
    const cards = await getDb().select().from(requests).where(eq(requests.runId, sent.run_id));
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card).toMatchObject({ kind: 'approval', subject: 'tool_write', status: 'pending' });
    expect(card!.payload).toMatchObject({
      tool: 'knowledge_mutation',
      summary: '修改文档《Plan》',
      details: [
        { label: '改动', value: '+1 −1\n- Ship in May.\n+ Ship in June.' },
        { label: '说明', value: 'New date' },
      ],
    });
    const [pending] = await steps(sent.run_id);
    expect(pending).toMatchObject({ risk: 'write', status: 'pending' });
    expect((await app.services.knowledge.getDoc(lin.id, plan.id)).version).toBe(1);

    expect((await app.call('POST', `/api/requests/${card!.id}/approve`, { token: lin.token })).status).toBe(200);
    await app.services.engine.idle();
    const saved = await app.services.knowledge.getDoc(lin.id, plan.id);
    expect(saved).toMatchObject({
      version: 2,
      content: 'Ship in June.\n',
      updated_by: { id: lin.id },
      updated_by_agent: { id: main.agent_id, name: 'Greeny' },
    });
    const [version] = await getDb()
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.docId, plan.id), eq(docVersions.version, 2)));
    expect(version).toMatchObject({ agentId: main.agent_id, createdBy: lin.id, changeNote: 'New date' });
  });

  it('keep the Agent’s private folder to the Agent and its owner, and write there without a card', async () => {
    const { scripts, app, lin, chen, main, send, steps } = await setup();
    const writer = (await app.call('POST', '/api/agents', { token: lin.token, body: { template_key: 'writer' } })).body;
    const thread = (
      await app.call('POST', '/api/conversations', { token: lin.token, body: { kind: 'direct', agent_id: writer.id } })
    ).body;

    scripts.push(
      toolCall('knowledge_mutation', {
        action: 'create',
        title: 'Notes on Lin',
        content: 'Prefers short answers.',
        space: 'agent',
      }),
      text('Noted.'),
    );
    const sent = await send(main.id, 'remember how I like answers');
    expect(await getDb().select().from(requests).where(eq(requests.runId, sent.run_id))).toEqual([]);
    const [created] = await steps(sent.run_id);
    expect(created).toMatchObject({ toolName: 'knowledge_mutation', risk: 'read', status: 'succeeded' });
    const docId = (created!.output as { created: string }).created;
    const [doc] = await getDb().select().from(docs).where(eq(docs.id, docId));
    const [folder] = await getDb().select().from(folders).where(eq(folders.id, doc!.folderId!));
    expect(folder).toMatchObject({ agentId: main.agent_id, ownerId: lin.id, space: 'personal', name: 'Greeny' });
    const [version] = await getDb().select().from(docVersions).where(eq(docVersions.docId, docId));
    expect(version).toMatchObject({ agentId: main.agent_id, createdBy: lin.id });

    // The owner sees it in their space; nobody else does, and it is never shared.
    const personal = await app.call('GET', '/api/knowledge/folders?space=personal', { token: lin.token });
    expect(personal.body.items).toEqual([expect.objectContaining({ id: folder!.id, agent_id: main.agent_id })]);
    expect((await app.call('GET', `/api/knowledge/docs/${docId}`, { token: chen.token })).status).toBe(404);
    const share = await app.call('PUT', `/api/knowledge/docs/${docId}/share`, {
      token: lin.token,
      body: { items: [{ type: 'member', id: chen.id, role: 'viewer' }] },
    });
    expect(share.body.error.code).toBe('agent_folder_private');

    // Another of the owner's Agents does not see it.
    scripts.push(
      toolCall('knowledge_query', { action: 'search', query: 'short answers' }),
      toolCall('knowledge_query', { action: 'list', space: 'personal' }, 'call_2'),
      toolCall('knowledge_query', { action: 'read', doc_id: docId }, 'call_3'),
      text('Nothing about that.'),
    );
    const other = await send(thread.id, 'what do you know about my answers?');
    const [search, list, read] = await steps(other.run_id);
    expect(search!.output).toEqual({ results: [] });
    expect(list!.output).toEqual({ items: [] });
    expect(read).toMatchObject({ status: 'failed' });

    // The Agent itself finds and changes its notes, still without a card.
    scripts.push(
      toolCall('knowledge_query', { action: 'search', query: 'short answers', space: 'agent' }),
      toolCall(
        'knowledge_mutation',
        { action: 'edit', doc_id: docId, version: 1, content: 'Prefers short answers, in Chinese.' },
        'call_2',
      ),
      text('Updated my notes.'),
    );
    const own = await send(main.id, 'and in Chinese please');
    const [found, edited] = await steps(own.run_id);
    expect(found!.output).toMatchObject({ results: [expect.objectContaining({ id: docId, where: 'Greeny' })] });
    expect(edited).toMatchObject({ risk: 'read', status: 'succeeded' });
    expect(await getDb().select().from(requests).where(eq(requests.runId, own.run_id))).toEqual([]);
  });
});
