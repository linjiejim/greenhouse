import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, WorkflowRunRow } from '@greenhouse/db';

const mirrors = vi.hoisted(() => ({ workflow: vi.fn() }));
vi.mock('./adapters.js', () => ({ mirrorWorkflowRun: mirrors.workflow }));

import { startRuntimeReconciler } from './reconciler.js';

describe('Runtime adapter reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrors.workflow.mockResolvedValue(undefined);
  });

  it('backfills every stable-cursor page and isolates a malformed domain row', async () => {
    const workflowA = { id: 'wf_a' } as WorkflowRunRow;
    const workflowB = { id: 'wf_b' } as WorkflowRunRow;
    const listWorkflow = vi
      .fn()
      .mockResolvedValueOnce({ items: [workflowA], next_cursor: { created_at: '2026-01-01T00:00:00Z', id: 'wf_a' } })
      .mockResolvedValueOnce({ items: [workflowB], next_cursor: null });
    mirrors.workflow.mockRejectedValueOnce(new Error('legacy malformed row')).mockResolvedValueOnce(undefined);
    const db = {
      workflows: { listRunsForRuntimeReconciliation: listWorkflow },
    } as unknown as DatabaseProvider;

    const reconciler = await startRuntimeReconciler(db, { intervalMs: 60_000 });
    reconciler.stop();

    expect(listWorkflow).toHaveBeenCalledTimes(2);
    expect(listWorkflow).toHaveBeenLastCalledWith({
      cursor: { created_at: '2026-01-01T00:00:00Z', id: 'wf_a' },
      limit: 200,
    });
    const backfillOptions = { suppressInitialTerminalNotification: true };
    expect(mirrors.workflow).toHaveBeenNthCalledWith(1, db, workflowA, backfillOptions);
    expect(mirrors.workflow).toHaveBeenNthCalledWith(2, db, workflowB, backfillOptions);
  });

  it('restarts a periodic scan at the beginning after reaching its end', async () => {
    const workflow = { id: 'wf_periodic' } as WorkflowRunRow;
    const listWorkflow = vi.fn().mockResolvedValue({ items: [workflow], next_cursor: null });
    const db = {
      workflows: { listRunsForRuntimeReconciliation: listWorkflow },
    } as unknown as DatabaseProvider;
    const reconciler = await startRuntimeReconciler(db, { skipBootReconcile: true, intervalMs: 60_000 });

    await reconciler.reconcileNow();
    await reconciler.reconcileNow();
    reconciler.stop();

    expect(listWorkflow).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 200 });
    expect(listWorkflow).toHaveBeenNthCalledWith(2, { cursor: undefined, limit: 200 });
    expect(mirrors.workflow).toHaveBeenCalledWith(db, workflow, {});
  });

  it('can stop the adapter without reading its domain table', async () => {
    const listWorkflow = vi.fn();
    const db = {
      workflows: { listRunsForRuntimeReconciliation: listWorkflow },
    } as unknown as DatabaseProvider;

    const reconciler = await startRuntimeReconciler(db, {
      adapters: { workflow: false },
      intervalMs: 60_000,
    });
    await reconciler.reconcileNow();
    reconciler.stop();

    expect(listWorkflow).not.toHaveBeenCalled();
    expect(mirrors.workflow).not.toHaveBeenCalled();
  });
});
