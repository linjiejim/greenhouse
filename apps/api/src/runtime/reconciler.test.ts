import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunRow, DatabaseProvider, WorkflowRunRow } from '@greenhouse/db';

const mirrors = vi.hoisted(() => ({ mission: vi.fn(), workflow: vi.fn() }));
vi.mock('./adapters.js', () => ({ mirrorMissionRun: mirrors.mission, mirrorWorkflowRun: mirrors.workflow }));

import { startRuntimeReconciler } from './reconciler.js';

describe('Runtime adapter reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrors.mission.mockResolvedValue(undefined);
    mirrors.workflow.mockResolvedValue(undefined);
  });

  it('backfills every stable-cursor page and isolates a malformed domain row', async () => {
    const missionA = { id: 'car_a' } as AgentRunRow;
    const missionB = { id: 'car_b' } as AgentRunRow;
    const workflow = { id: 'wf_a' } as WorkflowRunRow;
    const listMission = vi
      .fn()
      .mockResolvedValueOnce({ items: [missionA], next_cursor: { created_at: '2026-01-01T00:00:00Z', id: 'car_a' } })
      .mockResolvedValueOnce({ items: [missionB], next_cursor: null });
    const listWorkflow = vi.fn().mockResolvedValue({ items: [workflow], next_cursor: null });
    mirrors.mission.mockRejectedValueOnce(new Error('legacy malformed row')).mockResolvedValueOnce(undefined);
    const db = {
      agentRuns: { listRunsForRuntimeReconciliation: listMission },
      workflows: { listRunsForRuntimeReconciliation: listWorkflow },
    } as unknown as DatabaseProvider;

    const reconciler = await startRuntimeReconciler(db, { intervalMs: 60_000 });
    reconciler.stop();

    expect(listMission).toHaveBeenCalledTimes(2);
    expect(listMission).toHaveBeenLastCalledWith({
      cursor: { created_at: '2026-01-01T00:00:00Z', id: 'car_a' },
      limit: 200,
    });
    const backfillOptions = { suppressInitialTerminalNotification: true };
    expect(mirrors.mission).toHaveBeenNthCalledWith(1, db, missionA, backfillOptions);
    expect(mirrors.mission).toHaveBeenNthCalledWith(2, db, missionB, backfillOptions);
    expect(mirrors.workflow).toHaveBeenCalledWith(db, workflow, backfillOptions);
  });

  it('restarts a periodic scan at the beginning after reaching its end', async () => {
    const mission = { id: 'car_periodic' } as AgentRunRow;
    const workflow = { id: 'wf_periodic' } as WorkflowRunRow;
    const listMission = vi.fn().mockResolvedValue({ items: [mission], next_cursor: null });
    const listWorkflow = vi.fn().mockResolvedValue({ items: [workflow], next_cursor: null });
    const db = {
      agentRuns: { listRunsForRuntimeReconciliation: listMission },
      workflows: { listRunsForRuntimeReconciliation: listWorkflow },
    } as unknown as DatabaseProvider;
    const reconciler = await startRuntimeReconciler(db, { skipBootReconcile: true, intervalMs: 60_000 });

    await reconciler.reconcileNow();
    await reconciler.reconcileNow();
    reconciler.stop();

    expect(listMission).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 200 });
    expect(listMission).toHaveBeenNthCalledWith(2, { cursor: undefined, limit: 200 });
    expect(listWorkflow).toHaveBeenCalledTimes(2);
    expect(mirrors.mission).toHaveBeenCalledWith(db, mission, {});
    expect(mirrors.workflow).toHaveBeenCalledWith(db, workflow, {});
  });

  it('can independently stop one adapter without reading its domain table', async () => {
    const workflow = { id: 'wf_enabled' } as WorkflowRunRow;
    const listMission = vi.fn();
    const listWorkflow = vi.fn().mockResolvedValue({ items: [workflow], next_cursor: null });
    const db = {
      agentRuns: { listRunsForRuntimeReconciliation: listMission },
      workflows: { listRunsForRuntimeReconciliation: listWorkflow },
    } as unknown as DatabaseProvider;

    const reconciler = await startRuntimeReconciler(db, {
      adapters: { mission: false, workflow: true },
      intervalMs: 60_000,
    });
    await reconciler.reconcileNow();
    reconciler.stop();

    expect(listMission).not.toHaveBeenCalled();
    expect(mirrors.mission).not.toHaveBeenCalled();
    expect(listWorkflow).toHaveBeenCalledTimes(2);
    expect(mirrors.workflow).toHaveBeenCalledTimes(2);
  });
});
