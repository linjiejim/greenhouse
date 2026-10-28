/**
 * An Automation occurrence carried in flight from 1.x keeps the uuid conversation
 * id 1.x minted for it (3.x's migrate-from-1x kept ids verbatim); new occurrences get a
 * `cnv_` id. The driver must accept both when it re-validates the admitted snapshot.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type ScheduledTaskRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { RunAgentResult } from '../../agent-runtime/run-agent.js';
import { createAutomationRuntimeDriver, enqueueAutomationRun } from '../runtime-driver.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;

const unique = (label: string) => `${label}-${Date.now()}-${Math.random()}`;

const result: RunAgentResult = {
  text: 'Durable result',
  usage: { inputTokens: 12, outputTokens: 8 },
  durationMs: 25,
  pipeline: [],
  references: [],
  toolEvidence: [],
  persisted: true,
};

async function scheduledTask(): Promise<ScheduledTaskRow> {
  const owner = await createInternalTestUser(db, { email: `${unique('automation-legacy')}@test.local` });
  return db.scheduledTasks.create({
    user_id: owner.id,
    name: 'Carried briefing',
    profile_id: 'sprouty',
    task_prompt: 'Prepare the briefing.',
    schedule: '0 * * * *',
    timezone: 'UTC',
    max_steps: 5,
  });
}

describe('Automation occurrences carried from 1.x', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('still runs an occurrence carried in flight from 1.x with its uuid conversation', async () => {
    const task = await scheduledTask();
    const scheduledFor = '2026-08-12T02:00:00.000Z';
    const queued = await enqueueAutomationRun({ db, task, trigger: 'cron', scheduledFor });
    // What 1.x minted for the same occurrence (3.x's migrate-from-1x kept ids verbatim).
    const hex = createHash('sha256').update(`automation-session:${task.id}:scheduled:${scheduledFor}`).digest('hex');
    const chars = hex.slice(0, 32).split('');
    chars[12] = '4';
    chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16]!, 16) % 4]!;
    const v = chars.join('');
    const legacy = `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
    await db.executeRaw(sql`
      INSERT INTO conversations
      SELECT (jsonb_populate_record(NULL::conversations, to_jsonb(c) || jsonb_build_object('id', ${legacy}::text))).*
      FROM conversations c WHERE c.id = ${queued.session_id}`);
    await db.executeRaw(sql`
      UPDATE runs SET session_id = ${legacy}, input = jsonb_set(input, '{session_id}', to_jsonb(${legacy}::text))
      WHERE id = ${queued.run.id}`);
    await db.executeRaw(sql`
      UPDATE run_steps SET input = jsonb_set(input, '{session_id}', to_jsonb(${legacy}::text))
      WHERE run_id = ${queued.run.id}`);

    // Boot catch-up admits the same occurrence again: it is the carried one, not a conflict.
    const replay = await enqueueAutomationRun({ db, task, trigger: 'cron', scheduledFor });
    expect(replay.run.id).toBe(queued.run.id);
    expect(replay.session_id).toBe(legacy);

    const workerId = unique('automation-legacy-worker');
    const claimed = await db.runtime.claimNextRun({ worker_id: workerId, lease_ms: 60_000, kinds: ['automation'] });
    expect(claimed?.id).toBe(queued.run.id);
    const executeTask = vi.fn(async () => result);
    await createAutomationRuntimeDriver(
      {},
      { executeTask, heartbeatIntervalMs: 60_000 },
    )({
      db,
      run: claimed!,
      workerId,
      leaseMs: 60_000,
    });
    expect(executeTask).toHaveBeenCalledWith(expect.anything(), legacy, {}, expect.anything());
    expect(await db.runtime.getRun(queued.run.id)).toMatchObject({ status: 'succeeded' });
  });
});
