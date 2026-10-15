import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { getDb, members, newId, runs, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { scriptedModel, text, toolCall } from './model.js';

async function setup() {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const member = await app.member('member', 'lin@example.com');
  await getDb().update(members).set({ name: 'Lin', locale: 'zh' }).where(eq(members.id, member.id));
  const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
  const send = async (content = '请执行') => {
    const result = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content },
    });
    expect(result.status).toBe(201);
    await app.services.engine.idle();
    return result.body;
  };
  return { ...app, createMember: app.member, model, scripts, member, main, send };
}

it.each(['offline', 'domains'] as const)(
  'projects actual %s background networking into the proposal payload',
  async (network) => {
    const app = await setup();
    const capability = vi.spyOn(app.services.computers, 'backgroundNetwork').mockResolvedValue(network);
    const search = vi.spyOn(app.services.providers, 'available').mockResolvedValue(true);
    app.scripts.push(
      toolCall('run_start', {
        title: '研究数据库',
        brief: '比较公开文档',
        computer: true,
        domains: ['supabase.com', 'neon.tech'],
        continue_after: false,
      }),
      text('请确认'),
    );
    await app.send();
    const cards = await app.call('GET', `/api/requests?conversation_id=${app.main.id}`, { token: app.member.token });
    const payload = cards.body.items[0].payload;
    expect(payload.computer).toBe(true);
    expect(payload.domains).toEqual(['supabase.com', 'neon.tech']);
    expect(payload.access_summary).toContain(
      network === 'offline' ? '使用搜索和网页阅读 · 研究网站' : '使用电脑 · 可访问的域名',
    );
    expect(payload.access_summary).toContain('supabase.com · neon.tech');
    expect(JSON.stringify(app.model.prompts)).toContain('status_label');
    expect(JSON.stringify(app.model.prompts)).toContain(
      network === 'offline' ? '使用搜索和网页阅读' : '使用电脑 · 可访问的域名',
    );
    if (network === 'offline') expect(payload.access_summary).not.toContain('可访问的域名');
    capability.mockRestore();
    search.mockRestore();
  },
);

it('does not advertise disabled web tools as the background network fallback', async () => {
  const app = await setup();
  app.scripts.push(
    toolCall('run_start', {
      title: '离线整理',
      brief: '整理已知事实',
      computer: false,
      domains: ['example.com'],
      continue_after: false,
    }),
    text('请确认'),
  );
  await app.send();
  const cards = await app.call('GET', `/api/requests?conversation_id=${app.main.id}`, { token: app.member.token });
  expect(cards.body.items[0].payload.access_summary).toBe('本运行未启用搜索或网页阅读 · 研究网站：example.com');
});

it('labels knowledge spaces and access in evidence instead of using an enum as a location', async () => {
  const app = await setup();
  app.scripts.push(
    toolCall('knowledge_mutation', { action: 'create', title: '我的笔记', content: '内容', space: 'personal' }),
    text('好'),
  );
  const sent = await app.send();
  const steps = await getDb().select().from(runSteps).where(eq(runSteps.runId, sent.run_id));
  const output = steps.find((step) => step.toolName === 'knowledge_mutation')!.output as {
    where: string;
    space: string;
    space_label: string;
  };
  expect(output).toMatchObject({ space: 'personal', space_label: '个人知识库' });
  expect(output.where).not.toBe('personal');
});

it('resolves unique room names, refuses ambiguous and partial names, and supplies another member the Agent face', async () => {
  const app = await setup();
  const mei = await app.createMember('member', 'mei@example.com');
  await getDb().update(members).set({ name: 'Mei' }).where(eq(members.id, mei.id));
  const created = await app.call('POST', '/api/conversations', {
    token: app.member.token,
    body: { kind: 'room', title: '讨论', member_ids: [mei.id], agent_ids: ['main'] },
  });
  const room = created.body;
  const resolve = (content: string) => app.services.conversations.resolveMentions(app.member.id, room.id, content, []);
  const agent = (await app.call('GET', '/api/agents/main', { token: app.member.token })).body;
  expect(await resolve('@Greeny 看一下 @Mei')).toEqual(expect.arrayContaining([`agent:${agent.id}`, mei.id]));
  expect(await resolve('@Me 不匹配 @GreenyMore')).toEqual([]);
  await getDb().update(members).set({ name: 'Greeny Chen' }).where(eq(members.id, mei.id));
  expect(await resolve('@Greeny Chen 看一下')).toEqual([mei.id]);
  await getDb().update(members).set({ name: 'Mei' }).where(eq(members.id, mei.id));
  const seats = (await app.call('GET', `/api/conversations/${room.id}/members`, { token: mei.token })).body;
  expect(seats.agents[0]).toMatchObject({
    id: agent.id,
    name: 'Greeny',
    avatar: agent.avatar,
    owner_id: app.member.id,
  });
  app.scripts.push(text('我来看一下'));
  const posted = await app.call('POST', `/api/conversations/${room.id}/messages`, {
    token: app.member.token,
    body: { content: '@Greeny 看一下 @Mei' },
  });
  expect(posted.body.message.mentions).toEqual(expect.arrayContaining([`agent:${agent.id}`, mei.id]));
  expect(posted.body.run_id).not.toBeNull();
  await app.services.engine.idle();
  await getDb().update(members).set({ name: 'Greeny' }).where(eq(members.id, mei.id));
  expect(await resolve('@Greeny 看一下')).toEqual([]);
  await expect(
    app.services.conversations.resolveMentions((await app.createMember()).id, room.id, '@Greeny', []),
  ).rejects.toMatchObject({ status: 404 });
});

it('keeps failed evidence and its human cause when a model reuses a call id for a successful retry', async () => {
  const app = await setup();
  const base = await app.services.tables.create(app.member.id, { name: '客户' });
  const table = base.tables[0]!;
  const stage = await app.services.tables.createField(app.member.id, table.id, {
    name: '阶段',
    type: 'single_select',
    config: { options: [{ id: 'new', label: '新客户', color: 'blue' }] },
  });
  app.scripts.push(
    toolCall('table_mutation', { action: 'create', table_id: table.id, values: { [stage.id]: 'unknown' } }, 'call_0'),
    toolCall('table_mutation', { action: 'create', table_id: table.id, values: { [stage.id]: 'new' } }, 'call_0'),
    text('已完成'),
  );
  const sent = await app.send();
  const transcript = (await app.call('GET', `/api/conversations/${app.main.id}/messages`, { token: app.member.token }))
    .body.items;
  const reply = transcript.find(
    (message: { role: string; run_id: string }) => message.role === 'assistant' && message.run_id === sent.run_id,
  );
  expect(reply.status).toBe('complete');
  expect(reply.steps).toEqual([
    expect.objectContaining({
      status: 'failed',
      recovered: true,
      summary: '新增表格记录失败：字段「阶段」没有这个选项',
    }),
    expect.objectContaining({ status: 'done' }),
  ]);
});

it('keeps a human failure cause on the original approved-write step', async () => {
  const app = await setup();
  const other = await app.createMember();
  const base = await app.services.tables.create(app.member.id, { name: '共享客户' });
  const table = base.tables[0]!;
  const stage = await app.services.tables.createField(app.member.id, table.id, {
    name: '阶段',
    type: 'single_select',
    config: { options: [{ id: 'new', label: '新客户', color: 'blue' }] },
  });
  await app.services.tables.share(app.member.id, base.id, {
    items: [{ type: 'member', id: other.id, role: 'editor' }],
  });
  app.scripts.push(
    toolCall('table_mutation', { action: 'create', table_id: table.id, values: { [stage.id]: 'wrong' } }),
    text('等待确认'),
  );
  const sent = await app.send();
  const card = (await app.call('GET', `/api/requests?conversation_id=${app.main.id}`, { token: app.member.token })).body
    .items[0];
  expect(
    (await app.call('POST', `/api/requests/${card.id}/approve`, { token: app.member.token, body: {} })).status,
  ).toBe(200);
  await app.services.engine.idle();
  const transcript = (await app.call('GET', `/api/conversations/${app.main.id}/messages`, { token: app.member.token }))
    .body.items;
  const reply = transcript.find(
    (message: { role: string; run_id: string }) => message.role === 'assistant' && message.run_id === sent.run_id,
  );
  expect(reply.steps[0]).toMatchObject({ status: 'failed', summary: '新增表格记录失败：字段「阶段」没有这个选项' });
});

it('does not call a different record creation a successful retry', async () => {
  const app = await setup();
  const base = await app.services.tables.create(app.member.id, { name: '不同客户' });
  const table = base.tables[0]!;
  const primary = table.fields[0]!;
  const stage = await app.services.tables.createField(app.member.id, table.id, {
    name: '阶段',
    type: 'single_select',
    config: { options: [{ id: 'new', label: '新客户', color: 'blue' }] },
  });
  app.scripts.push(
    toolCall('table_mutation', {
      action: 'create',
      table_id: table.id,
      values: { [primary.id]: '客户甲', [stage.id]: 'wrong' },
    }),
    toolCall('table_mutation', {
      action: 'create',
      table_id: table.id,
      values: { [primary.id]: '客户乙', [stage.id]: 'new' },
    }),
    text('客户甲未完成，客户乙已完成'),
  );
  const sent = await app.send();
  const transcript = (await app.call('GET', `/api/conversations/${app.main.id}/messages`, { token: app.member.token }))
    .body.items;
  const reply = transcript.find(
    (message: { role: string; run_id: string }) => message.role === 'assistant' && message.run_id === sent.run_id,
  );
  expect(reply.steps[0]).toMatchObject({ status: 'failed' });
  expect(reply.steps[0].recovered).toBeUndefined();
});

it('preserves currency and precision through the shared table field service', async () => {
  const app = await setup();
  const base = await app.services.tables.create(app.member.id, { name: '金额' });
  const amount = await app.services.tables.createField(app.member.id, base.tables[0]!.id, {
    name: '金额',
    type: 'number',
    config: { currency: 'CNY', precision: 2 },
  });
  expect(amount.config).toEqual({ currency: 'CNY', precision: 2 });
  const read = await app.services.tables.get(app.member.id, base.id);
  expect(read.tables[0]!.fields.find((field) => field.id === amount.id)!.config.currency).toBe('CNY');
});

it('finds the latest finished runs even when they were created before newer finished work', async () => {
  const app = await setup();
  const other = await app.createMember();
  const old = newId('run');
  await getDb()
    .insert(runs)
    .values([
      {
        id: old,
        agentId: app.main.agent_id,
        ownerId: app.member.id,
        kind: 'background',
        status: 'succeeded',
        source: 'conversation',
        title: '刚结束的长运行',
        finishedAt: '2026-10-15T12:00:00Z',
      },
      ...[1, 2, 3, 4].map((n) => ({
        id: newId('run'),
        agentId: app.main.agent_id,
        ownerId: app.member.id,
        kind: 'background' as const,
        status: 'succeeded' as const,
        source: 'conversation' as const,
        title: `更早结束 ${n}`,
        finishedAt: `2026-10-15T11:0${n}:00Z`,
      })),
      {
        id: newId('run'),
        agentId: app.main.agent_id,
        ownerId: other.id,
        kind: 'background',
        status: 'succeeded',
        source: 'conversation',
        title: '其他成员的私有运行',
        finishedAt: '2026-10-15T13:00:00Z',
      },
    ]);
  const page = (await app.call('GET', '/api/runs?state=active', { token: app.member.token })).body;
  expect(page.items).toEqual([]);
  expect(page.recent_finished).toHaveLength(3);
  expect(page.recent_finished[0]).toMatchObject({ id: old, title: '刚结束的长运行' });
  expect(page.recent_finished.some((run: { title: string }) => run.title === '其他成员的私有运行')).toBe(false);
});
