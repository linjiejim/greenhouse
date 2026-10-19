import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  agents,
  conversationMembers,
  conversations,
  files,
  getDb,
  messageReceipts,
  messages,
  newId,
  requests,
  runs,
} from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { scriptedModel, text } from '../../../engine/__tests__/model.js';
import { ApiError } from '../../../http/errors.js';

async function setup() {
  const model = scriptedModel([text('The branch continues.')]);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const owner = await app.member();
  const specialist = (
    await app.call('POST', '/api/agents', {
      token: owner.token,
      body: { name: 'Research specialist', instructions: 'SPECIALIST-RULE: cite the supplied research evidence.' },
    })
  ).body;
  const source = (
    await app.call('POST', '/api/conversations', {
      token: owner.token,
      body: { kind: 'chat', agent_id: specialist.id },
    })
  ).body;
  const append = (content: string, role: 'user' | 'assistant' = 'assistant') =>
    app.services.conversations.append(source.id, {
      role,
      content,
      ...(role === 'assistant' ? { agentId: specialist.id } : { authorMemberId: owner.id }),
    });
  const fork = (messageId: string, token = owner.token, extra: Record<string, unknown> = {}) =>
    app.call('POST', '/api/conversations', {
      token,
      body: { kind: 'chat', forked_from_message_id: messageId, ...extra },
    });
  const chats = () =>
    getDb()
      .select()
      .from(conversations)
      .where(and(eq(conversations.ownerId, owner.id), eq(conversations.kind, 'chat')));
  return { ...app, model, owner, specialist, source, append, fork, chats };
}

describe('forking a conversation at a reply', () => {
  it('copies the complete visible boundary, keeps its specialist and supplies that history to the next real turn', async () => {
    const { call, services, model, owner, specialist, source, append, fork } = await setup();
    const first = await append('SOURCE-SCOPE: 美国市场，预算 200 美元，排除大型产品。', 'user');
    // More than the default message page: the fork must not copy only what the browser has loaded.
    for (let index = 0; index < 54; index++)
      await append(`Research evidence ${index}`, index % 2 ? 'assistant' : 'user');
    await services.conversations.append(source.id, {
      role: 'event',
      content: 'OLD-APPROVAL-EVENT',
      event: { type: 'write_receipt', request_id: 'old-request' },
    });
    await services.conversations.append(source.id, {
      role: 'assistant',
      agentId: specialist.id,
      content: 'HIDDEN-REPLY',
      visible: false,
    });
    const boundary = await services.conversations.append(source.id, {
      role: 'assistant',
      agentId: specialist.id,
      content:
        'BOUNDARY: 比较紧凑型产品。\n\n```confirm\n{"text":"Send the old email?","actions":[{"label":"Send","value":"SEND-OLD-MAIL"}]}\n```',
      quote: { messageId: first.id, text: first.content },
      blocks: [{ type: 'todo', items: [{ title: 'OLD-TASK', status: 'active' }] }],
      steps: [{ tool: 'mail_send', summary: 'OLD-SEND', status: 'done', approvalStepId: 'old-approval' }],
      runId: 'old-run',
      skill: { skillId: 'old-skill', version: '1', variables: { secret: 'OLD-SKILL-VALUE' } },
      reasoning: 'OLD-REASONING',
      mentions: ['other-member'],
      event: { type: 'greeting' },
    });
    await append('LATER-SCOPE: 改成欧洲市场，预算 900 美元。', 'user');
    await append('LATER-REPLY');
    await getDb()
      .update(conversations)
      .set({ digest: 'LATER-DIGEST: 欧洲市场', digestUptoSeq: boundary.seq + 2 })
      .where(eq(conversations.id, source.id));
    const before = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, source.id))
      .orderBy(asc(messages.seq));
    const created = await fork(boundary.id);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'chat',
      agent_id: specialist.id,
      forked_from_message_id: boundary.id,
      digest: '',
      last_seq: 56,
      unread: 0,
    });
    const copied = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, created.body.id))
      .orderBy(asc(messages.seq));
    expect(copied).toHaveLength(56);
    expect(copied[0]!.content).toBe(first.content);
    expect(copied.at(-1)!.content).toContain('BOUNDARY');
    expect(copied.at(-1)!.content).not.toContain('```confirm');
    expect(copied.at(-1)!.quote?.messageId).toBe(copied[0]!.id);
    expect(copied.every((message) => !before.some((original) => original.id === message.id))).toBe(true);
    for (const message of copied) {
      expect(message).toMatchObject({
        blocks: [],
        steps: [],
        runId: null,
        skill: null,
        reasoning: null,
        mentions: [],
        event: null,
      });
    }
    expect(await getDb().select().from(runs).where(eq(runs.conversationId, created.body.id))).toEqual([]);
    expect(await getDb().select().from(requests).where(eq(requests.conversationId, created.body.id))).toEqual([]);
    expect(await getDb().select().from(messageReceipts)).toEqual([]);
    expect(
      await getDb().select().from(messages).where(eq(messages.conversationId, source.id)).orderBy(asc(messages.seq)),
    ).toEqual(before);

    // Inspect the engine's actual model input; an Echo response alone cannot prove retained context.
    const sent = await call('POST', `/api/conversations/${created.body.id}/messages`, {
      token: owner.token,
      body: { content: 'BRANCH-FOLLOWUP: 继续研究并复述市场、预算和排除条件。' },
    });
    expect(sent.status).toBe(201);
    await services.engine.idle();
    const prompt = JSON.stringify(model.prompts[0]);
    expect(prompt).toContain('SPECIALIST-RULE');
    expect(prompt).toContain('SOURCE-SCOPE');
    expect(prompt).toContain('BOUNDARY');
    expect(prompt).toContain('BRANCH-FOLLOWUP');
    for (const excluded of [
      'LATER-SCOPE',
      'LATER-REPLY',
      'LATER-DIGEST',
      'HIDDEN-REPLY',
      'OLD-APPROVAL-EVENT',
      'OLD-SKILL-VALUE',
      'OLD-REASONING',
    ]) {
      expect(prompt).not.toContain(excluded);
    }
    expect(
      await getDb().select().from(messages).where(eq(messages.conversationId, source.id)).orderBy(asc(messages.seq)),
    ).toEqual(before);
    // Later source edits do not change the independent snapshot.
    await getDb().update(messages).set({ content: 'EDITED-SOURCE' }).where(eq(messages.id, first.id));
    expect(
      (await services.conversations.messages(owner.id, created.body.id, { after: 0, limit: 100 })).items[0]!.content,
    ).toBe(first.content);
  });

  it('rechecks source membership and refuses hidden, incomplete or missing boundaries without creating a chat', async () => {
    const { member, source, owner, specialist, append, fork, chats, services } = await setup();
    const reply = await append('PRIVATE-CONTEXT');
    const outsider = await member();
    expect((await fork(reply.id, outsider.token)).status).toBe(404);
    expect((await fork('msg_missing')).status).toBe(404);
    const hidden = await services.conversations.append(source.id, {
      role: 'assistant',
      agentId: specialist.id,
      content: 'hidden',
      visible: false,
    });
    expect((await fork(hidden.id)).status).toBe(404);
    const unfinished = await services.conversations.append(source.id, {
      role: 'assistant',
      agentId: specialist.id,
      content: 'working',
      status: 'streaming',
    });
    expect((await fork(unfinished.id)).body.error.code).toBe('fork_reply_unavailable');
    const afterUnfinished = await append('Completed after an orphaned stream.');
    expect((await fork(afterUnfinished.id)).body.error.code).toBe('fork_reply_unavailable');
    const userMessage = await append('not a reply', 'user');
    expect((await fork(userMessage.id)).body.error.code).toBe('fork_reply_unavailable');
    await getDb()
      .delete(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, source.id), eq(conversationMembers.memberId, owner.id)));
    expect((await fork(reply.id)).status).toBe(404);
    expect(await chats()).toHaveLength(1);
  });

  it('can copy readable archived or read-only history without changing or unlocking its source', async () => {
    const { source, owner, append, fork, services } = await setup();
    await append('A settled historical request.', 'user');
    const reply = await append('A settled historical reply.');
    await getDb().update(conversations).set({ readOnly: true }).where(eq(conversations.id, source.id));
    await services.conversations.update(owner.id, source.id, { archived: true });
    const original = await services.conversations.get(owner.id, source.id);
    const created = await fork(reply.id);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      read_only: false,
      archived: false,
      last_seq: 2,
      working: false,
      pending_requests: 0,
    });
    expect(await services.conversations.get(owner.id, source.id)).toEqual(original);
  });

  it("never upgrades another member's historical words to the owner's instructions", async () => {
    const { member, source, append, fork, chats, services } = await setup();
    const other = await member();
    await services.conversations.append(source.id, {
      role: 'user',
      authorMemberId: other.id,
      content: "Another person's instruction.",
    });
    const reply = await append('A settled reply.');
    expect((await fork(reply.id)).body.error.code).toBe('fork_source_unsupported');
    expect(await chats()).toHaveLength(1);
  });

  it("keeps the selected reply's own Agent after a handoff, with earlier Agents remaining historical speakers", async () => {
    const { call, source, specialist, owner, append, fork, services, model } = await setup();
    await append('OWNER-SCOPE before handoff.', 'user');
    await append('EARLIER-AGENT-EVIDENCE');
    const second = (
      await call('POST', '/api/agents', {
        token: owner.token,
        body: {
          name: 'Second specialist',
          instructions: 'SECOND-SPECIALIST-RULE: continue the research with sources.',
        },
      })
    ).body;
    const boundary = await services.conversations.append(source.id, {
      role: 'assistant',
      agentId: second.id,
      content: 'HANDOFF-BOUNDARY',
    });
    const created = await fork(boundary.id);
    expect(created.status).toBe(201);
    expect(created.body.agent_id).toBe(second.id);
    expect((await services.conversations.get(owner.id, source.id)).agent_id).toBe(specialist.id);
    const copied = (await services.conversations.messages(owner.id, created.body.id, { limit: 100 })).items;
    expect(copied.filter((message) => message.role === 'assistant').map((message) => message.agent_id)).toEqual([
      specialist.id,
      second.id,
    ]);
    expect(
      (
        await call('POST', `/api/conversations/${created.body.id}/messages`, {
          token: owner.token,
          body: { content: 'Continue after the handoff.' },
        })
      ).status,
    ).toBe(201);
    await services.engine.idle();
    const prompt = JSON.stringify(model.prompts[0]);
    expect(prompt).toContain('SECOND-SPECIALIST-RULE');
    expect(prompt).toContain('EARLIER-AGENT-EVIDENCE');
    expect(prompt).toContain('HANDOFF-BOUNDARY');
  });

  it('propagates an unexpected attachment permission failure and rolls back the entire fork', async () => {
    const { source, specialist, fork, chats, services } = await setup();
    const reply = await services.conversations.append(source.id, {
      role: 'assistant',
      agentId: specialist.id,
      content: 'Research result.',
      attachments: ['file_guarded'],
    });
    const guard = vi
      .spyOn(services.files, 'get')
      .mockRejectedValueOnce(new ApiError(403, 'forbidden', 'Fixture permission failure.'));
    try {
      expect((await fork(reply.id)).status).toBe(403);
      expect(await chats()).toHaveLength(1);
    } finally {
      guard.mockRestore();
    }
  });

  it('keeps file ownership and current read checks, while excluding unavailable files and citations', async () => {
    const { member, source, owner, specialist, fork, services } = await setup();
    const other = await member();
    const attachmentId = newId('file');
    const privateId = newId('file');
    await getDb()
      .insert(files)
      .values([
        {
          id: attachmentId,
          purpose: 'attachment',
          providerId: 'fixture',
          storageKey: attachmentId,
          name: 'Shared evidence.csv',
          contentType: 'text/csv',
          status: 'active',
          ownerId: other.id,
          conversationId: source.id,
        },
        {
          id: privateId,
          purpose: 'attachment',
          providerId: 'fixture',
          storageKey: privateId,
          name: 'Private evidence.csv',
          contentType: 'text/csv',
          status: 'active',
          ownerId: other.id,
        },
      ]);
    const privateDoc = await services.knowledge.createDoc(other.id, {
      title: 'PRIVATE-TITLE',
      content: 'private',
      space: 'personal',
    });
    const boundary = await services.conversations.append(source.id, {
      role: 'assistant',
      agentId: specialist.id,
      content: 'The readable research attachment is available.',
      attachments: [attachmentId, privateId],
      citations: [{ kind: 'doc', id: privateDoc.id, title: privateDoc.title }],
    });
    const created = await fork(boundary.id);
    expect(created.status).toBe(201);
    const copied = (await services.conversations.messages(owner.id, created.body.id, { limit: 100 })).items;
    expect(copied[0]).toMatchObject({ attachments: [attachmentId], citations: [] });
    expect((await services.files.get(owner.id, attachmentId)).conversationId).toBe(source.id);
    await getDb()
      .delete(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, source.id), eq(conversationMembers.memberId, owner.id)));
    await expect(services.files.get(owner.id, attachmentId)).rejects.toMatchObject({ status: 404 });
    expect((await services.conversations.get(owner.id, created.body.id)).id).toBe(created.body.id);
  });

  it('preserves a page reference and rejects it if that source is no longer readable', async () => {
    const { member, source, owner, append, fork, services } = await setup();
    const doc = await services.knowledge.createDoc(owner.id, {
      title: 'Research brief',
      content: 'PAGE-CONTEXT',
      space: 'personal',
    });
    await getDb()
      .update(conversations)
      .set({ context: { kind: 'doc', id: doc.id } })
      .where(eq(conversations.id, source.id));
    const boundary = await append('Use the brief above.');
    const created = await fork(boundary.id);
    expect(created.status).toBe(201);
    const copied = (await getDb().select().from(conversations).where(eq(conversations.id, created.body.id)))[0]!;
    expect(copied.context).toEqual({ kind: 'doc', id: doc.id });
    const other = await member();
    const privateDoc = await services.knowledge.createDoc(other.id, {
      title: 'Private',
      content: 'PRIVATE-PAGE',
      space: 'personal',
    });
    await getDb()
      .update(conversations)
      .set({ context: { kind: 'doc', id: privateDoc.id } })
      .where(eq(conversations.id, source.id));
    expect((await fork(boundary.id)).status).toBe(404);
  });

  it('does not substitute the main Agent when the selected Agent is archived, public or the source is a room', async () => {
    const { call, member, owner, specialist, append, fork, chats, services } = await setup();
    const reply = await append('Specialist reply.');
    await getDb().update(agents).set({ archivedAt: new Date().toISOString() }).where(eq(agents.id, specialist.id));
    expect((await fork(reply.id)).body.error.code).toBe('agent_archived');
    await getDb().update(agents).set({ archivedAt: null }).where(eq(agents.id, specialist.id));
    const other = await member();
    expect(
      (
        await call('PUT', `/api/agents/${specialist.id}/publication`, {
          token: owner.token,
          body: { audience: [{ type: 'member', id: other.id }] },
        })
      ).status,
    ).toBe(200);
    const direct = await call('POST', '/api/conversations', {
      token: other.token,
      body: { kind: 'direct', agent_id: specialist.id },
    });
    const publicReply = await services.conversations.append(direct.body.id, {
      role: 'assistant',
      agentId: specialist.id,
      content: 'Public reply',
    });
    expect((await fork(publicReply.id, other.token)).body.error.code).toBe('fork_agent_unavailable');
    const room = await call('POST', '/api/conversations', {
      token: owner.token,
      body: { kind: 'room', agent_ids: [specialist.id] },
    });
    const roomReply = await services.conversations.append(room.body.id, {
      role: 'assistant',
      agentId: specialist.id,
      content: 'Room reply',
    });
    expect((await fork(roomReply.id)).body.error.code).toBe('fork_source_unsupported');
    expect(await chats()).toHaveLength(1);
  });

  it.each(['messages', 'characters'] as const)(
    'rejects an oversized %s snapshot instead of silently truncating it',
    async (limit) => {
      const { source, specialist, owner, append, fork, chats } = await setup();
      const count = limit === 'messages' ? 500 : 7;
      await getDb()
        .insert(messages)
        .values(
          Array.from({ length: count }, (_, index) => ({
            id: newId('message'),
            conversationId: source.id,
            seq: index + 1,
            role: 'user' as const,
            authorMemberId: owner.id,
            content: limit === 'messages' ? `Evidence ${index}` : 'x'.repeat(30_000),
          })),
        );
      await getDb().update(conversations).set({ lastSeq: count }).where(eq(conversations.id, source.id));
      const boundary = await append('Completed.', 'assistant');
      expect((await fork(boundary.id)).body.error.code).toBe('fork_too_large');
      expect(await chats()).toHaveLength(1);
      expect((await getDb().select().from(messages).where(eq(messages.agentId, specialist.id))).at(-1)!.id).toBe(
        boundary.id,
      );
    },
  );

  it('rejects conflicting fork parameters without a partial chat', async () => {
    const { append, fork, chats } = await setup();
    const boundary = await append('Completed.');
    for (const override of [
      { agent_id: 'main' },
      { model: 'other/model' },
      { context: { kind: 'page', name: 'new' } },
    ]) {
      expect((await fork(boundary.id, undefined, override)).status).toBe(400);
    }
    expect(await chats()).toHaveLength(1);
  });
});
