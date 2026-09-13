import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, ScheduledTaskRow } from '@greenhouse/db';

const ws = vi.hoisted(() => ({ sendToUser: vi.fn() }));
vi.mock('../ws/connection-manager.js', () => ({ connectionManager: ws }));

import { buildTaskEmail, buildTaskNotification, notifyTaskResult } from './notify.js';

function task(): ScheduledTaskRow {
  return {
    id: 42,
    user_id: 'owner-1',
    name: 'Daily report',
    profile_id: 'team',
    task_prompt: 'Summarize today',
    schedule: '0 18 * * *',
    timezone: 'Asia/Hong_Kong',
    enabled: true,
    max_steps: 15,
    notify_webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=super-secret',
    notify_email: true,
    notify_wecom: true,
    notify_feishu: false,
    unattended_tools: '[]',
    last_run_at: null,
    last_status: null,
    next_run_at: null,
    run_count: 0,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
  };
}

describe('durable scheduled-task notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists one permanent fact and stable per-channel rows without putting the webhook secret in user payload', async () => {
    const createWithStatus = vi.fn().mockResolvedValue({
      created: true,
      notification: {
        id: 'ntf-1',
        user_id: 'owner-1',
        kind: 'runtime_completed',
        title: 'Daily report completed',
      },
    });
    const createDelivery = vi.fn().mockResolvedValue({ id: 'delivery-1' });
    const db = {
      notifications: {
        createWithStatus,
        createDelivery,
        countUnread: vi.fn().mockResolvedValue(3),
      },
      runtime: { listToolCalls: vi.fn().mockResolvedValue([]) },
    } as unknown as DatabaseProvider;

    await expect(
      notifyTaskResult(
        db,
        task(),
        { status: 'completed', summary: 'Everything is healthy.', sessionId: 'session-1' },
        { runId: 'runtime-1', eventId: 'event-1' },
      ),
    ).resolves.toEqual({ wecom: true, email: true, wecomDm: true, feishuDm: false });

    const notificationInput = createWithStatus.mock.calls[0]![0];
    expect(notificationInput).toEqual(
      expect.objectContaining({
        user_id: 'owner-1',
        kind: 'runtime_completed',
        title: 'Daily report completed',
        body: 'Everything is healthy.',
        run_id: 'runtime-1',
        event_id: 'event-1',
        dedupe_key: 'automation-result:runtime-1:completed',
        payload: {
          schema: 1,
          type: 'automation_result',
          task_id: 42,
          task_name: 'Daily report',
          session_id: 'session-1',
          status: 'completed',
          summary: 'Everything is healthy.',
          runtime_kind: 'automation',
          runtime_run_id: 'runtime-1',
        },
      }),
    );
    expect(JSON.stringify(notificationInput)).not.toContain('super-secret');
    expect(createDelivery.mock.calls.map(([input]) => input)).toEqual([
      {
        notification_id: 'ntf-1',
        channel: 'wecom',
        recipient: 'wecom:webhook:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=super-secret',
      },
      { notification_id: 'ntf-1', channel: 'email', recipient: 'email:user:owner-1' },
      { notification_id: 'ntf-1', channel: 'wecom', recipient: 'wecom:user:owner-1' },
    ]);
    expect(ws.sendToUser).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ type: 'notification:new', notificationId: 'ntf-1', unread: 3 }),
    );
  });

  it('replays delivery creation idempotently but does not push a duplicate in-app notification', async () => {
    const createDelivery = vi.fn().mockResolvedValue({ id: 'delivery-1' });
    const db = {
      notifications: {
        createWithStatus: vi.fn().mockResolvedValue({
          created: false,
          notification: {
            id: 'ntf-1',
            user_id: 'owner-1',
            kind: 'runtime_failed',
            title: 'Daily report needs review',
          },
        }),
        createDelivery,
        countUnread: vi.fn(),
      },
      runtime: { listToolCalls: vi.fn().mockResolvedValue([]) },
    } as unknown as DatabaseProvider;

    await notifyTaskResult(db, task(), { status: 'failed', summary: 'Provider timed out.', sessionId: 'session-1' });

    expect(createDelivery).toHaveBeenCalledTimes(3);
    expect(ws.sendToUser).not.toHaveBeenCalled();
  });
});

describe('delivery bodies', () => {
  const datatable = [
    '```datatable',
    JSON.stringify({ title: '今日新选题', columns: [{ key: 'name', label: '标题' }], rows: [{ name: '补光灯选购' }] }),
    '```',
  ].join('\n');
  const outcome = { status: 'completed' as const, summary: `素材采集完毕。\n\n${datatable}`, sessionId: 'session-1' };

  it('sends a rendered HTML table, not the fence the agent wrote', () => {
    const email = buildTaskEmail(task(), outcome);

    expect(email.subject).toBe('✅ Daily report');
    expect(email.body_html).toContain('<th>标题</th>');
    expect(email.body_html).toContain('<td>补光灯选购</td>');
    // The whole point: no ```datatable and no JSON in front of the reader.
    expect(email.body_html).not.toContain('datatable');
    expect(email.body_text).not.toContain('```');
    expect(email.body_text).toContain('| 标题 |');
  });

  it('carries a summary longer than the 600-char card limit', () => {
    const long = `${'很长的正文。'.repeat(200)}\n\n${datatable}`;
    const email = buildTaskEmail(task(), { ...outcome, summary: long });

    // Truncating at 600 used to sever the fence, so the table never arrived.
    expect(email.body_html).toContain('<td>补光灯选购</td>');
  });

  it('still trims the WeCom card, and flattens it too', () => {
    const card = buildTaskNotification(task(), { ...outcome, summary: `${'长'.repeat(900)}\n\n${datatable}` });

    expect(card).toContain('…');
    expect(card).not.toContain('```datatable');
  });

  it('says so plainly when the run produced nothing', () => {
    const email = buildTaskEmail(task(), { ...outcome, summary: '' });

    expect(email.body_text).toContain('(no output)');
  });

  describe('session link', () => {
    const originalBaseUrl = process.env.PUBLIC_BASE_URL;
    afterEach(() => {
      if (originalBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = originalBaseUrl;
    });

    // `#/chat/<id>` resolves to the chat route with the id as an ignored path
    // segment, so it opens an empty new conversation. The router reads the
    // session from the query string.
    it('addresses the session by query string, the way the hash router reads it', () => {
      process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.com/';
      const target = 'https://greenhouse.example.com/#/chat?session=session-1';

      const email = buildTaskEmail(task(), outcome);
      expect(email.body_text).toContain(`打开会话：${target}`);
      expect(email.body_html).toContain(`href="${target}"`);
      expect(buildTaskNotification(task(), outcome)).toContain(`[打开会话](${target})`);
    });

    it('omits the link entirely when the deployment has no public base URL', () => {
      delete process.env.PUBLIC_BASE_URL;

      expect(buildTaskEmail(task(), outcome).body_text).not.toContain('打开会话');
      expect(buildTaskNotification(task(), outcome)).not.toContain('打开会话');
    });
  });
});

describe('write receipt', () => {
  const toolCall = (over: Record<string, unknown>) => ({
    tool_name: 'tables_mutation',
    risk_level: 'r1',
    status: 'succeeded',
    input: '{"action":"batch_upsert"}',
    ...over,
  });

  function dbWith(listToolCalls: unknown) {
    return {
      notifications: {
        createWithStatus: vi.fn().mockResolvedValue({
          created: false,
          notification: { id: 'ntf-1', user_id: 'owner-1', kind: 'runtime_completed', title: 'x' },
        }),
        createDelivery: vi.fn().mockResolvedValue({ id: 'd-1' }),
        countUnread: vi.fn(),
      },
      runtime: { listToolCalls },
    } as unknown as DatabaseProvider;
  }

  const outcome = { status: 'completed' as const, summary: 'Wrote 5 rows.', sessionId: 'session-1' };

  it('records what was written in the payload and shows it in the body', async () => {
    const db = dbWith(
      vi.fn().mockResolvedValue([toolCall({}), toolCall({ tool_name: 'crm_query', risk_level: 'r0' })]),
    );

    await notifyTaskResult(db, task(), outcome, { runId: 'runtime-1' });

    const input = (db.notifications.createWithStatus as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Reads are not writes: only the r1 call is listed.
    expect(input.payload.writes).toEqual([{ tool: 'tables_mutation', action: 'batch_upsert', status: 'succeeded' }]);
    expect(input.body).toContain('本次写入');
    expect(input.body).toContain('tables_mutation (batch_upsert)');
    // The payload keeps the assistant's answer verbatim.
    expect(input.payload.summary).toBe('Wrote 5 rows.');
  });

  it('adds nothing when the run only read', async () => {
    const db = dbWith(vi.fn().mockResolvedValue([toolCall({ tool_name: 'tables_query', risk_level: 'r0' })]));

    await notifyTaskResult(db, task(), outcome, { runId: 'runtime-1' });

    const input = (db.notifications.createWithStatus as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(input.payload.writes).toBeUndefined();
    expect(input.body).not.toContain('本次写入');
  });

  it('still delivers when the receipt query fails', async () => {
    // A successful run must never be reported as failed because its receipt
    // could not be built.
    const db = dbWith(vi.fn().mockRejectedValue(new Error('runtime unavailable')));

    await expect(notifyTaskResult(db, task(), outcome, { runId: 'runtime-1' })).resolves.toBeTruthy();

    const input = (db.notifications.createWithStatus as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(input.body).toContain('Wrote 5 rows.');
    expect(input.payload.writes).toBeUndefined();
  });

  it('flags a call whose outcome is not a clean success', async () => {
    const db = dbWith(vi.fn().mockResolvedValue([toolCall({ status: 'uncertain' })]));

    await notifyTaskResult(db, task(), outcome, { runId: 'runtime-1' });

    const input = (db.notifications.createWithStatus as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(input.body).toContain('uncertain');
  });

  it('appends the receipt to the email and card bodies', () => {
    const writes = [{ tool: 'crm_mutation', action: 'update_lead', status: 'succeeded' }];

    expect(buildTaskEmail(task(), outcome, writes).body_text).toContain('crm_mutation (update_lead)');
    expect(buildTaskEmail(task(), outcome, writes).body_html).toContain('crm_mutation');
    expect(buildTaskNotification(task(), outcome, writes)).toContain('本次写入');
  });

  it('survives a long answer — the receipt is appended after truncation', () => {
    const writes = [{ tool: 'tables_mutation', status: 'succeeded' }];
    const card = buildTaskNotification(task(), { ...outcome, summary: '长'.repeat(900) }, writes);

    expect(card).toContain('…');
    expect(card).toContain('tables_mutation');
  });
});
