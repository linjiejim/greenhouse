/** Durable compensation loop for Runtime domain adapters. */

import type { AgentRunReconciliationCursor, DatabaseProvider, WorkflowRunReconciliationCursor } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { mirrorMissionRun, mirrorWorkflowRun, type RuntimeMirrorOptions } from './adapters.js';

const DEFAULT_INTERVAL_MS = 10_000;
const PAGE_SIZE = 200;

export interface RuntimeReconciler {
  reconcileNow(): Promise<void>;
  stop(): void;
}

export interface RuntimeReconcilerOptions {
  intervalMs?: number;
  skipBootReconcile?: boolean;
  /** Independently stop either derived adapter without touching its domain. */
  adapters?: Partial<Record<'mission' | 'workflow', boolean>>;
}

async function reconcileMissionPage(
  db: DatabaseProvider,
  cursor?: AgentRunReconciliationCursor,
  options: RuntimeMirrorOptions = {},
): Promise<AgentRunReconciliationCursor | null> {
  const page = await db.agentRuns.listRunsForRuntimeReconciliation({ cursor, limit: PAGE_SIZE });
  for (const run of page.items) {
    try {
      await mirrorMissionRun(db, run, options);
    } catch (error) {
      logger.error('[runtime-reconciler] Mission mirror failed', { sourceId: run.id, error: String(error) });
    }
  }
  return page.next_cursor;
}

async function reconcileWorkflowPage(
  db: DatabaseProvider,
  cursor?: WorkflowRunReconciliationCursor,
  options: RuntimeMirrorOptions = {},
): Promise<WorkflowRunReconciliationCursor | null> {
  const page = await db.workflows.listRunsForRuntimeReconciliation({ cursor, limit: PAGE_SIZE });
  for (const run of page.items) {
    try {
      await mirrorWorkflowRun(db, run, options);
    } catch (error) {
      logger.error('[runtime-reconciler] Workflow mirror failed', { sourceId: run.id, error: String(error) });
    }
  }
  return page.next_cursor;
}

/** Full boot backfill. Each bad source row is isolated and retried next pass. */
async function reconcileAll(db: DatabaseProvider, adapters: { mission: boolean; workflow: boolean }): Promise<void> {
  const backfillOptions: RuntimeMirrorOptions = { suppressInitialTerminalNotification: true };
  if (adapters.mission) {
    let missionCursor: AgentRunReconciliationCursor | undefined;
    for (;;) {
      const next = await reconcileMissionPage(db, missionCursor, backfillOptions);
      if (!next) break;
      missionCursor = next;
    }
  }
  if (adapters.workflow) {
    let workflowCursor: WorkflowRunReconciliationCursor | undefined;
    for (;;) {
      const next = await reconcileWorkflowPage(db, workflowCursor, backfillOptions);
      if (!next) break;
      workflowCursor = next;
    }
  }
}

export async function startRuntimeReconciler(
  db: DatabaseProvider,
  options: RuntimeReconcilerOptions = {},
): Promise<RuntimeReconciler> {
  const adapters = {
    mission: options.adapters?.mission !== false,
    workflow: options.adapters?.workflow !== false,
  };
  let missionCursor: AgentRunReconciliationCursor | undefined;
  let workflowCursor: WorkflowRunReconciliationCursor | undefined;
  let running = false;

  if (!options.skipBootReconcile) {
    try {
      await reconcileAll(db, adapters);
    } catch (error) {
      // Runtime is a read model in M2. A compensation failure must be visible,
      // but may not take Mission/Workflow execution offline.
      logger.error('[runtime-reconciler] boot backfill failed; periodic compensation remains active', {
        error: String(error),
      });
    }
  }

  const reconcileNow = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const [nextMission, nextWorkflow] = await Promise.all([
        adapters.mission ? reconcileMissionPage(db, missionCursor) : Promise.resolve(null),
        adapters.workflow ? reconcileWorkflowPage(db, workflowCursor) : Promise.resolve(null),
      ]);
      // Reaching the end resets the stable scan. This continuously revisits
      // old active rows whose status changed after their creation page passed.
      missionCursor = nextMission ?? undefined;
      workflowCursor = nextWorkflow ?? undefined;
    } finally {
      running = false;
    }
  };

  const intervalMs = Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 1_000);
  const timer = setInterval(() => {
    void reconcileNow().catch((error) => {
      logger.error('[runtime-reconciler] periodic pass failed', { error: String(error) });
    });
  }, intervalMs);
  timer.unref();

  return {
    reconcileNow,
    stop: () => clearInterval(timer),
  };
}
