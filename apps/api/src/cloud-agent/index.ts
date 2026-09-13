/** Mission control-plane entry backed by the Sandbox Runner. */

import { logger } from '@greenhouse/utils/logger';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';
import { getDb, type AgentRunRow, type DatabaseProvider } from '@greenhouse/db';
import { AGENT_RUN_SERVER_SEQ_BASE } from '@greenhouse/types/cloud-agent';

import { connectionManager } from '../ws/connection-manager.js';
import { isMissionEnabled, loadSandboxRunnerConfig, type SandboxRunnerConfig } from './config.js';
import { containerNameFor, createDockerCli, type DockerCli } from './docker.js';
import { createCloudAgentController, type CloudAgentController } from './controller.js';
import { abortMissionRelayRequests } from './relay-requests.js';
import {
  createUserWorkspaceQuotaVerifier,
  validateWorkspaceQuota,
  type AssertUserWorkspaceQuota,
  type WorkspaceQuotaPosture,
} from './quota-preflight.js';

const TICK_INTERVAL_MS = 30_000;

let controller: CloudAgentController | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let containmentRetryTimer: NodeJS.Timeout | null = null;
let runtimeStatus: MissionRuntimeStatus = { state: 'disabled' };

export type MissionRuntimeStatus =
  | { state: 'disabled' }
  | { state: 'reconciling' }
  | { state: 'unavailable'; reason: string; containment: 'confirmed' | 'unconfirmed' }
  | {
      state: 'ready';
      runtime: string;
      rootFilesystem: 'read-only';
      maxConcurrent: number;
      workspaceQuota: WorkspaceQuotaPosture;
    };

function hostApiPort(apiBase: string, env: NodeJS.ProcessEnv): number {
  const url = new URL(apiBase);
  const raw = env.API_PORT?.trim() || url.port || (url.protocol === 'https:' ? '443' : '80');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('API_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function stopRuntimeLoop(): void {
  controller = null;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  if (containmentRetryTimer) clearTimeout(containmentRetryTimer);
  containmentRetryTimer = null;
}

async function persistQuarantineOutcome(db: DatabaseProvider, run: AgentRunRow, message: string): Promise<void> {
  try {
    await db.agentRuns.appendEvents(run.id, [
      {
        seq: AGENT_RUN_SERVER_SEQ_BASE + 1,
        type: 'run.failed',
        payload: JSON.stringify({ source: 'runtime-admission', error: message }),
      },
    ]);
  } catch (err) {
    logger.error('[mission] failed to persist quarantine event', { runId: run.id, err: String(err) });
  }
  if (!run.session_id) return;
  try {
    const item = await db.agentRuns.enqueueOutcome({
      run_id: run.id,
      session_id: run.session_id,
      message_id: `cloud-agent-outcome:${run.id}`,
      content: `Mission failed: ${message}`,
    });
    try {
      await db.sessions.addMessageOnce(item.message_id, {
        session_id: item.session_id,
        role: 'assistant',
        content: item.content,
      });
      await db.agentRuns.markOutcomeDelivered(run.id);
    } catch (err) {
      await db.agentRuns.markOutcomeFailed(run.id, String(err));
    }
  } catch (err) {
    logger.error('[mission] failed to persist quarantine outcome', { runId: run.id, err: String(err) });
  }
}

async function revokeRelayKey(db: DatabaseProvider, run: AgentRunRow): Promise<void> {
  if (!run.relay_client_id) return;
  try {
    await db.apiClients.update(run.relay_client_id, { status: 'disabled' });
  } catch (err) {
    logger.error('[mission] failed to revoke quarantined relay key', { runId: run.id, err: String(err) });
  }
}

/**
 * Closing Mission admission is an abort, not a drain. Leaving pre-restart
 * runs active would keep their task/relay credentials valid while no reaper
 * owns wall-clock or disk limits. Terminalize first, revoke keys, then make a
 * best-effort container stop; a later healthy boot sweep completes settlement.
 */
async function quarantineMissionRuns(
  db: DatabaseProvider,
  docker: DockerCli,
  failureCode: 'runtime_disabled' | 'runtime_unavailable',
  message: string,
): Promise<boolean> {
  const candidates = new Map<string, AgentRunRow>();
  try {
    for (const run of await db.agentRuns.listQueuedRuns()) candidates.set(run.id, run);
  } catch (err) {
    logger.error('[mission] failed to list queued runs while closing admission', { err: String(err) });
  }
  try {
    for (const run of await db.agentRuns.listActiveRuns()) candidates.set(run.id, run);
  } catch (err) {
    logger.error('[mission] failed to list active runs while closing admission', { err: String(err) });
  }

  for (const run of candidates.values()) {
    abortMissionRelayRequests(run.id, failureCode);
    // Stop the execution plane first. A DB or relay error for one run must not
    // leave this or later containers executing without a reaper.
    if (run.status === 'starting' || run.status === 'running') {
      try {
        await docker.removeContainer(containerNameFor(run.id));
      } catch (err) {
        logger.error('[mission] failed to stop quarantined container', { runId: run.id, err: String(err) });
      }
    }

    let failed: AgentRunRow | undefined;
    try {
      failed = await db.agentRuns.transitionRun(run.id, ['queued', 'starting', 'running'], {
        status: 'failed',
        failure_code: failureCode,
        error: message,
        ended_at: nowIso(),
      });
    } catch (err) {
      logger.error('[mission] failed to terminalize quarantined run', { runId: run.id, err: String(err) });
    }
    await revokeRelayKey(db, failed ?? run);
    if (failed) await persistQuarantineOutcome(db, failed, message);
  }

  // Close relay keys created before the controller checkpointed their id on
  // agent_runs. They still carry the run id in metadata for this recovery.
  try {
    for (const client of await db.apiClients.list()) {
      if (client.channel !== 'relay' || client.status !== 'active') continue;
      const meta = safeJsonParse(client.meta, {}) as { cloud_agent_run_id?: unknown };
      if (typeof meta.cloud_agent_run_id !== 'string') continue;
      abortMissionRelayRequests(meta.cloud_agent_run_id, failureCode);
      try {
        await db.apiClients.update(client.id, { status: 'disabled' });
      } catch (err) {
        logger.error('[mission] failed to revoke orphan relay key while admission is closed', {
          clientId: client.id,
          err: String(err),
        });
      }
    }
  } catch (err) {
    logger.error('[mission] failed to list relay keys while closing admission', { err: String(err) });
  }

  // Crash-window orphans may have a labeled container but no active DB row.
  // Admission-closed means none may survive, regardless of earlier DB errors.
  let containmentConfirmed = true;
  try {
    for (const container of await docker.listAgentContainers()) {
      try {
        await docker.removeContainer(container.id);
      } catch (err) {
        containmentConfirmed = false;
        logger.error('[mission] failed to stop orphan container while admission is closed', {
          containerId: container.id,
          runId: container.runId,
          err: String(err),
        });
      }
    }
  } catch (err) {
    containmentConfirmed = false;
    logger.error('[mission] failed to list containers while closing admission', { err: String(err) });
  }
  return containmentConfirmed;
}

function scheduleContainmentRetry(
  db: DatabaseProvider,
  docker: DockerCli,
  failureCode: 'runtime_disabled' | 'runtime_unavailable',
  message: string,
): void {
  if (containmentRetryTimer) return;
  containmentRetryTimer = setTimeout(() => {
    containmentRetryTimer = null;
    void quarantineMissionRuns(db, docker, failureCode, message)
      .then((confirmed) => {
        if (runtimeStatus.state !== 'unavailable') return;
        runtimeStatus = { ...runtimeStatus, containment: confirmed ? 'confirmed' : 'unconfirmed' };
        if (confirmed) logger.info('[mission] execution-plane containment confirmed after retry');
        else scheduleContainmentRetry(db, docker, failureCode, message);
      })
      .catch((err) => {
        logger.error('[mission] containment retry failed', { err: String(err) });
        scheduleContainmentRetry(db, docker, failureCode, message);
      });
  }, TICK_INTERVAL_MS);
  containmentRetryTimer.unref();
}

export async function initMissionRuntime(
  options: {
    env?: NodeJS.ProcessEnv;
    docker?: DockerCli;
    /** Unit-test seam; production defaults to the initialized provider. */
    db?: DatabaseProvider | null;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const docker = options.docker ?? createDockerCli();
  const db = options.db === undefined ? getDb() : options.db;
  if (!isMissionEnabled(env)) {
    runtimeStatus = { state: 'disabled' };
    stopRuntimeLoop();
    if (db) {
      try {
        const confirmed = await quarantineMissionRuns(
          db,
          docker,
          'runtime_disabled',
          'Mission runtime was disabled by configuration',
        );
        if (!confirmed) {
          runtimeStatus = {
            state: 'unavailable',
            reason: 'Mission is disabled but execution-plane containment is not confirmed',
            containment: 'unconfirmed',
          };
          scheduleContainmentRetry(db, docker, 'runtime_disabled', 'Mission runtime was disabled by configuration');
        }
      } catch (err) {
        // Public runner/relay guards consult runtimeStatus, so credentials are
        // closed even when this DB cleanup must be retried on the next boot.
        logger.error('[mission] failed to quarantine runs while disabling runtime', { err: String(err) });
      }
    }
    logger.info('[mission] disabled (set MISSION_ENABLED=1 to enable)');
    return;
  }

  let config: SandboxRunnerConfig;
  let workspaceQuota: WorkspaceQuotaPosture;
  let assertUserWorkspaceQuota: AssertUserWorkspaceQuota;
  try {
    config = loadSandboxRunnerConfig(env);
    workspaceQuota = await validateWorkspaceQuota(config, env);
    assertUserWorkspaceQuota = createUserWorkspaceQuotaVerifier(config, env, workspaceQuota);
    await docker.validateEnvironment?.({
      image: config.image,
      network: config.network,
      runtime: config.dockerRuntime,
      requireEgressPolicy: config.requireHardenedRuntime,
      apiPort: hostApiPort(config.apiBase, env),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    runtimeStatus = { state: 'unavailable', reason, containment: 'unconfirmed' };
    stopRuntimeLoop();
    if (db) {
      try {
        const confirmed = await quarantineMissionRuns(
          db,
          docker,
          'runtime_unavailable',
          'Mission runtime failed its isolation preflight',
        );
        runtimeStatus = { state: 'unavailable', reason, containment: confirmed ? 'confirmed' : 'unconfirmed' };
        if (!confirmed) {
          scheduleContainmentRetry(db, docker, 'runtime_unavailable', 'Mission runtime failed its isolation preflight');
        }
      } catch (cleanupErr) {
        logger.error('[mission] failed to quarantine runs after preflight failure', { err: String(cleanupErr) });
      }
    }
    // Mission is fail-closed, but a missing host runtime must not take down
    // Chat, Knowledge, CRM and the rest of the internal platform.
    logger.error('[mission] Sandbox Runner unavailable; Mission admission is closed', { reason });
    return;
  }

  const nextController = createCloudAgentController({
    db: db ?? getDb(),
    docker,
    config,
    notify: (userId, event) => connectionManager.sendToUser(userId, event),
    onExecutionPlaneFailure: (err) => {
      if (runtimeStatus.state === 'unavailable') return;
      const reason = 'Mission lost contact with the Sandbox Runner control plane';
      // Admission closes synchronously, but containment may only inspect and
      // report success after every claim/docker-start that was already in
      // flight has drained. A late `docker run` success tears itself down in
      // the controller before this promise resolves.
      const admissionDrained = nextController.closeAdmission();
      runtimeStatus = { state: 'unavailable', reason, containment: 'unconfirmed' };
      stopRuntimeLoop();
      logger.error('[mission] Docker control plane failed; Mission admission is closed', { err: String(err) });
      if (db) {
        void admissionDrained
          .then(() =>
            quarantineMissionRuns(db, docker, 'runtime_unavailable', 'Mission runtime lost execution-plane control'),
          )
          .then((confirmed) => {
            if (runtimeStatus.state !== 'unavailable') return;
            runtimeStatus = { ...runtimeStatus, containment: confirmed ? 'confirmed' : 'unconfirmed' };
            if (!confirmed) {
              scheduleContainmentRetry(
                db,
                docker,
                'runtime_unavailable',
                'Mission runtime lost execution-plane control',
              );
            }
          })
          .catch((cleanupErr) =>
            logger.error('[mission] failed to quarantine after Docker control-plane failure', {
              err: String(cleanupErr),
            }),
          );
      }
    },
    assertUserWorkspaceQuota,
  });
  runtimeStatus = { state: 'reconciling' };
  try {
    // Keep every public/task/relay gate closed until stale runs, credentials
    // and containers from the previous process have been reconciled.
    await nextController.bootSweep({ pump: false });
  } catch (err) {
    const reason = `Mission boot reconciliation failed: ${String(err)}`;
    runtimeStatus = { state: 'unavailable', reason, containment: 'unconfirmed' };
    stopRuntimeLoop();
    if (db) {
      const confirmed = await quarantineMissionRuns(
        db,
        docker,
        'runtime_unavailable',
        'Mission runtime reconciliation failed',
      );
      runtimeStatus = { state: 'unavailable', reason, containment: confirmed ? 'confirmed' : 'unconfirmed' };
      if (!confirmed) {
        scheduleContainmentRetry(db, docker, 'runtime_unavailable', 'Mission runtime reconciliation failed');
      }
    }
    logger.error('[mission] reconciliation failed; Mission admission is closed', { reason });
    return;
  }
  controller = nextController;
  runtimeStatus = {
    state: 'ready',
    runtime: config.dockerRuntime ?? 'daemon-default',
    rootFilesystem: 'read-only',
    maxConcurrent: config.maxConcurrent,
    workspaceQuota,
  };
  logger.info('[mission] enabled', {
    image: config.image,
    network: config.network,
    maxConcurrent: config.maxConcurrent,
    dataRoot: config.dataRoot,
    runtime: config.dockerRuntime ?? 'daemon-default',
    hardened: config.requireHardenedRuntime,
    workspaceQuota: workspaceQuota.mode,
  });

  // Reconciliation intentionally did not admit queued work. Only after every
  // runtime-facing guard sees ready may the first container start.
  void controller.pump().catch((err) => logger.error('[mission] initial pump failed', { err: String(err) }));
  tickTimer = setInterval(() => {
    void controller?.tick().catch((err) => logger.error('[mission] tick failed', { err: String(err) }));
  }, TICK_INTERVAL_MS);
  tickTimer.unref();
}

/** Null when the subsystem is disabled — routes must 503 in that case. */
export function getCloudAgentController(): CloudAgentController | null {
  return controller;
}

export function getMissionRuntimeStatus(): MissionRuntimeStatus {
  return runtimeStatus;
}

/** Test seam: install a controller without env/docker requirements. */
export function _setCloudAgentController(next: CloudAgentController | null): void {
  controller = next;
  runtimeStatus = next
    ? {
        state: 'ready',
        runtime: 'test',
        rootFilesystem: 'read-only',
        maxConcurrent: 1,
        workspaceQuota: { mode: 'monitor-only' },
      }
    : { state: 'disabled' };
}

/** Compatibility export for older boot code/tests. */
export const initCloudAgent = initMissionRuntime;
