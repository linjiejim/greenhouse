/**
 * The knowledge tools in real turns: reading with the asker's rights and citing what was read,
 * writes waiting for the member's approval and then written as the Agent, and the Agent's own
 * private reference folder (no card, out of sight of everyone but the Agent and its owner).
 */

import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DOC_CONTENT_MAX, type RealtimeEvent } from '@greenhouse/contract';
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
    getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.kind, 'tool')))
      .orderBy(asc(runSteps.startedAt), asc(runSteps.id));
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
    expect(refused).toMatchObject({
      status: 'failed',
      error: { code: 'not_found', message: '读一篇文档失败：对象不存在或无法访问' },
    });
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
      results: [
        expect.objectContaining({
          id: handbook.id,
          title: 'Handbook',
          where: '团队知识库',
          space: 'team',
          space_label: '团队知识库',
        }),
      ],
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
        { label: '内容预览', value: 'Ship in June.\n', format: 'markdown' },
        { label: '说明', value: 'New date' },
      ],
    });
    const [pending] = await steps(sent.run_id);
    expect(pending).toMatchObject({ risk: 'tier2', status: 'pending' });
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

  it('refuse an edit that would make a doc longer than the limit, before any card', async () => {
    const { scripts, model, app, lin, main, send, reply } = await setup();
    const big = await app.services.knowledge.createDoc(lin.id, {
      title: 'Big',
      content: `START\n${'b'.repeat(DOC_CONTENT_MAX - 100_000)}`,
      space: 'team',
    });
    scripts.push(
      toolCall('knowledge_mutation', {
        action: 'edit',
        doc_id: big.id,
        version: 1,
        edits: [{ find: 'START', replace: 'x'.repeat(150_000) }],
      }),
      text('That was too much.'),
    );
    const sent = await send(main.id, 'pad the doc');
    expect((await reply(sent.run_id)).steps).toEqual([expect.objectContaining({ status: 'failed' })]);
    // The Agent is told why; nobody is asked to approve an edit that cannot be saved.
    expect(JSON.stringify(model.prompts.at(-1))).toContain('over the limit');
    expect(await getDb().select().from(requests).where(eq(requests.runId, sent.run_id))).toEqual([]);
    expect((await app.services.knowledge.getDoc(lin.id, big.id)).version).toBe(1);
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
    expect(created).toMatchObject({ toolName: 'knowledge_mutation', risk: 'tier1', status: 'succeeded' });
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
    expect(edited).toMatchObject({ risk: 'tier1', status: 'succeeded' });
    expect(await getDb().select().from(requests).where(eq(requests.runId, own.run_id))).toEqual([]);
  });

  it('in a room, show the others no title, place or source of a doc only the asker may read', async () => {
    const { scripts, app, lin, chen, steps } = await setup();
    const folder = await app.services.knowledge.createFolder(lin.id, { name: 'HR private' });
    const secret = await app.services.knowledge.createDoc(lin.id, {
      title: 'Salary review',
      content: 'Numbers.',
      folder_id: folder.id,
    });
    const handbook = await app.services.knowledge.createDoc(lin.id, {
      title: 'Handbook',
      content: 'Hi.',
      space: 'team',
    });
    const another = await app.member();
    await app.services.knowledge.share(lin.id, 'doc', secret.id, {
      items: [{ type: 'member', id: another.id, role: 'viewer' }],
    });
    const room = (
      await app.call('POST', '/api/conversations', {
        token: lin.token,
        body: { kind: 'room', title: 'Launch', member_ids: [chen.id], agent_ids: ['main'] },
      })
    ).body;
    const heard: RealtimeEvent[] = [];
    app.services.hub.subscribe(chen.id, (event) => heard.push(event));
    scripts.push(
      toolCall('knowledge_query', { action: 'read', doc_id: secret.id }),
      toolCall('knowledge_query', { action: 'read', doc_id: handbook.id }, 'call_2'),
      text('Found it.'),
      toolCall('knowledge_mutation', { action: 'comment', doc_id: secret.id, body: 'Checked.' }, 'call_3'),
      text('Commented.'),
    );
    const ask = async (content: string) => {
      const sent = await app.call('POST', `/api/conversations/${room.id}/messages`, {
        token: lin.token,
        body: { content, mentions: ['main'] },
      });
      await app.services.engine.idle();
      return sent.body.run_id as string;
    };
    const read = await ask('@Greeny check the numbers');
    const asked = await ask('@Greeny leave a comment');
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, asked));
    // The card is the asker's: its details name the doc; its summary, which the decision line
    // repeats for everyone, does not.
    expect(card!.payload).toMatchObject({
      summary: '评论一篇文档',
      details: [
        { label: '文档', value: 'Salary review' },
        { label: '评论', value: 'Checked.' },
      ],
    });
    expect((await app.call('POST', `/api/requests/${card!.id}/approve`, { token: lin.token })).status).toBe(200);
    await app.services.engine.idle();

    const transcript = async (token: string) =>
      (await app.call('GET', `/api/conversations/${room.id}/messages`, { token })).body.items as any[];
    const forChen = await transcript(chen.token);
    const chenReply = forChen.find((message) => message.run_id === read && message.role === 'assistant');
    expect(chenReply.citations).toEqual([
      { kind: 'doc', id: handbook.id, title: 'Handbook', url: `#/knowledge/${handbook.id}` },
    ]);
    expect(chenReply.steps.map((step: any) => step.summary)).toEqual(['读了一篇文档', '读了一篇文档']);
    expect(forChen.map((message) => message.content)).toContain('已批准：评论一篇文档');
    expect(JSON.stringify(forChen)).not.toMatch(/Salary review|HR private/);
    expect(heard.length).toBeGreaterThan(0);
    expect(JSON.stringify(heard)).not.toMatch(/Salary review|HR private/);

    // The asker still sees the source, and the step rows keep what was read.
    const linReply = (await transcript(lin.token)).find(
      (message) => message.run_id === read && message.role === 'assistant',
    );
    expect(linReply.citations.map((citation: any) => citation.id)).toEqual([secret.id, handbook.id]);
    expect((await steps(read))[0]!.output).toMatchObject({ title: 'Salary review', where: 'HR private' });
  });
});
