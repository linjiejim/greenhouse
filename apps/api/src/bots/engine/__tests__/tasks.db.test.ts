/**
 * Background tasks on the Runtime `subagent` kind (design review R15): admitted
 * only from the member's Start, bound to the Bot through server-written
 * metadata, ≤3 running per member, executed with a read-only face and the
 * Bot's context pack, and reported back into the conversation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { createSubagentRuntimeDriver } from '../../../runtime/subagent-driver.js';
import { decideBotRequest } from '../requests.js';
import {
  admitBotTask,
  BotTaskError,
  cancelBotTask,
  listConversationTasks,
  MAX_RUNNING_TASKS_PER_MEMBER,
} from '../tasks.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

let db: DatabaseProvider;
let user: UserRow;
let sage: BotRow;
let conversationId: string;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, {
    email: `bots-tasks-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Jim',
  });
  sage = await db.bots.createBot({ user_id: user.id, name: 'Sage', role: 'Researcher', instructions: 'Cite sources.' });
  conversationId = (await db.bots.ensureDirectConversation(user.id, sage.id)).session_id;
  await db.sessions.addMessage({
    session_id: conversationId,
    role: 'user',
    content: 'Check these links in the background',
  });
});

async function proposeTask(title = 'Check links') {
  return db.bots.createRequest({
    user_id: user.id,
    session_id: conversationId,
    bot_id: sage.id,
    kind: 'task_start',
    payload: { title, brief: 'Open each link in the list and report which ones are broken.' },
  });
}

describe('background tasks', () => {
  it('starts only from the member’s decision, bound to the Bot, and shows in the task list', async () => {
    const request = await proposeTask();
    const settled = await decideBotRequest(user.id, request.id, { decision: 'approve' }, db);
    expect(settled.status).toBe('resolved');
    const runId = JSON.parse(settled.result!).run_id as string;

    const run = await db.runtime.getRun(runId);
    expect(run).toMatchObject({ kind: 'subagent', status: 'queued', owner_user_id: user.id });
    expect(run!.source_id.startsWith('bottask-')).toBe(true);
    const child = await db.sessions.getById(run!.source_id);
    expect(child).toMatchObject({ channel: 'subagent', parent_session_id: conversationId });
    expect(JSON.parse(child!.metadata)).toMatchObject({
      spawned_by: 'bot_task',
      bot_id: sage.id,
      task_title: 'Check links',
    });

    const tasks = await listConversationTasks(db, user.id, conversationId);
    expect(tasks).toEqual([
      expect.objectContaining({
        run_id: runId,
        bot_id: sage.id,
        title: 'Check links',
        status: 'queued',
        child_session_id: child!.id,
      }),
    ]);
    const rows = await db.sessions.getMessages(conversationId);
    expect(JSON.parse(rows.at(-1)!.bot_event!)).toMatchObject({ kind: 'task_started', run_id: runId, bot_id: sage.id });
    // Another member sees nothing and cannot cancel it.
    const other = await createInternalTestUser(db, { email: `bots-tasks-other-${Date.now()}@test.local` });
    expect(await listConversationTasks(db, other.id, conversationId)).toEqual([]);
    expect(await cancelBotTask(db, other.id, runId)).toBe('not_found');
  });

  it(`runs at most ${MAX_RUNNING_TASKS_PER_MEMBER} at once per member`, async () => {
    for (let i = 0; i < MAX_RUNNING_TASKS_PER_MEMBER; i += 1) {
      await admitBotTask({
        db,
        userId: user.id,
        conversationId,
        bot: sage,
        title: `t${i}`,
        brief: 'b',
        requestId: `req-${i}`,
      });
    }
    await expect(
      admitBotTask({
        db,
        userId: user.id,
        conversationId,
        bot: sage,
        title: 'one too many',
        brief: 'b',
        requestId: 'req-x',
      }),
    ).rejects.toBeInstanceOf(BotTaskError);
  });

  it('executes read-only with the Bot’s identity and context, then reports into the conversation', async () => {
    const { runId } = await admitBotTask({
      db,
      userId: user.id,
      conversationId,
      bot: sage,
      title: 'Check links',
      brief: 'Open each link and report the broken ones.',
      requestId: 'req-exec',
    });
    const workerId = `bots-task-worker-${Date.now()}`;
    const claimed = await db.runtime.claimNextRun({
      run_id: runId,
      worker_id: workerId,
      lease_ms: 60_000,
      kinds: ['subagent'],
    });
    expect(claimed?.id).toBe(runId);

    const seen: { system: string; tools: string[]; prompt: string } = { system: '', tools: [], prompt: '' };
    await createSubagentRuntimeDriver({
      heartbeatIntervalMs: 60_000,
      generate: async ({ system, tools, messages }) => {
        seen.system = system;
        seen.tools = Object.keys(tools ?? {});
        seen.prompt = messages.at(-1)!.content;
        return {
          text: 'Report: 2 of 12 links are broken (a.com, b.com).',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    })({ db, run: claimed!, workerId, leaseMs: 60_000 });

    expect((await db.runtime.getRun(runId))?.status).toBe('succeeded');
    expect(seen.system).toContain('# Background task');
    expect(seen.system).toContain('You are **Sage** — Researcher');
    expect(seen.system).toContain('Cite sources.');
    expect(seen.system).toContain('Check these links in the background'); // context pack excerpt
    expect(seen.prompt).toBe('Open each link and report the broken ones.');
    expect(seen.tools).toContain('conversation');
    for (const writer of [
      'team',
      'bot_tasks',
      'memory',
      'request_takeover',
      'vault',
      'knowledge_mutation',
      'spawn_session',
    ]) {
      expect(seen.tools).not.toContain(writer);
    }

    const rows = await db.sessions.getMessages(conversationId);
    const report = rows.at(-1)!;
    expect(report).toMatchObject({
      role: 'assistant',
      bot_id: sage.id,
      content: 'Report: 2 of 12 links are broken (a.com, b.com).',
    });
    expect(JSON.parse(report.bot_event!)).toEqual({
      kind: 'task_report',
      run_id: runId,
      bot_id: sage.id,
      title: 'Check links',
      status: 'succeeded',
    });
  });

  it('a task whose owner lost the bots feature fails cleanly without running', async () => {
    const { runId } = await admitBotTask({
      db,
      userId: user.id,
      conversationId,
      bot: sage,
      title: 'Check links',
      brief: 'b',
      requestId: 'req-ineligible',
    });
    // Switched off after admission (or on another slot before the cancel landed).
    await db.userFeatures.upsert({ user_id: user.id, feature: 'bots', enabled: false });
    const workerId = `bots-task-worker-${Date.now()}`;
    const claimed = await db.runtime.claimNextRun({
      run_id: runId,
      worker_id: workerId,
      lease_ms: 60_000,
      kinds: ['subagent'],
    });
    const generate = vi.fn();
    await createSubagentRuntimeDriver({ heartbeatIntervalMs: 60_000, generate })({
      db,
      run: claimed!,
      workerId,
      leaseMs: 60_000,
    });
    expect(generate).not.toHaveBeenCalled();
    const run = await db.runtime.getRun(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error_message ?? '').toContain('may no longer use Bots');
    // The failure report waits in the inbox (nothing runs for an ineligible
    // owner) and lands once they have Bots again.
    const queued = await db.bots.listPendingInbox(conversationId);
    expect(queued.map((row) => [row.kind, JSON.parse(row.payload).status])).toEqual([['task_report', 'failed']]);
  });

  it('a canceled queued task reports the cancellation', async () => {
    const { runId } = await admitBotTask({
      db,
      userId: user.id,
      conversationId,
      bot: sage,
      title: 'Slow one',
      brief: 'b',
      requestId: 'req-cancel',
    });
    expect(await cancelBotTask(db, user.id, runId, conversationId)).toBe('canceled');
    expect((await db.runtime.getRun(runId))?.status).toBe('canceled');
    expect(await cancelBotTask(db, user.id, runId)).toBe('finished');
    const rows = await db.sessions.getMessages(conversationId);
    expect(JSON.parse(rows.at(-1)!.bot_event!)).toMatchObject({
      kind: 'task_report',
      run_id: runId,
      status: 'canceled',
    });
  });

  it('a Start whose settle is lost (the Bot was archived meanwhile) leaves no task running', async () => {
    const request = await proposeTask('Lost race');
    // The archive withdraws the card between admission and settle.
    const settleRequest = db.bots.settleRequest.bind(db.bots);
    vi.spyOn(db.bots, 'settleRequest').mockImplementationOnce(async (userId, requestId) => {
      await settleRequest(userId, requestId, 'canceled');
      return undefined;
    });
    await expect(decideBotRequest(user.id, request.id, { decision: 'approve' }, db)).rejects.toMatchObject({
      status: 409,
    });
    const tasks = await listConversationTasks(db, user.id, conversationId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('canceled');
  });

  it('re-admitting an already admitted request replays its Run without counting against the cap', async () => {
    const first = await admitBotTask({
      db,
      userId: user.id,
      conversationId,
      bot: sage,
      title: 'Replayed',
      brief: 'b',
      requestId: 'req-replay',
    });
    for (let i = 1; i < MAX_RUNNING_TASKS_PER_MEMBER; i += 1) {
      await admitBotTask({
        db,
        userId: user.id,
        conversationId,
        bot: sage,
        title: `t${i}`,
        brief: 'b',
        requestId: `r${i}`,
      });
    }
    const again = await admitBotTask({
      db,
      userId: user.id,
      conversationId,
      bot: sage,
      title: 'Replayed',
      brief: 'b',
      requestId: 'req-replay',
    });
    expect(again).toEqual(first);
  });
});
