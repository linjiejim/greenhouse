import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunRow, DatabaseProvider } from '@greenhouse/db';

import { getCloudAgentController, getMissionRuntimeStatus, initMissionRuntime } from './index.js';
import { containerNameFor, DockerControlPlaneError, type DockerCli } from './docker.js';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

function unavailableDocker(message: string): DockerCli {
  return {
    validateEnvironment: async () => {
      throw new Error(message);
    },
    startContainer: async () => '',
    inspectContainer: async () => null,
    removeContainer: async () => undefined,
    listAgentContainers: async () => [],
    tailLogs: async () => '',
  };
}

describe('Mission runtime admission', () => {
  it('keeps the subsystem disabled when Mission is not enabled', async () => {
    await initMissionRuntime({ env: {}, db: null });
    expect(getMissionRuntimeStatus()).toEqual({ state: 'disabled' });
  });

  it('fails Mission closed without throwing the whole API startup', async () => {
    await expect(
      initMissionRuntime({
        env: { NODE_ENV: 'test', MISSION_ENABLED: 'true' },
        docker: unavailableDocker('Docker runtime is unavailable: runsc'),
        db: null,
      }),
    ).resolves.toBeUndefined();
    expect(getMissionRuntimeStatus()).toEqual({
      state: 'unavailable',
      reason: 'Docker runtime is unavailable: runsc',
      containment: 'unconfirmed',
    });
  });

  it('rejects an unhardened production escape hatch before touching Docker', async () => {
    await expect(
      initMissionRuntime({
        env: {
          NODE_ENV: 'production',
          MISSION_ENABLED: 'true',
          SANDBOX_RUNNER_ALLOW_UNHARDENED: 'true',
        },
        db: null,
      }),
    ).resolves.toBeUndefined();
    expect(getMissionRuntimeStatus()).toMatchObject({ state: 'unavailable' });
  });

  it('terminalizes queued/active runs and revokes relay keys when preflight fails', async () => {
    const queued = { id: 'car_queued', status: 'queued', relay_client_id: null };
    const running = { id: 'car_running', status: 'running', relay_client_id: 'relay_1' };
    const transitions: string[] = [];
    const disabledKeys: string[] = [];
    const removed: string[] = [];
    const db = {
      agentRuns: {
        listQueuedRuns: async () => [queued],
        listActiveRuns: async () => [running],
        transitionRun: async (id: string) => {
          transitions.push(id);
          const row = id === queued.id ? queued : running;
          return { ...row, status: 'failed' };
        },
        appendEvents: async () => 1,
        enqueueOutcome: async () => ({}),
      },
      apiClients: {
        update: async (id: string) => {
          disabledKeys.push(id);
        },
      },
    } as unknown as DatabaseProvider;
    const docker = unavailableDocker('missing egress policy');
    docker.listAgentContainers = async () => [
      { id: 'orphan-container', name: 'greenhouse-cloud-agent-orphan', runId: 'car_orphan' },
    ];
    docker.removeContainer = async (id) => {
      removed.push(id);
    };

    await initMissionRuntime({ env: { NODE_ENV: 'test', MISSION_ENABLED: 'true' }, docker, db });

    expect(transitions).toEqual(['car_queued', 'car_running']);
    expect(disabledKeys).toEqual(['relay_1']);
    expect(removed).toEqual(['greenhouse-cloud-agent-car_running', 'orphan-container']);
    expect(getMissionRuntimeStatus()).toMatchObject({ state: 'unavailable' });
  });

  it('reports unconfirmed containment when Docker cannot enumerate surviving containers', async () => {
    const db = {
      agentRuns: { listQueuedRuns: async () => [], listActiveRuns: async () => [] },
      apiClients: { list: async () => [] },
    } as unknown as DatabaseProvider;
    const docker = unavailableDocker('preflight failed');
    docker.listAgentContainers = async () => {
      throw new Error('Docker daemon timed out');
    };

    await initMissionRuntime({ env: { NODE_ENV: 'test', MISSION_ENABLED: 'true' }, docker, db });

    expect(getMissionRuntimeStatus()).toMatchObject({
      state: 'unavailable',
      containment: 'unconfirmed',
    });
  });

  it('does not confirm containment until an in-flight start drains and its late container is removed', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'mission-runtime-race-'));
    const skillsDir = join(dataRoot, 'skills');
    await mkdir(skillsDir);

    const pendingRun = {
      id: 'car_pending_start',
      user_id: 'user_pending',
      workspace_id: 1,
      status: 'starting',
      prompt: 'Run after the gate opens',
      input_manifest: '[]',
      model: 'kimi-k3',
      fallback_model: null,
      session_id: null,
      max_wall_ms: 60 * 60_000,
      max_requests: 100,
    } as unknown as AgentRunRow;
    const runningRun = {
      id: 'car_control_plane_probe',
      user_id: 'user_running',
      workspace_id: 2,
      status: 'running',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      max_wall_ms: 60 * 60_000,
    } as unknown as AgentRunRow;

    let listActiveCalls = 0;
    let claimed = false;
    const db = {
      users: {
        getById: async (id: string) => ({ id, status: 'active', role: 'team' }),
      },
      agentRuns: {
        listActiveRuns: async () => {
          listActiveCalls += 1;
          // bootSweep reads twice; the explicit tick below is the third read.
          return listActiveCalls === 3 ? [runningRun] : [];
        },
        listQueuedRuns: async () => [],
        claimNextQueuedRun: async () => {
          if (claimed) return undefined;
          claimed = true;
          return pendingRun;
        },
        updateWorkspace: async () => undefined,
        updateRun: async () => undefined,
        transitionRun: async () => undefined,
        getRunById: async () => undefined,
        getWorkspaceById: async () => undefined,
        listUnsettledTerminalRuns: async () => [],
        listRunsMissingOutcome: async () => [],
        listPendingOutcomes: async () => [],
        listArchivableWorkspaces: async () => [],
      },
      apiClients: {
        list: async () => [],
        create: async () => ({ id: 'relay_pending' }),
        update: async () => undefined,
      },
    } as unknown as DatabaseProvider;

    let signalStartEntered!: () => void;
    let releaseStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      signalStartEntered = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let containerLists = 0;
    const removed: string[] = [];
    const docker: DockerCli = {
      validateEnvironment: async () => undefined,
      startContainer: async () => {
        signalStartEntered();
        await startGate;
        return 'late-container-id';
      },
      inspectContainer: async (name) => {
        if (name === containerNameFor(runningRun.id)) {
          throw new DockerControlPlaneError('daemon unavailable during inspect');
        }
        return null;
      },
      removeContainer: async (id) => {
        removed.push(id);
      },
      listAgentContainers: async () => {
        containerLists += 1;
        return [];
      },
      tailLogs: async () => '',
    };

    try {
      await initMissionRuntime({
        env: {
          NODE_ENV: 'test',
          MISSION_ENABLED: 'true',
          SANDBOX_RUNNER_DATA_ROOT: dataRoot,
          SANDBOX_RUNNER_SKILLS_DIR: skillsDir,
        },
        db,
        docker,
      });
      const runtimeController = getCloudAgentController();
      expect(runtimeController).not.toBeNull();
      await startEntered;

      await runtimeController!.tick();

      expect(getMissionRuntimeStatus()).toMatchObject({ state: 'unavailable', containment: 'unconfirmed' });
      expect(containerLists).toBe(1); // boot reconciliation only; quarantine is still behind the barrier
      expect(removed).not.toContain('late-container-id');

      releaseStart();
      await vi.waitFor(() => {
        expect(getMissionRuntimeStatus()).toMatchObject({ state: 'unavailable', containment: 'confirmed' });
      });

      expect(removed).toContain('late-container-id');
      expect(containerLists).toBe(2);
    } finally {
      await initMissionRuntime({ env: {}, db: null });
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
