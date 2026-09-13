/**
 * Durable Runtime maintenance and outbox delivery worker.
 *
 * A handler is registered per executable kind; unregistered read-model kinds
 * are never claimed. Event delivery is at-least-once with DB leases, and an
 * optional observer can project notifications without coupling Runtime to that
 * module.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseProvider, RuntimeRunRow } from '@greenhouse/db';
import type { RuntimeJsonValue, RuntimeRunKind } from '@greenhouse/types/runtime';
import { logger } from '@greenhouse/utils/logger';
import { connectionManager } from '../ws/connection-manager.js';

const DEFAULT_INTERVAL_MS = 1_000;
const LEASE_MS = 30_000;

export interface RuntimeEventEnvelope {
  event_id: string;
  run_id: string;
  step_id: string | null;
  seq: number;
  type: string;
  payload: RuntimeJsonValue;
  actor_user_id: string | null;
  created_at: string;
}

export interface RuntimeDriverContext {
  db: DatabaseProvider;
  run: RuntimeRunRow;
  workerId: string;
  leaseMs: number;
}

export type RuntimeDriver = (context: RuntimeDriverContext) => Promise<void>;

export interface RuntimeWorkerOptions {
  db: DatabaseProvider;
  onEvent?: (event: RuntimeEventEnvelope) => Promise<void>;
  /** Driver-specific domain projection after the generic stale lease reaper. */
  onRunReclaimed?: (run: RuntimeRunRow) => Promise<void>;
  drivers?: Partial<Record<RuntimeRunKind, RuntimeDriver>>;
  /** Per-process concurrency per registered kind. Defaults to one. */
  driverConcurrency?: Partial<Record<RuntimeRunKind, number>>;
  workerId?: string;
  intervalMs?: number;
  skipBootPass?: boolean;
}

export interface RuntimeWorker {
  runOnce(): Promise<void>;
  stop(): void;
}

function eventEnvelope(raw: string): RuntimeEventEnvelope {
  const parsed = JSON.parse(raw) as Partial<RuntimeEventEnvelope>;
  if (
    typeof parsed.event_id !== 'string' ||
    typeof parsed.run_id !== 'string' ||
    !Number.isSafeInteger(parsed.seq) ||
    typeof parsed.type !== 'string' ||
    typeof parsed.created_at !== 'string'
  ) {
    throw new Error('Runtime outbox payload is malformed');
  }
  return parsed as RuntimeEventEnvelope;
}

function retryAt(attempts: number): string {
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));
  return new Date(Date.now() + delayMs).toISOString();
}

export async function startRuntimeWorker(options: RuntimeWorkerOptions): Promise<RuntimeWorker> {
  const { db } = options;
  const workerId = options.workerId ?? `runtime-api-${process.pid}-${randomUUID().slice(0, 8)}`;
  const driverEntries = Object.entries(options.drivers ?? {}) as Array<[RuntimeRunKind, RuntimeDriver]>;
  const activeDriverCounts = new Map<RuntimeRunKind, number>();
  let running = false;
  let stopped = false;

  const deliverOutbox = async (): Promise<void> => {
    const claimed = await db.runtime.claimOutbox({
      worker_id: workerId,
      lease_ms: LEASE_MS,
      topics: ['runtime.events'],
      limit: 100,
    });
    for (const item of claimed) {
      try {
        const envelope = eventEnvelope(item.payload);
        const run = await db.runtime.getRun(envelope.run_id);
        if (!run) throw new Error(`Runtime run ${envelope.run_id} no longer exists`);
        connectionManager.sendToUser(run.owner_user_id, {
          type: 'runtime:invalidate',
          runId: run.id,
          kind: run.kind,
          eventType: envelope.type,
          seq: envelope.seq,
        });
        connectionManager.broadcastToSuperExcept(run.owner_user_id, {
          type: 'runtime:invalidate',
          runId: run.id,
          kind: run.kind,
          eventType: envelope.type,
          seq: envelope.seq,
        });
        if (options.onEvent) await options.onEvent(envelope);
        await db.runtime.acknowledgeOutbox({
          id: item.id,
          expected_version: item.version,
          worker_id: workerId,
        });
      } catch (error) {
        const failed = await db.runtime.failOutbox({
          id: item.id,
          expected_version: item.version,
          worker_id: workerId,
          error: String(error),
        });
        if (failed.status === 'failed') {
          await db.runtime.retryOutbox({
            id: failed.id,
            expected_version: failed.version,
            available_at: retryAt(failed.attempts),
          });
        } else {
          logger.error('[runtime-worker] event reached dead letter', {
            outboxId: failed.id,
            eventId: failed.event_id,
            error: String(error),
          });
        }
      }
    }
  };

  const driveRegisteredKinds = async (): Promise<void> => {
    for (const [kind, driver] of driverEntries) {
      // A long Eval/Mission execution must not block outbox delivery, stale
      // recovery or another registered kind. Each driver owns its DB lease and
      // heartbeat. The per-kind cap limits local pressure; the database claim
      // remains authoritative across multiple API processes.
      const configured = options.driverConcurrency?.[kind] ?? 1;
      const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 1;
      const availableSlots = Math.max(0, limit - (activeDriverCounts.get(kind) ?? 0));
      for (let slot = 0; slot < availableSlots; slot += 1) {
        const run = await db.runtime.claimNextRun({ worker_id: workerId, lease_ms: LEASE_MS, kinds: [kind] });
        if (!run) break;
        activeDriverCounts.set(kind, (activeDriverCounts.get(kind) ?? 0) + 1);
        void driver({ db, run, workerId, leaseMs: LEASE_MS })
          .catch((error) => {
            logger.error('[runtime-worker] driver failed', { kind, runId: run.id, error: String(error) });
            // The lease remains authoritative. If the driver cannot write a safe
            // terminal state, stale recovery requeues/fails it after expiry.
          })
          .finally(() => {
            const remaining = Math.max(0, (activeDriverCounts.get(kind) ?? 1) - 1);
            if (remaining === 0) activeDriverCounts.delete(kind);
            else activeDriverCounts.set(kind, remaining);
          });
      }
    }
  };

  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const [reclaimed] = await Promise.all([
        db.runtime.reclaimStaleRuns(new Date(), 100),
        db.runtime.expireInterrupts(new Date(), 100),
      ]);
      if (options.onRunReclaimed) {
        for (const run of reclaimed) {
          try {
            await options.onRunReclaimed(run);
          } catch (error) {
            // Runtime is already authoritative. Keep the worker available for
            // the remaining projections and outbox; source boot reconciliation
            // can repair a projection that failed in this pass.
            logger.error('[runtime-worker] reclaimed-run projection failed', {
              kind: run.kind,
              runId: run.id,
              error: String(error),
            });
          }
        }
      }
      await driveRegisteredKinds();
      await deliverOutbox();
    } finally {
      running = false;
    }
  };

  if (!options.skipBootPass) await runOnce();
  const timer = setInterval(
    () => {
      void runOnce().catch((error) => logger.error('[runtime-worker] pass failed', { error: String(error) }));
    },
    Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 250),
  );
  timer.unref();

  return {
    runOnce,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
