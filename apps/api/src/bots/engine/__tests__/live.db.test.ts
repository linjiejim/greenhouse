/**
 * LIVE check of the Bots engine with the deployment's real model (skipped
 * unless BOTS_LIVE=1). Loads the repo-root `.env` for the LLM keys and runs
 * real chains against the test database:
 * - a DM: the owner Bot answers;
 * - a group: the lead hands the writing to a second Bot via team.ask, which
 *   answers; rows carry bot_id / bot_event, and the run ends with one finish.
 *
 *   BOTS_LIVE=1 TEST_DATABASE_URL=… npx vitest run --project db apps/api/src/bots/engine/__tests__/live.db.test.ts
 */

import { resolve } from 'node:path';
import { config } from 'dotenv';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { chatRunRegistry, type ChatRunEvent } from '../../../chat/runs.js';
import { runBotsRun } from '../chain.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

const LIVE = process.env.BOTS_LIVE === '1';

let db: DatabaseProvider;
let user: UserRow;

beforeAll(() => {
  if (LIVE) config({ path: resolve(__dirname, '../../../../../../.env'), override: false });
});

beforeEach(async () => {
  if (!LIVE) return;
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, {
    email: `bots-live-${Date.now()}@test.local`,
    nickname: 'Jim',
    role: 'team',
  });
  await db.users.update(user.id, { locale: 'zh' });
});

async function run(sessionId: string, mentions: string[] = []) {
  const claimed = chatRunRegistry.claim(sessionId, user.id)!;
  const events: ChatRunEvent[] = [];
  claimed.subscribe(-1, { onEvent: (event) => events.push(event), onEnd: () => undefined });
  const latest = await db.sessions.getLatestMessage(sessionId);
  await runBotsRun({
    run: claimed,
    userId: user.id,
    sessionId,
    toolRegistry: {},
    trigger: { kind: 'message', reason: 'user', mentions },
    triggerKey: latest!.id,
    db,
  });
  return events;
}

function summary(events: ChatRunEvent[]) {
  return events
    .filter((e) => ['bot-turn-start', 'bot-turn-end', 'finish', 'error'].includes(e.type))
    .map(
      (e) =>
        `${e.type}${e.bot_id ? `:${String(e.bot_id)}` : ''}${e.reason ? `:${String(e.reason)}` : ''}${e.status ? `:${String(e.status)}` : ''}`,
    );
}

describe.skipIf(!LIVE)('Bots engine — live model', () => {
  it('a DM answers in the Bot’s voice', async () => {
    const ivy = await db.bots.createBot({ user_id: user.id, name: '小青', role: '总管', instructions: '回答简洁。' });
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await db.sessions.addMessage({ session_id: dm.session_id, role: 'user', content: '用一句话介绍一下你自己。' });

    const events = await run(dm.session_id);
    const rows = await db.sessions.getMessages(dm.session_id);
    console.info('[bots-live] DM events', summary(events));
    console.info('[bots-live] DM reply', rows.at(-1)?.content);

    expect(summary(events)).toEqual([`bot-turn-start:${ivy.id}:user`, `bot-turn-end:${ivy.id}:completed`, 'finish']);
    expect(rows.at(-1)).toMatchObject({ role: 'assistant', bot_id: ivy.id });
    expect(rows.at(-1)!.content.length).toBeGreaterThan(4);
  }, 120_000);

  it('a group: the lead hands the writing to the writer, who answers', async () => {
    const ivy = await db.bots.createBot({
      user_id: user.id,
      name: '小青',
      role: '总管',
      instructions:
        '你是协调者，自己从不写文案。凡是写作类请求（口号、文案、润色），必须用 team 工具的 ask 动作交给「小文」，并在交接说明里写清楚要求；交接后不要自己写。',
    });
    const fern = await db.bots.createBot({
      user_id: user.id,
      name: '小文',
      role: '写手',
      instructions: '你是写手，产出简短有力的中文文案。',
    });
    const group = await db.bots.createGroupConversation({
      user_id: user.id,
      bot_ids: [ivy.id, fern.id],
      title: '新品发布',
    });
    await db.sessions.addMessage({
      session_id: group.session_id,
      role: 'user',
      content: '请为我们的新产品「温室」写一句不超过 12 个字的中文口号。',
    });

    const events = await run(group.session_id);
    const rows = await db.sessions.getMessages(group.session_id);
    console.info('[bots-live] group events', summary(events));
    for (const row of rows)
      console.info(
        `[bots-live] #${row.seq} ${row.role} ${row.bot_id ?? '-'} ${row.bot_event ?? ''} :: ${row.content.slice(0, 200)}`,
      );

    const ask = rows.find((row) => row.bot_event && JSON.parse(row.bot_event).kind === 'ask');
    expect(ask).toBeDefined();
    expect(JSON.parse(ask!.bot_event!)).toEqual({ kind: 'ask', from: ivy.id, to: fern.id });
    expect(rows.some((row) => row.role === 'assistant' && row.bot_id === fern.id)).toBe(true);
    const flow = summary(events);
    expect(flow[0]).toBe(`bot-turn-start:${ivy.id}:user`);
    expect(flow).toContain(`bot-turn-start:${fern.id}:ask`);
    expect(flow.filter((line) => line === 'finish')).toHaveLength(1);
    expect(flow.at(-1)).toBe('finish');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 240_000);
});
