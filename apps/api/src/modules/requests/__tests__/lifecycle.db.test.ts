import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, mailMessages, messages, newId, requests, runs, runSteps } from '@greenhouse/db';
import type { RealtimeEvent } from '@greenhouse/contract';
import { createTestApp } from '../../../testing.js';
import { lastUserText, scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';

async function setup() {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const member = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
  const send = async (content = 'Do the task.') => {
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content },
    });
    expect(sent.status).toBe(201);
    await app.services.engine.idle();
    return sent.body;
  };
  const cards = () => getDb().select().from(requests).where(eq(requests.conversationId, main.id)).orderBy(requests.id);
  return { ...app, createMember: app.member, member, main, model, scripts, send, cards };
}

describe('requests clean up after themselves', () => {
  it('replaces only the same member, conversation, Agent, subject and target, retaining the link', async () => {
    const app = await setup();
    const raise = (doc: string, extra = {}) =>
      app.services.requests.create({
        memberId: app.member.id,
        conversationId: app.main.id,
        agentId: app.main.agent_id,
        kind: 'approval',
        subject: 'tool_write',
        title: 'Update',
        payload: { tool: 'knowledge_mutation', input: { action: 'edit', doc_id: doc, content: 'new' } },
        ...extra,
      });
    const first = await raise('doc_a');
    const unrelated = await raise('doc_b');
    const other = await app.createMember();
    const otherMember = await raise('doc_a', { memberId: other.id });
    const otherAgent = await raise('doc_a', { agentId: 'different_agent' });
    const otherConversation = await raise('doc_a', { conversationId: 'different_conversation' });
    const newer = await raise('doc_a');
    expect(await app.services.requests.get(app.member.id, first.id)).toMatchObject({
      status: 'superseded',
      result: { replacement_request_id: newer.id },
    });
    for (const row of [unrelated, otherAgent, otherConversation])
      expect((await app.services.requests.get(app.member.id, row.id)).status).toBe('pending');
    expect((await app.services.requests.get(other.id, otherMember.id)).status).toBe('pending');
    expect(
      (await app.services.notifications.list(app.member.id, { unread: 'false', limit: 100 })).items.map(
        (row) => row.request_id,
      ),
    ).not.toContain(first.id);
    expect(
      (await app.call('POST', `/api/requests/${first.id}/approve`, { token: app.member.token })).body.error.code,
    ).toBe('request_settled');
    await app.services.engine.idle();
  });

  it('uses private workflow targets and scopes todo replacement to its run', async () => {
    const app = await setup();
    app.scripts.push(text('Ready.'), text('Ready.'));
    const firstRun = (await app.send()).run_id;
    const secondRun = (await app.send()).run_id;
    const raise = async (tool: string, input: Record<string, unknown>, runId = firstRun) => {
      const card = await app.services.requests.create({
        memberId: app.member.id,
        conversationId: app.main.id,
        agentId: app.main.agent_id,
        runId,
        kind: 'approval',
        subject: 'tool_write',
        title: 'Private workflow',
        payload: { tool, input },
      });
      await app.services.requests.ready(runId);
      return card;
    };
    for (const [tool, input, replacement] of [
      [
        'agent_mutation',
        { action: 'update', id: 'agent_a', job: 'old' },
        { action: 'update', id: 'agent_a', job: 'new' },
      ],
      ['remind', { action: 'cancel', id: 'rmd_a' }, { action: 'cancel', id: 'rmd_a' }],
      [
        'file_create',
        { name: 'report', format: 'csv', content: 'old' },
        { name: 'report.csv', format: 'csv', content: 'new' },
      ],
      ['todo', { items: [{ title: 'Old', status: 'active' }] }, { items: [{ title: 'New', status: 'done' }] }],
    ] as const) {
      const older = await raise(tool, input);
      const newer = await raise(tool, replacement);
      expect(await app.services.requests.get(app.member.id, older.id)).toMatchObject({
        status: 'superseded',
        result: { replacement_request_id: newer.id },
      });
      if (tool === 'todo') {
        await raise(tool, replacement, secondRun);
        expect((await app.services.requests.get(app.member.id, newer.id)).status).toBe('pending');
      }
    }
    const reminder = { action: 'create', text: 'Meet', due_at: '2026-10-17T09:00:00Z' };
    const first = await raise('remind', reminder);
    await raise('remind', reminder);
    expect((await app.services.requests.get(app.member.id, first.id)).status).toBe('pending');
    await app.services.engine.idle();
  });

  it('replaces a non-blocking plan raised later in the same turn', async () => {
    const app = await setup();
    app.scripts.push(
      toolCall('self', { instructions: 'Old plan', reason: 'First idea' }),
      toolCall('self', { instructions: 'New plan', reason: 'Revised idea' }),
      text('Proposed.'),
    );
    await app.send();
    const [older, newer] = await app.cards();
    expect(older).toMatchObject({ status: 'superseded', result: { replacement_request_id: newer!.id } });
    expect(newer).toMatchObject({ status: 'pending', payload: { instructions: 'New plan' } });
  });

  it('matches mail replies by their stored thread without changing the approved input', async () => {
    const app = await setup();
    const ids = [newId('mail'), newId('mail')];
    for (const [index, id] of ids.entries())
      await getDb()
        .insert(mailMessages)
        .values({
          id,
          agentId: app.main.agent_id,
          ownerId: app.member.id,
          direction: 'in',
          status: 'delivered',
          fromAddress: 'sender@example.org',
          messageId: `<mail-${index}@example.org>`,
          references: ['<root@example.org>'],
        });
    const raise = (id: string) =>
      app.services.requests.create({
        memberId: app.member.id,
        conversationId: app.main.id,
        agentId: app.main.agent_id,
        kind: 'approval',
        subject: 'tool_write',
        title: 'Reply',
        payload: { tool: 'mail', input: { action: 'reply', id, body: 'Draft' } },
      });
    const older = await raise(ids[0]!);
    const newer = await raise(ids[1]!);
    expect((await app.services.requests.get(app.member.id, older.id)).status).toBe('superseded');
    expect(newer.payload.input).toEqual({ action: 'reply', id: ids[1], body: 'Draft' });
    await app.services.engine.idle();
  });

  it('uses a typed message as the question answer without rejecting approvals or waking twice', async () => {
    const app = await setup();
    app.scripts.push(toolCall('ask_user', { question: 'Which city?', fields: [{ key: 'city', label: 'City' }] }));
    await app.send('Plan a trip.');
    const [question] = await app.cards();
    const approval = await app.services.requests.create({
      memberId: app.member.id,
      conversationId: app.main.id,
      agentId: app.main.agent_id,
      kind: 'proposal',
      subject: 'instructions_update',
      title: 'Change instructions',
      payload: {},
    });
    app.scripts.push(text('Kyoto it is.'));
    const answered = await app.send('Kyoto');
    expect(await app.services.requests.get(app.member.id, question!.id)).toMatchObject({
      status: 'superseded',
      result: { reason: 'answered in chat', message_id: answered.message.id },
    });
    expect((await app.services.requests.get(app.member.id, approval.id)).status).toBe('pending');
    expect(lastUserText(app.model.prompts.at(-1)!)).toContain('Kyoto');
    expect(app.model.prompts).toHaveLength(2);
    const [run] = await getDb().select().from(runs).where(eq(runs.id, question!.runId!));
    expect(run!.status).toBe('succeeded');
  });

  it('accepts an unmentioned room answer only from the member whose question it is', async () => {
    const app = await setup();
    const other = await app.createMember();
    const room = (
      await app.call('POST', '/api/conversations', {
        token: app.member.token,
        body: { kind: 'room', title: 'Question room', member_ids: [other.id], agent_ids: ['main'] },
      })
    ).body;
    app.scripts.push(toolCall('ask_user', { question: 'Which city?' }));
    await app.call('POST', `/api/conversations/${room.id}/messages`, {
      token: app.member.token,
      body: { content: '@Greeny plan a trip', mentions: ['main'] },
    });
    await app.services.engine.idle();
    const [question] = await getDb().select().from(requests).where(eq(requests.conversationId, room.id));
    expect(question).toBeDefined();
    await app.call('POST', `/api/conversations/${room.id}/messages`, {
      token: other.token,
      body: { content: 'Kyoto' },
    });
    await app.services.engine.idle();
    expect((await app.services.requests.get(app.member.id, question!.id)).status).toBe('pending');
    app.scripts.push(text('Kyoto it is.'));
    await app.call('POST', `/api/conversations/${room.id}/messages`, {
      token: app.member.token,
      body: { content: 'Kyoto' },
    });
    await app.services.engine.idle();
    expect(await app.services.requests.get(app.member.id, question!.id)).toMatchObject({
      status: 'superseded',
      result: { reason: 'answered in chat' },
    });
    expect(app.model.prompts).toHaveLength(2);
  });

  it('withdraws cards on cancel and skips the waiting steps', async () => {
    const app = await setup();
    app.scripts.push(toolCall('ask_user', { question: 'Wait for answer' }));
    const sent = await app.send();
    const [question] = await app.cards();
    expect((await app.call('POST', `/api/conversations/${app.main.id}/stop`, { token: app.member.token })).status).toBe(
      202,
    );
    await app.services.engine.idle();
    expect((await app.services.requests.get(app.member.id, question!.id)).status).toBe('withdrawn');
    expect((await app.services.notifications.list(app.member.id, { unread: 'false', limit: 100 })).items).toEqual([]);
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(run).toMatchObject({ desiredState: 'cancel', status: 'canceled' });
    await expect(
      app.services.requests.create({
        memberId: app.member.id,
        runId: sent.run_id,
        conversationId: app.main.id,
        agentId: app.main.agent_id,
        kind: 'proposal',
        subject: 'instructions_update',
        title: 'Too late',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'run_canceled' });
  });

  it('withdraws a waiting background run and its non-blocking proposals on cancellation', async () => {
    const app = await setup();
    const run = await app.services.engine.background.start({
      agentId: app.main.agent_id,
      ownerId: app.member.id,
      requestedBy: app.member.id,
      title: 'Waiting background',
      brief: 'Wait',
      source: 'conversation',
      sourceId: app.main.id,
      conversationId: app.main.id,
      computer: false,
      domains: [],
      continue_after: false,
    });
    await getDb().update(runs).set({ status: 'waiting', waitReason: 'request' }).where(eq(runs.id, run.id));
    const card = await app.services.requests.create({
      memberId: app.member.id,
      conversationId: app.main.id,
      runId: run.id,
      agentId: app.main.agent_id,
      kind: 'proposal',
      subject: 'instructions_update',
      title: 'Plan',
      payload: {},
    });
    await app.services.engine.background.cancel(run.id, app.member.id);
    await app.services.engine.idle();
    expect((await app.services.requests.get(app.member.id, card.id)).status).toBe('withdrawn');
    const [closed] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(closed!.status).toBe('canceled');
    expect(
      (await app.services.notifications.list(app.member.id, { unread: 'false', limit: 100 })).items.some(
        (item) => item.request_id === card.id,
      ),
    ).toBe(false);
  });

  it('sweeps approved scopes with one execution and receipt per request, without including tainted work', async () => {
    const app = await setup();
    const folder = await app.services.knowledge.createFolder(app.member.id, { name: 'Shared', space: 'team' });
    const first = await app.services.knowledge.createDoc(app.member.id, {
      title: 'First',
      content: 'old',
      folder_id: folder.id,
    });
    const second = await app.services.knowledge.createDoc(app.member.id, {
      title: 'Second',
      content: 'old',
      folder_id: folder.id,
    });
    const third = await app.services.knowledge.createDoc(app.member.id, {
      title: 'Third',
      content: 'old',
      folder_id: folder.id,
    });
    for (const doc of [first, second, third]) {
      app.scripts.push(toolCall('knowledge_mutation', { action: 'edit', doc_id: doc.id, version: 1, content: 'new' }));
      await app.send();
    }
    const [a, b, tainted] = await app.cards();
    await getDb()
      .update(requests)
      .set({ payload: { ...tainted!.payload, tainted: true } })
      .where(eq(requests.id, tainted!.id));
    app.scripts.push(text('Done.'), text('Done.'));
    expect(
      (await app.call('POST', `/api/requests/${a!.id}/approve`, { token: app.member.token, body: { standing: true } }))
        .status,
    ).toBe(200);
    await app.services.engine.idle();
    expect(await app.services.requests.get(app.member.id, b!.id)).toMatchObject({
      status: 'approved',
      result: { covered_by_request_id: a!.id },
    });
    expect((await app.services.requests.get(app.member.id, tainted!.id)).status).toBe('pending');
    for (const card of [a!, b!]) {
      const steps = await getDb().select().from(runSteps).where(eq(runSteps.requestId, card.id));
      expect(steps).toHaveLength(1);
      expect(steps[0]!.status).toBe('succeeded');
      expect(
        await getDb()
          .select()
          .from(messages)
          .where(and(eq(messages.runId, card.runId!), sql`${messages.event}->>'type' = 'write_receipt'`)),
      ).toHaveLength(1);
    }
  });

  it.each(['approved', 'rejected', 'answered', 'handed_back', 'canceled'] as const)(
    'clears %s request notifications on two clients, including read rows',
    async (status) => {
      const app = await setup();
      const events: RealtimeEvent[][] = [[], []];
      const off = events.map((list) => app.services.hub.subscribe(app.member.id, (event) => list.push(event)));
      const card = await app.services.requests.create({
        memberId: app.member.id,
        conversationId: app.main.id,
        agentId: app.main.agent_id,
        kind: 'proposal',
        subject: 'instructions_update',
        title: 'Decision',
        payload: {},
      });
      const list = await app.services.notifications.list(app.member.id, { unread: 'false', limit: 100 });
      await app.services.notifications.markRead(app.member.id, { ids: [list.items[0]!.id] });
      await app.services.requests.settle(app.member.id, card.id, { status, result: {} });
      expect((await app.services.notifications.list(app.member.id, { unread: 'false', limit: 100 })).items).toEqual([]);
      expect(await app.services.notifications.summary(app.member.id)).toEqual({ needs_you: 0, unread: 0 });
      for (const seen of events)
        expect(seen).toContainEqual({ type: 'notification.removed', data: { request_id: card.id } });
      off.forEach((unsubscribe) => unsubscribe());
      await app.services.engine.idle();
    },
  );
});
