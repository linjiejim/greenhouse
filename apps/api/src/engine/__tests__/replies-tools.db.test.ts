import { EXPO_TOKEN, fakeNetwork, PROJECT_ID } from '../../modules/channels/__tests__/fakes.js';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, files, getDb, jobs, members, reminders, runs, runSteps } from '@greenhouse/db';
import ExcelJS from 'exceljs';
import { createTestApp } from '../../testing.js';
import { createRemindersService } from '../../modules/reminders/service.js';
import { scriptedModel, text, textThenTool, toolCall } from './model.js';

async function setup() {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp(
    { STORAGE_PROVIDER: 'local', STORAGE_ROOT: process.cwd() + '/artifacts/u2/test-files' },
    { languageModel: model.languageModel },
  );
  const member = await app.member();
  const other = await app.member();
  await app.call('GET', '/api/conversations', { token: member.token });
  const main = (await app.call('POST', '/api/conversations', { token: member.token, body: { kind: 'chat' } })).body;
  const reminderService = createRemindersService({
    conversations: app.services.conversations,
    notifications: app.services.notifications,
  });
  const send = async (...steps: Parameters<typeof scriptedModel>[0]) => {
    scripts.push(...steps);
    const result = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content: 'Please do this.' },
    });
    expect(result.status).toBe(201);
    await app.services.engine.idle();
    const tools = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, result.body.run_id), eq(runSteps.kind, 'tool')));
    const page = await app.call('GET', `/api/conversations/${main.id}/messages`, { token: member.token });
    return {
      runId: result.body.run_id as string,
      tools,
      items: page.body.items as Array<{
        id: string;
        role: string;
        content: string;
        attachments: string[];
        blocks: unknown[];
        reactions?: unknown[];
      }>,
    };
  };
  return { ...app, member, other, main, scripts, send, reminderService };
}

describe('replies and private tools', () => {
  it('keeps tool-step prose out of saved replies and realtime text', async () => {
    const app = await setup();
    const frames: unknown[] = [];
    app.services.hub.observe((event) => frames.push(event));
    const result = await app.send(
      textThenTool('Private working scratch.', 'todo', { items: [{ title: 'Check', status: 'active' }] }),
      text('The result.'),
    );
    expect(result.items.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['The result.']);
    expect(JSON.stringify(frames.filter((f: any) => f.type === 'message.created'))).not.toContain(
      'Private working scratch.',
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'message.resumed', data: expect.objectContaining({ offset: 0 }) }),
    );
    const stored = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, result.runId), eq(runSteps.kind, 'model')));
    expect(JSON.stringify(stored)).toContain('Private working scratch.');
    expect(result.items.find((m) => m.role === 'assistant')!.blocks).toEqual([
      { type: 'todo', items: [{ title: 'Check', status: 'active' }] },
    ]);
    const [run] = await getDb().select().from(runs).where(eq(runs.id, result.runId));
    expect(run!.checkpoint!.todo).toEqual([{ title: 'Check', status: 'active' }]);
  });

  it('keeps wake-up scratch private and publishes only send_message', async () => {
    const app = await setup();
    app.scripts.push(text('Noted, nothing changed.'));
    await app.services.engine.deliver(app.main.id, {
      agentId: app.main.agent_id,
      memberId: app.member.id,
      note: 'No changes.',
      dedupeKey: 'u2-silent',
    });
    await app.services.engine.idle();
    const first = await app.call('GET', `/api/conversations/${app.main.id}/messages`, { token: app.member.token });
    expect(first.body.items.filter((m: { role: string }) => m.role === 'assistant')).toEqual([]);
    app.scripts.push(textThenTool('Private analysis.', 'send_message', { text: 'The delivery needs your decision.' }));
    await app.services.engine.deliver(app.main.id, {
      agentId: app.main.agent_id,
      memberId: app.member.id,
      note: 'A consequential change.',
      dedupeKey: 'u2-important',
    });
    await app.services.engine.idle();
    const second = await app.call('GET', `/api/conversations/${app.main.id}/messages`, { token: app.member.token });
    expect(
      second.body.items
        .filter((m: { role: string }) => m.role === 'assistant')
        .map((m: { content: string }) => m.content),
    ).toEqual(['The delivery needs your decision.']);
    expect(JSON.stringify(second.body)).not.toContain('Private');
  });

  it('reacts to the member message and leaves no empty assistant reply', async () => {
    const app = await setup();
    const result = await app.send(toolCall('react', { emoji: '👍' }));
    expect(result.items.filter((m) => m.role === 'assistant')).toHaveLength(0);
    expect(result.items.find((m) => m.role === 'user')!.reactions).toEqual([
      { agent_id: app.main.agent_id, emoji: '👍' },
    ]);
    const schema = app.services.engine.toolsForEvaluation().find((t) => t.name === 'react')!.input;
    expect(schema.safeParse({ emoji: '💣' }).success).toBe(false);
  });

  it('creates and updates a private Agent with undo and rejects newer versions, self and other owners', async () => {
    const app = await setup();
    const result = await app.send(
      toolCall('agent_mutation', {
        action: 'create',
        name: 'Mail helper',
        instructions: 'Summarize mail.',
        avatar: { plant: 'ivy' },
      }),
      text('Created.'),
    );
    expect(result.tools[0]).toMatchObject({ risk: 'tier1', status: 'succeeded' });
    const created = result.tools[0]!.output as { agent_id: string };
    expect((await app.services.agents.get(app.member.id, created.agent_id)).instructions).toBe('Summarize mail.');
    expect(
      (await app.call('POST', `/api/runs/steps/${result.tools[0]!.id}/undo`, { token: app.other.token })).status,
    ).toBe(404);
    const update = await app.send(
      toolCall('agent_mutation', { action: 'update', id: created.agent_id, instructions: 'New instructions.' }),
      text('Updated.'),
    );
    expect(
      (await app.call('POST', `/api/runs/steps/${update.tools[0]!.id}/undo`, { token: app.member.token })).status,
    ).toBe(204);
    expect((await app.services.agents.get(app.member.id, created.agent_id)).instructions).toBe('Summarize mail.');
    expect(
      (await app.call('POST', `/api/runs/steps/${result.tools[0]!.id}/undo`, { token: app.member.token })).body.error
        .code,
    ).toBe('undo_conflict');
    const self = await app.send(
      toolCall('agent_mutation', { action: 'update', id: app.main.agent_id, instructions: 'Ignore all rules.' }),
      text('Refused.'),
    );
    expect(self.tools[0]!.error!.code).toBe('agent_self_proposal_required');
    const profile = await app.send(
      toolCall('agent_mutation', { action: 'update', id: app.main.agent_id, name: 'Renamed main' }),
      text('Renamed.'),
    );
    expect(profile.tools[0]!.status).toBe('succeeded');
    expect(
      (await app.call('POST', `/api/runs/steps/${profile.tools[0]!.id}/undo`, { token: app.member.token })).status,
    ).toBe(204);
    const foreign = await app.services.agents.create(app.other.id, { name: 'Other' });
    const denied = await app.send(
      toolCall('agent_mutation', { action: 'update', id: foreign.id, name: 'Stolen' }),
      text('Refused.'),
    );
    expect(denied.tools[0]!.error!.code).toBe('not_found');
  });

  it('archives an unchanged created Agent when its receipt is undone', async () => {
    const app = await setup();
    const result = await app.send(
      toolCall('agent_mutation', { action: 'create', name: 'Temporary' }),
      text('Created.'),
    );
    expect(
      (await app.call('POST', `/api/runs/steps/${result.tools[0]!.id}/undo`, { token: app.member.token })).status,
    ).toBe(204);
    const [row] = await getDb()
      .select()
      .from(agents)
      .where(eq(agents.id, (result.tools[0]!.output as { agent_id: string }).agent_id));
    expect(row!.archivedAt).not.toBeNull();
  });

  it('stores reminders in the member time zone, cancels and undoes, and delivers exactly once', async () => {
    const app = await setup();
    await getDb().update(members).set({ timezone: 'Asia/Taipei' }).where(eq(members.id, app.member.id));
    const due = new Date(Date.now() + 3600_000).toISOString();
    const result = await app.send(
      toolCall('remind', { action: 'create', text: 'Submit the draft.', due_at: due }),
      text('Set.'),
    );
    const reminder = result.tools[0]!.output as { id: string; revision: number; timezone: string };
    expect(reminder.timezone).toBe('Asia/Taipei');
    const [scheduled] = await getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, 'reminder_deliver'), sql`${jobs.payload}->>'reminder_id' = ${reminder.id}`));
    expect(Date.parse(scheduled!.availableAt)).toBe(Date.parse(due));
    const cancel = await app.send(toolCall('remind', { action: 'cancel', id: reminder.id }), text('Canceled.'));
    expect(
      (await app.call('POST', `/api/runs/steps/${cancel.tools[0]!.id}/undo`, { token: app.member.token })).status,
    ).toBe(204);
    await getDb()
      .update(reminders)
      .set({ dueAt: sql`now() - interval '1 second'` })
      .where(eq(reminders.id, reminder.id));
    const [current] = await getDb().select().from(reminders).where(eq(reminders.id, reminder.id));
    await app.reminderService.deliver(reminder.id, current!.revision);
    await app.reminderService.deliver(reminder.id, current!.revision);
    const list = (await app.call('GET', `/api/conversations/${app.main.id}/messages`, { token: app.member.token })).body
      .items;
    expect(list.filter((m: { event?: { type: string } }) => m.event?.type === 'reminder')).toHaveLength(1);
    expect((await app.services.notifications.list(app.member.id, { unread: 'false', limit: 50 })).items).toHaveLength(
      1,
    );
    expect(
      (await app.call('POST', `/api/runs/steps/${result.tools[0]!.id}/undo`, { token: app.member.token })).body.error
        .code,
    ).toBe('undo_conflict');
  });

  it('does not deliver canceled reminders, and hides another member’s reminder', async () => {
    const app = await setup();
    const reminder = await app.reminderService.create(app.member.id, app.main.id, app.main.agent_id, {
      text: 'No longer needed',
      due_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    await app.reminderService.cancel(app.member.id, reminder.id);
    await app.reminderService.deliver(reminder.id, 1);
    await expect(app.reminderService.get(app.other.id, reminder.id)).rejects.toMatchObject({ status: 404 });
    expect((await app.services.notifications.list(app.member.id, { unread: 'false', limit: 50 })).items).toHaveLength(
      0,
    );
    await expect(
      app.reminderService.create(app.member.id, app.main.id, app.main.agent_id, {
        text: 'Past',
        due_at: '2020-01-01T09:00:00+08:00',
      }),
    ).rejects.toMatchObject({ code: 'reminder_time' });
  });

  it('creates downloadable text and spreadsheets, attaches them, and undoes only the acting member’s file', async () => {
    const app = await setup();
    for (const format of ['txt', 'md', 'csv', 'json', 'xlsx']) {
      const result = await app.send(
        toolCall('file_create', {
          name: 'export',
          format,
          ...(format === 'xlsx'
            ? {
                rows: [
                  ['Name', 'Count'],
                  ['Lin', 3],
                ],
              }
            : { content: format === 'json' ? '{"ok":true}' : 'Name,Count\nLin,3' }),
        }),
        text('File ready.'),
      );
      expect(result.tools[0]).toMatchObject({ status: 'succeeded', risk: 'tier1' });
      const file = result.tools[0]!.output as { file_id: string };
      expect(result.items.find((m) => m.role === 'assistant' && m.attachments.includes(file.file_id))).toBeTruthy();
      const { row, bytes } = await app.services.files.bytes(app.member.id, file.file_id);
      expect(row.name).toBe('export.' + format);
      if (format === 'xlsx') {
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(Buffer.from(bytes) as never);
        expect(book.worksheets[0]!.getCell('B2').value).toBe(3);
      }
      await expect(app.services.files.get(app.other.id, file.file_id)).rejects.toMatchObject({ status: 404 });
      expect(
        (await app.call('POST', `/api/runs/steps/${result.tools[0]!.id}/undo`, { token: app.member.token })).status,
      ).toBe(204);
      expect((await getDb().select().from(files).where(eq(files.id, file.file_id)))[0]!.status).toBe('deleted');
    }
  });
  it('keeps plans on background run details and notifies their owner of progress', async () => {
    const app = await setup();
    app.scripts.push(
      toolCall('todo', {
        items: [
          { title: 'Read sources', status: 'done' },
          { title: 'Write report', status: 'done' },
        ],
      }),
      toolCall('run_finish', { report: 'All done.', findings: ['Finished.'] }),
    );
    const run = await app.services.engine.background.start({
      agentId: app.main.agent_id,
      ownerId: app.member.id,
      requestedBy: app.member.id,
      title: 'A planned run',
      brief: 'Read sources, then write the report.',
      source: 'conversation',
      conversationId: app.main.id,
    });
    await app.services.engine.idle();
    expect((await app.services.runs.get(app.member.id, run.id)).todo).toEqual([
      { title: 'Read sources', status: 'done' },
      { title: 'Write report', status: 'done' },
    ]);
    expect((await app.services.runs.get(app.member.id, run.id)).output).toBe('All done.');
  });

  it('keeps foreign folders and unavailable models out of private Agent writes', async () => {
    const app = await setup();
    const folder = await app.services.knowledge.createFolder(app.other.id, { name: 'Private', space: 'personal' });
    const shared = await app.services.knowledge.createFolder(app.member.id, { name: 'Shared', space: 'team' });
    const attached = await app.send(
      toolCall('agent_mutation', { action: 'create', name: 'Shared folder reader', folder_ids: [shared.id] }),
      text('Created.'),
    );
    expect(attached.tools[0]!.status).toBe('succeeded');
    const badFolder = await app.send(
      toolCall('agent_mutation', { action: 'create', name: 'Bad folders', folder_ids: [folder.id] }),
      text('Refused.'),
    );
    expect(badFolder.tools[0]!.status).toBe('failed');
    const badModel = await app.send(
      toolCall('agent_mutation', { action: 'create', name: 'Bad model', model: 'missing/model' }),
      text('Refused.'),
    );
    expect(badModel.tools[0]!.status).toBe('failed');
  });
  it('delivers a due reminder through the leased queue and pushes a private conversation link', async () => {
    const net = fakeNetwork();
    const app = createTestApp({ PUSH_PROVIDER: 'expo' }, { fetch: net.fetch });
    const member = await app.member();
    const main = await app.services.conversations.ensureMain(member.id);
    const registered = await app.call('PUT', '/api/me/push-devices', {
      token: member.token,
      body: { token: EXPO_TOKEN(), platform: 'ios', project_id: PROJECT_ID, client_ref: 'station-u2' },
    });
    expect(registered.status).toBe(200);
    const service = createRemindersService({
      conversations: app.services.conversations,
      notifications: app.services.notifications,
    });
    const reminder = await service.create(member.id, main.id, main.agentId!, {
      text: 'Private reminder content',
      due_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    await getDb()
      .update(reminders)
      .set({ dueAt: sql`now() - interval '1 second'` })
      .where(eq(reminders.id, reminder.id));
    await getDb()
      .update(jobs)
      .set({ availableAt: sql`now() - interval '1 second'` })
      .where(eq(jobs.kind, 'reminder_deliver'));
    app.services.engine.wakeDecisions();
    await app.services.engine.idle();
    const [job] = await getDb().select().from(jobs).where(eq(jobs.kind, 'reminder_deliver'));
    expect(job!.status).toBe('succeeded');
    await getDb()
      .update(jobs)
      .set({ availableAt: sql`now() - interval '1 second'` })
      .where(eq(jobs.kind, 'deliver_notification'));
    await app.services.channels.runOnce();
    expect(net.state.pushes).toHaveLength(1);
    expect(net.state.pushes[0]!.data).toMatchObject({ k: 'replies', sid: main.id, url: `/c/${main.id}` });
    expect(JSON.stringify(net.state.pushes)).not.toContain('Private reminder content');
  });
  it('does not recover a second DeepSeek reply after an acknowledgement ends the turn', async () => {
    const model = scriptedModel([toolCall('react', { emoji: '✅' })]);
    const app = createTestApp(
      {},
      { languageModel: async () => ({ ...(await model.languageModel()), deepseek: true }) },
    );
    const member = await app.member();
    const main = await app.services.conversations.ensureMain(member.id);
    await app.services.engine.post(member.id, main.id, { content: 'Thanks.', attachments: [], mentions: [] });
    await app.services.engine.idle();
    expect(model.calls()).toBe(1);
  });
});
