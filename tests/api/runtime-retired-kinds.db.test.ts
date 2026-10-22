/**
 * Runs of kinds retired in v1.4 (Eval, Mission, Workflow) can never be driven again, so
 * the boot settlement closes any that were still active — with their open steps
 * and pending interrupts — while leaving live kinds untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import { settleRetiredRuntimeRuns } from '../../apps/api/src/runtime/retired-kinds.js';

let db: DatabaseProvider;
let user: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('settleRetiredRuntimeRuns', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `${unique('retired-kinds')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('cancels an active Mission run with its open step and pending interrupt, without notifying', async () => {
    const sourceId = unique('car');
    let mission = await db.runtime.createRun({
      kind: 'mission',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: 'agent_run',
      source_id: sourceId,
      input: { prompt: 'historical' },
    });
    mission = await db.runtime.transitionRun({
      id: mission.id,
      expected_version: mission.version,
      to_status: 'claimed',
      idempotency_key: unique('claim'),
    });
    mission = await db.runtime.transitionRun({
      id: mission.id,
      expected_version: mission.version,
      to_status: 'running',
      idempotency_key: unique('run'),
      projection_only: true,
    });
    const step = await db.runtime.createStep({
      run_id: mission.id,
      step_key: 'sandbox',
      kind: 'mission_runner',
      attempt: 1,
      input: {},
      actor_user_id: user.id,
    });
    const interrupt = await db.runtime.createInterrupt({
      run_id: mission.id,
      kind: 'mutation_approval',
      payload: { source: 'mission_approval' },
      risk_level: 'r1',
      assignee_user_id: user.id,
      actor_user_id: user.id,
      idempotency_key: unique('approval'),
    });
    const evalRun = await db.runtime.createRun({
      kind: 'eval',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: 'eval_run',
      source_id: unique('eval'),
      input: {},
    });
    const workflowRun = await db.runtime.createRun({
      kind: 'workflow',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: 'workflow_run',
      source_id: unique('workflow'),
      input: {},
    });
    const live = await db.runtime.createRun({
      kind: 'subagent',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: 'spawned_session',
      source_id: unique('child'),
      input: {},
    });

    expect(await settleRetiredRuntimeRuns(db)).toBeGreaterThanOrEqual(3);

    const settledMission = await db.runtime.getRun(mission.id);
    expect(settledMission).toMatchObject({ status: 'canceled', error_code: 'runtime_kind_retired' });
    expect(settledMission?.settled_at).toBeTruthy();
    expect((await db.runtime.listSteps(mission.id)).find((s) => s.id === step.id)?.status).toBe('canceled');
    expect((await db.runtime.getInterrupt(interrupt.id))?.status).toBe('canceled');
    expect((await db.runtime.getRun(evalRun.id))?.status).toBe('canceled');
    expect((await db.runtime.getRun(workflowRun.id))?.status).toBe('canceled');
    expect((await db.runtime.getRun(live.id))?.status).toBe('queued');

    // Old runs never page their owner on the way out.
    const terminal = (await db.runtime.listEvents(mission.id)).find(
      (event) => event.type === 'run.status_changed' && JSON.parse(event.payload).result.status === 'canceled',
    );
    expect(JSON.parse(terminal!.payload)).toMatchObject({ notification_policy: 'suppress' });

    // A second boot finds nothing left to do for these runs.
    await settleRetiredRuntimeRuns(db);
    expect((await db.runtime.getRun(mission.id))?.version).toBe(settledMission?.version);
  });
});
