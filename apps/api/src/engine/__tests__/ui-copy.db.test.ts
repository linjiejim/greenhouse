import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { getDb, members, messages, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { scriptedModel, text, toolCall } from './model.js';

async function setup(locale: 'zh' | 'en' = 'zh') {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const member = await app.member();
  await getDb().update(members).set({ locale, timezone: 'Asia/Shanghai' }).where(eq(members.id, member.id));
  const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
  const send = async (...steps: Parameters<typeof scriptedModel>[0]) => {
    scripts.push(...steps);
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content: 'Please make these changes.' },
    });
    await app.services.engine.idle();
    return getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, sent.body.run_id), eq(messages.role, 'event')));
  };
  return { ...app, member, main, send };
}

it.each(['zh', 'en'] as const)(
  'projects schedule decisions in %s without defaults, cron or internal labels',
  async (locale) => {
    const app = await setup(locale);
    const agent = await app.services.agents.create(app.member.id, { name: '晨间邮件' });
    await app.send(
      toolCall('schedule_mutation', {
        action: 'create',
        agent_id: agent.id,
        name: '邮件摘要',
        brief: '整理重要邮件',
        cron: '0 8 * * *',
        timezone: 'Asia/Shanghai',
      }),
    );
    const card = (
      await app.call('GET', `/api/requests?state=pending&conversation_id=${app.main.id}`, { token: app.member.token })
    ).body.items[0];
    const display = JSON.stringify(card.payload.details);
    expect(display).toContain('晨间邮件');
    expect(display).toContain('整理重要邮件');
    expect(display).toContain(locale === 'zh' ? '每天 08:00' : 'Daily at 08:00');
    for (const hidden of ['0 8 * * *', 'agent id', 'Asia/Shanghai', '否', 'No', '—', agent.id])
      expect(display).not.toContain(hidden);
    expect(card.payload.input).toMatchObject({
      agent_id: agent.id,
      cron: '0 8 * * *',
      computer: false,
      domains: [],
      quiet: false,
      continue_after: false,
    });
  },
);

it('keeps a changed access policy and a different time zone visible', async () => {
  const app = await setup();
  const target = await app.services.agents.create(app.member.id, { name: '周报专员' });
  const schedule = await app.services.schedules.create(app.member.id, {
    agent_id: target.id,
    name: '周报',
    brief: '汇报进度',
    cron: '30 9 * * 1-5',
    timezone: 'UTC',
    computer: true,
    domains: ['example.com'],
    quiet: true,
    continue_after: true,
  });
  await app.send(
    toolCall('schedule_mutation', {
      action: 'update',
      id: schedule.id,
      cron: '0 8 * * *',
      computer: false,
      domains: [],
      quiet: false,
      continue_after: false,
    }),
  );
  const card = (
    await app.call('GET', `/api/requests?state=pending&conversation_id=${app.main.id}`, { token: app.member.token })
  ).body.items[0];
  expect(JSON.stringify(card.payload.details)).toContain('改为不使用电脑');
  expect(JSON.stringify(card.payload.details)).toContain('移除指定网站');
  expect(JSON.stringify(card.payload.details)).toContain('每次完成都通知');
  expect(JSON.stringify(card.payload.details)).toContain('UTC');
  expect(card.payload.summary).toContain('周报');
  expect(JSON.stringify(card.payload.details)).toContain('周报专员');
});

it('merges private Agent writes into one named receipt and undoes the complete version lineage', async () => {
  const app = await setup();
  const agent = await app.services.agents.create(app.member.id, { name: '晨间邮件', description: 'Original' });
  const events = await app.send(
    toolCall('agent_mutation', { action: 'update', id: agent.id, description: 'First' }),
    toolCall('agent_mutation', { action: 'update', id: agent.id, description: 'Second' }),
    text('Done.'),
  );
  const receipts = events.filter((m) => m.event?.type === 'write_receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.content).toContain('修改了 Agent「晨间邮件」');
  expect(receipts[0]!.event!.step_ids).toHaveLength(2);
  await app.services.engine.undoWrite(app.member.id, String(receipts[0]!.event!.step_id));
  expect((await app.services.agents.get(app.member.id, agent.id)).description).toBe('Original');
});

it('names and batches memory writes, preserves later member edits and rolls back a conflicting undo', async () => {
  const app = await setup();
  const memory = await app.services.agents.remember(app.member.id, app.main.agent_id, {
    title: '周报每周五发',
    content: 'Original',
    category: 'fact',
    pinned: false,
  });
  const events = await app.send(
    toolCall('memory', { action: 'update', id: memory.id, content: 'First' }),
    toolCall('memory', { action: 'update', id: memory.id, content: 'Second' }),
    text('Done.'),
  );
  const receipts = events.filter((m) => m.event?.type === 'write_receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.content).toContain('更新了记忆：周报每周五发');
  await app.services.engine.undoWrite(app.member.id, String(receipts[0]!.event!.step_id));
  expect(
    (await app.services.agents.memories(app.member.id, app.main.agent_id, 'active')).find((m) => m.id === memory.id)
      ?.content,
  ).toBe('Original');
  const later = await app.send(
    toolCall('memory', { action: 'update', id: memory.id, content: 'Third' }),
    toolCall('memory', { action: 'update', id: memory.id, content: 'Fourth' }),
    text('Done.'),
  );
  await app.services.agents.updateMemory(app.member.id, app.main.agent_id, memory.id, { content: 'Member edit' });
  await expect(
    app.services.engine.undoWrite(
      app.member.id,
      String(later.find((m) => m.event?.type === 'write_receipt')!.event!.step_id),
    ),
  ).rejects.toMatchObject({ code: 'undo_conflict' });
  const undone = await getDb()
    .select()
    .from(runSteps)
    .where(eq(runSteps.id, String(later.find((m) => m.event?.type === 'write_receipt')!.event!.step_id)));
  expect(undone[0]!.undoneAt).toBeNull();
});

it('merges document changes with one undo and restores the original version', async () => {
  const app = await setup();
  const doc = await app.services.knowledge.createDoc(app.member.id, {
    space: 'personal',
    title: '协作说明',
    content: 'Original',
  });
  const events = await app.send(
    toolCall('knowledge_mutation', { action: 'edit', doc_id: doc.id, version: 1, content: 'First' }),
    toolCall('knowledge_mutation', { action: 'edit', doc_id: doc.id, version: 2, content: 'Second' }),
    text('Done.'),
  );
  const receipts = events.filter((m) => m.event?.type === 'write_receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.content).toContain('修改了《协作说明》');
  await app.services.engine.undoWrite(app.member.id, String(receipts[0]!.event!.step_id));
  expect((await app.services.knowledge.getDoc(app.member.id, doc.id)).content).toBe('Original');
});

it('names an irreversible memory decision and marks it as destructive', async () => {
  const app = await setup();
  const memory = await app.services.agents.remember(app.member.id, app.main.agent_id, {
    title: '周报每周五发',
    content: '',
    category: 'fact',
    pinned: false,
  });
  await app.send(toolCall('memory', { action: 'forget', id: memory.id }));
  const card = (
    await app.call('GET', `/api/requests?state=pending&conversation_id=${app.main.id}`, { token: app.member.token })
  ).body.items[0];
  expect(card.payload.danger).toBe(true);
  expect(card.payload.summary).toBe('彻底删除记忆「周报每周五发」');
});

it('projects proposal references without changing the approved brief or instructions', async () => {
  const app = await setup();
  const doc = await app.services.knowledge.createDoc(app.member.id, {
    space: 'personal',
    title: '发布说明',
    content: '',
  });
  const brief = `Read ${doc.id} before starting.`;
  const request = await app.services.requests.create({
    memberId: app.member.id,
    agentId: app.main.agent_id,
    conversationId: app.main.id,
    kind: 'proposal',
    subject: 'run_start',
    title: '开始后台运行',
    payload: { run_title: '检查发布', brief, instructions: brief },
  });
  expect(request.payload.brief).toBe(brief);
  expect(request.payload.instructions).toBe(brief);
  const display = request.payload.display as Record<string, string>;
  expect(display.brief).toContain('发布说明');
  expect(display.instructions).toContain('发布说明');
  expect(JSON.stringify(display)).not.toContain(doc.id);
});
