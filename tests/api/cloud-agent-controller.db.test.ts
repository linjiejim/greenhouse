/**
 * Cloud Agent controller integration tests.
 *
 * Queue admission (global cap + per-user serialization), container lifecycle
 * transitions, cancel/complete finalization (relay key disabled, container
 * removed), the reaper, and the boot sweep — against a real PostgreSQL
 * database with a fake Docker CLI.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { AgentRunRow, DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

import { AGENT_RUN_SERVER_SEQ_BASE } from '@greenhouse/types/cloud-agent';
import { createCloudAgentController } from '../../apps/api/src/cloud-agent/controller.js';
import { WorkspaceQuotaAttestationError } from '../../apps/api/src/cloud-agent/quota-preflight.js';
import { runInputsDirFor, workspaceDirsFor } from '../../apps/api/src/cloud-agent/workspace.js';
import type { CloudAgentConfig } from '../../apps/api/src/cloud-agent/config.js';
import { containerNameFor, type DockerCli, type StartContainerSpec } from '../../apps/api/src/cloud-agent/docker.js';

class FakeDocker implements DockerCli {
  started: StartContainerSpec[] = [];
  removed: string[] = [];
  states = new Map<string, { running: boolean; exitCode: number }>();
  failNextStart: string | Error | null = null;
  failNextRemove: Error | null = null;
  private counter = 0;

  async startContainer(spec: StartContainerSpec): Promise<string> {
    if (this.failNextStart) {
      const failure = this.failNextStart;
      this.failNextStart = null;
      throw typeof failure === 'string' ? new Error(failure) : failure;
    }
    this.started.push(spec);
    const id = `fake-container-${++this.counter}`;
    this.states.set(containerNameFor(spec.runId), { running: true, exitCode: 0 });
    return id;
  }

  async inspectContainer(nameOrId: string) {
    return this.states.get(nameOrId) ?? null;
  }

  async removeContainer(nameOrId: string): Promise<void> {
    if (this.failNextRemove) {
      const err = this.failNextRemove;
      this.failNextRemove = null;
      throw err;
    }
    this.removed.push(nameOrId);
    this.states.delete(nameOrId);
  }

  async listAgentContainers() {
    return [...this.states.keys()].map((name) => ({
      id: name,
      name,
      runId: name.replace('greenhouse-cloud-agent-', ''),
    }));
  }

  async tailLogs(): Promise<string> {
    return 'fake logs';
  }
}

let db: DatabaseProvider;
let user: UserRow;
let docker: FakeDocker;
let config: CloudAgentConfig;
const assertUserWorkspaceQuota = async () => undefined;

function makeController() {
  return createCloudAgentController({ db, docker, config, assertUserWorkspaceQuota });
}

async function enqueue(controller: ReturnType<typeof makeController>, owner = user) {
  return controller.enqueueRun(owner.id, {
    title: 'Task',
    prompt: 'Do the thing',
    model: 'kimi-k3',
    fallbackModel: 'pro',
  });
}

describe('Cloud Agent controller', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `ca-${Date.now()}-${Math.random()}@test.local` });
    docker = new FakeDocker();
    config = {
      dataRoot: await mkdtemp(join(tmpdir(), 'cloud-agent-test-')),
      image: 'greenhouse/agent-runtime:test',
      apiBase: 'http://host.docker.internal:3101',
      maxConcurrent: 2,
      network: 'cloud-agent',
      skillsDir: null,
      memory: '1.5g',
      cpus: '2',
      dockerRuntime: 'runsc',
      requireHardenedRuntime: true,
      userDiskQuotaBytes: 5 * 1024 * 1024 * 1024,
      userInodeQuota: 25_000,
      hardQuotaMarkerPath: '/tmp/greenhouse-test-quota-marker.json',
      quotaAttestCommand: '/usr/local/sbin/greenhouse-sandbox-runner-quota',
      archiveAfterDays: 14,
      defaultModel: 'kimi-k3',
      fallbackModel: 'pro',
    };
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('pump starts a queued run: dirs + prompt file, relay key, container env', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await controller.pump();

    const started = (await db.agentRuns.getRunById(run.id))!;
    expect(started.status).toBe('running');
    expect(started.container_id).toBe('fake-container-1');
    expect(started.relay_client_id).toBeTruthy();

    // Relay key is a real api_clients row scoped to the run's models.
    const client = (await db.apiClients.getById(started.relay_client_id!))!;
    expect(client.channel).toBe('relay');
    expect(client.user_id).toBe(user.id);
    expect(JSON.parse(client.meta).allowed_models).toEqual(['kimi-k3', 'pro']);

    // Container spec: workspace + session mounts, run-scoped credentials only.
    expect(docker.started).toHaveLength(1);
    const spec = docker.started[0]!;
    expect(spec.image).toBe('greenhouse/agent-runtime:test');
    expect(spec.runtime).toBe('runsc');
    expect(spec.network).toBe('cloud-agent');
    expect(spec.mounts.map((m) => m.container)).toEqual(['/workspace', '/session']);
    expect(spec.env.GREENHOUSE_RUN_ID).toBe(run.id);
    expect(spec.env.GREENHOUSE_TASK_TOKEN.startsWith('lpct_')).toBe(true);
    expect(spec.env.GREENHOUSE_RELAY_KEY.startsWith('lpai_sk_')).toBe(true);
    expect(spec.env.GREENHOUSE_MODEL).toBe('kimi-k3');
    expect(spec.env.GREENHOUSE_FALLBACK_MODEL).toBe('pro');

    // Prompt landed in the session dir (per-run file); artifacts dir pre-created.
    const sessionMount = spec.mounts.find((m) => m.container === '/session')!;
    expect(await readFile(join(sessionMount.host, `prompt-${run.id}.md`), 'utf8')).toBe('Do the thing');
    expect(spec.env.GREENHOUSE_PROMPT_PATH).toBe(`/session/prompt-${run.id}.md`);
    const workspaceMount = spec.mounts.find((m) => m.container === '/workspace')!;
    await expect(access(join(workspaceMount.host, 'artifacts'))).resolves.toBeUndefined();
    // Dirs are workspace-keyed so follow-up runs mount the same pair.
    expect(sessionMount.host).toContain(`ws-${run.workspace_id}`);
  });

  it('fails only the unverified user before creating a run and keeps other user admission open', async () => {
    const blocked = await createInternalTestUser(db, { email: `ca-unverified-${Date.now()}@test.local` });
    const controller = createCloudAgentController({
      db,
      docker,
      config,
      assertUserWorkspaceQuota: async (userId) => {
        if (userId === blocked.id) throw new WorkspaceQuotaAttestationError();
      },
    });

    await expect(enqueue(controller, blocked)).rejects.toBeInstanceOf(WorkspaceQuotaAttestationError);
    expect(await db.agentRuns.listRunsByUser(blocked.id)).toEqual([]);

    const admitted = await enqueue(controller, user);
    expect(admitted.user_id).toBe(user.id);
  });

  it('re-attests a queued user immediately before Docker and records a stable scoped failure', async () => {
    let checks = 0;
    const controller = createCloudAgentController({
      db,
      docker,
      config,
      assertUserWorkspaceQuota: async () => {
        checks += 1;
        if (checks > 1) throw new WorkspaceQuotaAttestationError();
      },
    });

    const run = await enqueue(controller);
    await controller.pump();

    const failed = (await db.agentRuns.getRunById(run.id))!;
    expect(checks).toBe(2);
    expect(failed.status).toBe('failed');
    expect(failed.failure_code).toBe('workspace_quota_unverified');
    expect(docker.started).toHaveLength(0);
  });

  it('mission runs converse through a session: user turn at enqueue, assistant turn at completion, follow-up reuses the workspace', async () => {
    const controller = makeController();
    const session = await db.sessions.create('Mission', 'sprouty-mission', user.id, undefined, 'mission');

    const first = await controller.enqueueRun(user.id, {
      title: 'Mission',
      prompt: 'Build the report',
      model: 'kimi-k3',
      fallbackModel: 'pro',
      sessionId: session.id,
    });
    expect(first.session_id).toBe(session.id);
    let msgs = await db.sessions.getMessages(session.id);
    expect(msgs.map((m) => m.role)).toEqual(['user']);
    expect(msgs[0]!.content).toBe('Build the report');

    await controller.pump();
    await db.agentRuns.createArtifact({
      run_id: first.id,
      path: 'report.md',
      size_bytes: 10,
      content_type: 'text/markdown',
      sha256: 'b'.repeat(64),
      storage_key: `cloud-agent/${first.id}/report.md`,
    });
    await controller.handleRunnerCompletion(first.id, { status: 'completed', result_summary: 'Report done' });

    msgs = await db.sessions.getMessages(session.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toContain('Report done');
    expect(msgs[1]!.content).toContain('```mission-artifacts');
    expect(msgs[1]!.content).toContain('"path":"report.md"');

    // Follow-up: same workspace, new run, context continuity via /session.
    const second = await controller.enqueueRun(user.id, {
      title: 'Mission',
      prompt: 'Now translate it',
      model: 'kimi-k3',
      fallbackModel: 'pro',
      workspaceId: first.workspace_id,
      sessionId: session.id,
    });
    expect(second.workspace_id).toBe(first.workspace_id);
    await controller.pump();
    const secondSpec = docker.started.find((s) => s.runId === second.id)!;
    const firstSpec = docker.started.find((s) => s.runId === first.id)!;
    expect(secondSpec.mounts.find((m) => m.container === '/session')!.host).toBe(
      firstSpec.mounts.find((m) => m.container === '/session')!.host,
    );

    // A canceled follow-up still closes its conversation turn.
    const canceled = await controller.cancelRun(second.id);
    expect(canceled!.status).toBe('canceled');
    msgs = await db.sessions.getMessages(session.id);
    expect(msgs.at(-1)!.content).toContain('Mission canceled');
  });

  it('tool-dispatched runs write no user turn, but still deliver the assistant outcome', async () => {
    const controller = makeController();
    // An ORDINARY chat (channel 'web'), where the user already spoke for
    // themselves and the task card shows the prompt — session-modes spec D5.
    const session = await db.sessions.create('Chat', 'sprouty-quick', user.id);
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: '帮我跑个报告' });

    const run = await controller.enqueueRun(user.id, {
      title: 'Report',
      prompt: 'Write the report into report.md',
      model: 'kimi-k3',
      fallbackModel: 'pro',
      sessionId: session.id,
    });
    expect(run.session_id).toBe(session.id);

    // No second, fabricated user message.
    let msgs = await db.sessions.getMessages(session.id);
    expect(msgs.map((m) => m.role)).toEqual(['user']);
    expect(msgs[0]!.content).toBe('帮我跑个报告');

    await controller.pump();
    await controller.handleRunnerCompletion(run.id, { status: 'completed', result_summary: 'Report done' });

    msgs = await db.sessions.getMessages(session.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toContain('Report done');
  });

  it('promotes a chat attachment into the sandbox without copying the object', async () => {
    const { putObjectAtKey, getObjectAtKey } = await import('../../apps/api/src/storage/uploads.js');
    const controller = makeController();
    // An ordinary chat, the dispatch-card path.
    const session = await db.sessions.create('Chat', 'sprouty-quick', user.id);
    const storageKey = `chat-files/${user.id}/${Date.now()}/report.csv`;
    await putObjectAtKey(storageKey, Buffer.from('x,y\n1,2\n'), 'text/csv');
    const file = await db.chatFiles.create({
      session_id: session.id,
      name: 'report.csv',
      content_type: 'text/csv',
      size: 8,
      storage_key: storageKey,
      source: 'user',
      created_by: user.id,
    });

    const run = await controller.enqueueRun(user.id, {
      title: 'Crunch it',
      prompt: 'Summarize ./inputs/report.csv',
      model: 'kimi-k3',
      fallbackModel: 'pro',
      sessionId: session.id,
      attachments: [{ id: file.id, name: file.name }],
    });

    // The bytes are in a controller-owned per-run directory, not in the
    // sandbox-writable workspace tree.
    const inputDir = runInputsDirFor(config.dataRoot, user.id, run.workspace_id, run.id);
    expect(await readFile(join(inputDir, 'report.csv'), 'utf8')).toBe('x,y\n1,2\n');
    // …and the object store still holds exactly ONE copy, under the original key.
    expect((await getObjectAtKey(storageKey))?.buffer.toString('utf8')).toBe('x,y\n1,2\n');
    expect((await db.chatFiles.getById(file.id))!.storage_key).toBe(storageKey);

    // No fabricated user turn on the tool path, and the chip carries the id.
    const msgs = await db.sessions.getMessages(session.id);
    expect(msgs).toHaveLength(0);
  });

  it('materializes attachments into workspace inputs/ and annotates prompt + message', async () => {
    const { putObjectAtKey, getObjectAtKey } = await import('../../apps/api/src/storage/uploads.js');
    const controller = makeController();
    const session = await db.sessions.create('Mission', 'sprouty-mission', user.id, undefined, 'mission');

    const key = `cloud-agent/attachments/${user.id}/${randomUUID()}/data.csv`;
    await putObjectAtKey(key, Buffer.from('a,b\n1,2\n'), 'text/csv');

    const run = await controller.enqueueRun(user.id, {
      title: 'With file',
      prompt: 'Analyze the attached CSV',
      model: 'kimi-k3',
      fallbackModel: 'pro',
      sessionId: session.id,
      attachments: [{ key, name: 'data.csv' }],
    });

    // File landed outside the sandbox-writable workspace tree.
    const inputDir = runInputsDirFor(config.dataRoot, user.id, run.workspace_id, run.id);
    expect(await readFile(join(inputDir, 'data.csv'), 'utf8')).toBe('a,b\n1,2\n');
    // The staging blob is KEPT (it used to be deleted here): the conversation
    // outlives the workspace and renders its inputs as downloadable chips.
    expect((await getObjectAtKey(key))?.buffer.toString('utf8')).toBe('a,b\n1,2\n');

    // Runner prompt carries the inputs note; the chat message carries the
    // machine-readable chip fence the web renders as pills.
    expect(run.prompt).toContain('./inputs/: data.csv');
    const msgs = await db.sessions.getMessages(session.id);
    expect(msgs[0]!.content).toContain('Analyze the attached CSV');
    // The writer emits ```attachments now; ```mission-attachments stays
    // READABLE for the messages already written under the old name.
    const fence = /```attachments\n([\s\S]*?)```/.exec(msgs[0]!.content);
    expect(fence).not.toBeNull();
    expect(JSON.parse(fence![1])).toEqual([
      { key, name: 'data.csv', size_bytes: 8, content_type: 'application/octet-stream' },
    ]);

    await controller.pump();
    const inputMount = docker.started[0]!.mounts.find((mount) => mount.container === '/workspace/inputs');
    expect(inputMount).toEqual({ host: inputDir, container: '/workspace/inputs', readonly: true });
  });

  it('mounts inputs/ for a run whose only staged file is the launch conversation', async () => {
    // The transcript is deliberately NOT an attachment, so `input_manifest` is
    // empty here. Deciding the bind mount from the manifest would leave the
    // runner prompt pointing at a path that was never mounted.
    const controller = makeController();
    const session = await db.sessions.create(undefined, undefined, user.id);
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'check reddit for hydroponics' });
    await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: 'Read 5 threads.' });

    const run = await controller.enqueueRun(user.id, {
      title: 'Report',
      prompt: '输出分析报告',
      model: 'kimi-k3',
      fallbackModel: null,
      sessionId: session.id,
      writeUserTurn: true,
    });
    expect(run.input_manifest).toBe('[]');
    expect(run.prompt).toContain('./inputs/conversation.md');

    await controller.pump();
    const inputDir = runInputsDirFor(config.dataRoot, user.id, run.workspace_id, run.id);
    expect(docker.started[0]!.mounts.find((mount) => mount.container === '/workspace/inputs')).toEqual({
      host: inputDir,
      container: '/workspace/inputs',
      readonly: true,
    });
    expect(await readFile(join(inputDir, 'conversation.md'), 'utf8')).toContain('check reddit for hydroponics');
  });

  it('does not let a persisted workspace symlink redirect host-side attachment writes', async () => {
    const { putObjectAtKey } = await import('../../apps/api/src/storage/uploads.js');
    const controller = makeController();
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'Host sentinel' });
    const { workspaceDir } = workspaceDirsFor(config.dataRoot, user.id, workspace.id);
    const legacyInputs = join(workspaceDir, 'inputs');
    await mkdir(legacyInputs, { recursive: true });
    const hostDir = await mkdtemp(join(tmpdir(), 'cloud-agent-input-sentinel-'));
    const sentinel = join(hostDir, 'sentinel.txt');
    await writeFile(sentinel, 'DO NOT OVERWRITE', 'utf8');
    await symlink(sentinel, join(legacyInputs, 'data.csv'));

    const key = `cloud-agent/attachments/${user.id}/${randomUUID()}/data.csv`;
    await putObjectAtKey(key, Buffer.from('safe,new,data\n'), 'text/csv');
    const run = await controller.enqueueRun(user.id, {
      title: 'Safe input',
      prompt: 'Read data.csv',
      model: 'kimi-k3',
      fallbackModel: null,
      workspaceId: workspace.id,
      attachments: [{ key, name: 'data.csv' }],
    });

    expect(await readFile(sentinel, 'utf8')).toBe('DO NOT OVERWRITE');
    const inputDir = runInputsDirFor(config.dataRoot, user.id, workspace.id, run.id);
    expect(await readFile(join(inputDir, 'data.csv'), 'utf8')).toBe('safe,new,data\n');

    await controller.pump();
    expect(docker.started[0]!.mounts.find((mount) => mount.container === '/workspace/inputs')).toEqual({
      host: inputDir,
      container: '/workspace/inputs',
      readonly: true,
    });
  });

  it('serializes per user and enforces the global cap', async () => {
    const controller = makeController();
    const run1 = await enqueue(controller);
    const run2 = await enqueue(controller); // same user — must wait for run1
    const other = await createInternalTestUser(db, { email: `ca-other-${Date.now()}@test.local` });
    const run3 = await enqueue(controller, other);
    const third = await createInternalTestUser(db, { email: `ca-third-${Date.now()}@test.local` });
    const run4 = await enqueue(controller, third); // global cap (2) reached

    await controller.pump();
    expect((await db.agentRuns.getRunById(run1.id))!.status).toBe('running');
    expect((await db.agentRuns.getRunById(run2.id))!.status).toBe('queued');
    expect((await db.agentRuns.getRunById(run3.id))!.status).toBe('running');
    expect((await db.agentRuns.getRunById(run4.id))!.status).toBe('queued');

    // run1 completes → capacity frees → run4 (different user) starts, run2 still blocked? No:
    // run2's user now has no active run AND capacity exists for exactly one — run2 is older.
    await controller.handleRunnerCompletion(run1.id, { status: 'completed', result_summary: 'done' });
    expect((await db.agentRuns.getRunById(run2.id))!.status).toBe('running');
    expect((await db.agentRuns.getRunById(run4.id))!.status).toBe('queued');
  });

  it("does not let one user's deep queued backlog hide another runnable user", async () => {
    const controller = makeController();
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'backlog' });
    const blockedRuns: AgentRunRow[] = [];
    for (let i = 0; i < 51; i++) {
      blockedRuns.push(
        await db.agentRuns.createRun({
          user_id: user.id,
          workspace_id: workspace.id,
          title: `blocked-${i}`,
          prompt: 'wait',
          model: 'kimi-k3',
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const other = await createInternalTestUser(db, { email: `ca-backlog-other-${Date.now()}@test.local` });
    const runnable = await enqueue(controller, other);

    await controller.pump();

    expect((await db.agentRuns.getRunById(blockedRuns[0]!.id))!.status).toBe('running');
    expect((await db.agentRuns.getRunById(blockedRuns[1]!.id))!.status).toBe('queued');
    expect((await db.agentRuns.getRunById(runnable.id))!.status).toBe('running');
  });

  it('cancel finalizes: container removed, relay key disabled, capacity freed', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await controller.pump();

    const canceled = await controller.cancelRun(run.id);
    expect(canceled!.status).toBe('canceled');
    expect(docker.removed).toContain(containerNameFor(run.id));

    const client = (await db.apiClients.getById(canceled!.relay_client_id!))!;
    expect(client.status).toBe('disabled');

    // Cancel of a terminal run is a no-op.
    expect(await controller.cancelRun(run.id)).toBeUndefined();
  });

  it('escalates a Docker control-plane failure during terminal cleanup', async () => {
    const { DockerControlPlaneError } = await import('../../apps/api/src/cloud-agent/docker.js');
    const failures: Error[] = [];
    const controller = createCloudAgentController({
      db,
      docker,
      config,
      assertUserWorkspaceQuota,
      onExecutionPlaneFailure: (err) => failures.push(err),
    });
    const run = await enqueue(controller);
    await controller.pump();
    docker.failNextRemove = new DockerControlPlaneError('daemon unavailable');

    await expect(controller.cancelRun(run.id)).rejects.toThrow('daemon unavailable');

    expect(failures).toHaveLength(1);
    expect((await db.agentRuns.getRunById(run.id))!.status).toBe('canceled');
  });

  it('stops queue admission after losing the Docker execution plane', async () => {
    const { DockerControlPlaneError } = await import('../../apps/api/src/cloud-agent/docker.js');
    const failures: Error[] = [];
    const controller = createCloudAgentController({
      db,
      docker,
      config,
      assertUserWorkspaceQuota,
      onExecutionPlaneFailure: (err) => failures.push(err),
    });
    const first = await enqueue(controller);
    const other = await createInternalTestUser(db, { email: `ca-control-plane-${Date.now()}@test.local` });
    const second = await enqueue(controller, other);
    docker.failNextStart = new DockerControlPlaneError('daemon unavailable');

    await controller.pump();

    expect(failures).toHaveLength(1);
    expect((await db.agentRuns.getRunById(first.id))!.status).toBe('failed');
    expect((await db.agentRuns.getRunById(second.id))!.status).toBe('queued');
    expect(docker.started).toHaveLength(0);
  });

  it('waits for an in-flight start and removes a container that returns after admission closes', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const other = await createInternalTestUser(db, { email: `ca-late-start-${Date.now()}@test.local` });
    const queued = await enqueue(controller, other);

    let signalStartEntered!: () => void;
    let releaseStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      signalStartEntered = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    docker.startContainer = async (spec) => {
      docker.started.push(spec);
      signalStartEntered();
      await startGate;
      docker.states.set(containerNameFor(spec.runId), { running: true, exitCode: 0 });
      return 'late-container-id';
    };

    const pumping = controller.pump();
    await startEntered;

    let drained = false;
    const admissionDrained = controller.closeAdmission().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseStart();
    await Promise.all([pumping, admissionDrained]);

    expect(drained).toBe(true);
    expect(docker.removed).toContain('late-container-id');
    expect((await db.agentRuns.getRunById(run.id))!.status).toBe('failed');
    expect((await db.agentRuns.getRunById(queued.id))!.status).toBe('queued');
    await expect(enqueue(controller)).rejects.toThrow('Mission runtime admission is closed');
  });

  it('runner completion records summary + usage and disables the key', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await controller.pump();

    const done = await controller.handleRunnerCompletion(run.id, {
      status: 'completed',
      result_summary: 'Wrote the report',
      used_requests: 42,
      input_tokens: 1000,
      output_tokens: 2000,
    });
    expect(done!.status).toBe('completed');
    expect(done!.result_summary).toBe('Wrote the report');
    expect(done!.used_requests).toBe(0);
    expect((await db.apiClients.getById(done!.relay_client_id!))!.status).toBe('disabled');
    expect(done!.ended_at).toBeTruthy();
  });

  it('returns the same run when a dispatch card retries its stable id', async () => {
    const controller = makeController();
    const input = {
      title: 'Idempotent dispatch',
      prompt: 'Do it once',
      model: 'pro',
      fallbackModel: null,
      dispatchId: `cad_${'d'.repeat(16)}`,
    };
    const first = await controller.enqueueRun(user.id, input);
    const retried = await controller.enqueueRun(user.id, input);
    expect(retried.id).toBe(first.id);
    expect(await db.agentRuns.countRunsByUser(user.id)).toBe(1);
  });

  it('retries a failed outcome delivery and appends exactly one assistant message', async () => {
    const session = await db.sessions.create('Mission', 'sprouty-mission', user.id, undefined, 'mission');
    const controller = makeController();
    const run = await controller.enqueueRun(user.id, {
      title: 'Durable outcome',
      prompt: 'Finish',
      model: 'pro',
      fallbackModel: null,
      sessionId: session.id,
    });
    await controller.pump();

    const originalAddOnce = db.sessions.addMessageOnce.bind(db.sessions);
    db.sessions.addMessageOnce = async () => {
      throw new Error('temporary transcript failure');
    };
    await controller.handleRunnerCompletion(run.id, { status: 'completed', result_summary: 'Done exactly once' });
    expect((await db.agentRuns.listPendingOutcomes())[0]?.attempts).toBe(1);

    db.sessions.addMessageOnce = originalAddOnce;
    await controller.tick();
    await controller.tick(); // replaying the drain remains idempotent
    const messages = await db.sessions.getMessages(session.id);
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([
      'Done exactly once',
    ]);
    expect(await db.agentRuns.listPendingOutcomes()).toHaveLength(0);
  });

  it('boot recovers a process crash after terminal CAS but before settlement', async () => {
    const session = await db.sessions.create('Recovery', 'sprouty-mission', user.id, undefined, 'mission');
    const controller = makeController();
    const run = await controller.enqueueRun(user.id, {
      title: 'Terminal recovery',
      prompt: 'Finish durably',
      model: 'pro',
      fallbackModel: null,
      sessionId: session.id,
    });
    await controller.pump();

    // Simulate the exact crash window: status committed, settle() never ran.
    const terminal = await db.agentRuns.transitionRun(run.id, ['running'], {
      status: 'completed',
      result_summary: 'Recovered outcome',
      ended_at: new Date().toISOString(),
    });
    expect(terminal!.settled_at).toBeNull();

    await controller.bootSweep();
    expect((await db.agentRuns.getRunById(run.id))!.settled_at).toBeTruthy();
    expect((await db.apiClients.getById(terminal!.relay_client_id!))!.status).toBe('disabled');
    expect((await db.sessions.getMessages(session.id)).filter((message) => message.role === 'assistant')).toHaveLength(
      1,
    );

    await controller.bootSweep();
    expect((await db.sessions.getMessages(session.id)).filter((message) => message.role === 'assistant')).toHaveLength(
      1,
    );
  });

  it("settle gives the sweep's declines their own artifact.skipped timeline rows", async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await controller.pump();

    // Deliverables the runner never uploaded: one recoverable, one the sweep
    // must decline (a 130-char segment is over sanitizeFileSegment's limit).
    const { workspaceDir } = workspaceDirsFor(config.dataRoot, user.id, run.workspace_id);
    await mkdir(join(workspaceDir, 'artifacts'), { recursive: true });
    await writeFile(join(workspaceDir, 'artifacts', 'report.md'), '# done', 'utf8');
    await writeFile(join(workspaceDir, 'artifacts', `${'x'.repeat(130)}.txt`), 'junk', 'utf8');

    // Same crash window as above: terminal CAS committed, settle() never ran.
    await db.agentRuns.transitionRun(run.id, ['running'], {
      status: 'completed',
      result_summary: 'Done',
      ended_at: new Date().toISOString(),
    });
    await controller.bootSweep();

    const events = await db.agentRuns.listEvents(run.id, { after: AGENT_RUN_SERVER_SEQ_BASE });
    const created = events.filter((event) => event.type === 'artifact.created');
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0]!.payload)).toMatchObject({ path: 'report.md', recovered: true });

    // The decline is a row, not a log line — it is the user's only clue the
    // file is missing. Its seq sits in the fixed skip sub-band so a repeat
    // settle renumbers nothing and the (run_id, seq) unique index dedupes.
    const skipped = events.filter((event) => event.type === 'artifact.skipped');
    expect(skipped).toHaveLength(1);
    expect(JSON.parse(skipped[0]!.payload)).toMatchObject({ reason: 'malformed path', source: 'controller' });
    expect(skipped[0]!.seq).toBeGreaterThanOrEqual(AGENT_RUN_SERVER_SEQ_BASE + 100);

    await controller.bootSweep();
    expect(await db.agentRuns.listEvents(run.id, { after: AGENT_RUN_SERVER_SEQ_BASE })).toHaveLength(events.length);
  });

  it('a runner-reported settle recovers silently — its upload pass already reported the declines', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await controller.pump();

    const { workspaceDir } = workspaceDirsFor(config.dataRoot, user.id, run.workspace_id);
    await mkdir(join(workspaceDir, 'artifacts'), { recursive: true });
    await writeFile(join(workspaceDir, 'artifacts', `${'x'.repeat(130)}.txt`), 'junk', 'utf8');

    // A sweep skip row here would double the runner's own artifact.skipped for
    // the same file (an oversize deliverable stays oversize on every pass).
    await controller.handleRunnerCompletion(run.id, { status: 'completed', result_summary: 'Done' });

    const events = await db.agentRuns.listEvents(run.id, { after: AGENT_RUN_SERVER_SEQ_BASE });
    expect(events.filter((event) => event.type === 'artifact.skipped')).toHaveLength(0);
  });

  it('two controllers cannot over-admit the global container cap', async () => {
    config.maxConcurrent = 1;
    const other = await createInternalTestUser(db, { email: `ca-race-${Date.now()}@test.local` });
    const firstController = makeController();
    const secondController = makeController();
    await enqueue(firstController, user);
    await enqueue(firstController, other);

    await Promise.all([firstController.pump(), secondController.pump()]);
    expect(await db.agentRuns.countActiveRuns()).toBe(1);
    expect(docker.started).toHaveLength(1);
  });

  it('fails and reclaims a running task after its user workspace exceeds quota', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await controller.pump();
    config.userDiskQuotaBytes = 1; // prompt/session files already exceed this
    await controller.tick();
    const failed = (await db.agentRuns.getRunById(run.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.failure_code).toBe('workspace_quota_exceeded');
    expect(docker.removed).toContain(containerNameFor(run.id));
  });

  it('failed docker start marks the run failed and cleans up', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    docker.failNextStart = 'no such network: cloud-agent';
    await controller.pump();

    const failed = (await db.agentRuns.getRunById(run.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('no such network');
    expect((await db.apiClients.getById(failed.relay_client_id!))!.status).toBe('disabled');
  });

  it('reaper fails a run whose container died without reporting completion', async () => {
    const controller = createCloudAgentController({
      db,
      docker,
      config,
      assertUserWorkspaceQuota,
      exitGraceMs: 0,
    });
    const run = await enqueue(controller);
    await controller.pump();

    // Simulate a crashed container; zero exit grace so tick judges it now.
    docker.states.set(containerNameFor(run.id), { running: false, exitCode: 137 });
    await controller.tick();
    const failed = (await db.agentRuns.getRunById(run.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('exited (code 137)');
  });

  it('reaper enforces the wall-clock budget', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await controller.pump();

    const past = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    await db.agentRuns.updateRun(run.id, { started_at: past });
    await controller.tick();

    const failed = (await db.agentRuns.getRunById(run.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('wall-clock budget exceeded');
    expect(docker.removed).toContain(containerNameFor(run.id));
  });

  it('boot sweep fails DB-active runs without a live container and removes orphans', async () => {
    const controller = makeController();
    const run = await enqueue(controller);
    await controller.pump();

    // api "restarts": the container vanished meanwhile.
    docker.states.delete(containerNameFor(run.id));
    // …and an orphan container wears our label with no active run behind it.
    docker.states.set(containerNameFor('car_orphan'), { running: true, exitCode: 0 });
    // Crash window: a relay client was committed with its run id in metadata,
    // but agent_runs.relay_client_id never got checkpointed.
    const orphanRelay = await db.apiClients.create({
      app_id: `cloud-agent-orphan-${Date.now()}`,
      app_name: 'Cloud Agent orphan',
      api_key_hash: 'f'.repeat(64),
      user_id: user.id,
      channel: 'relay',
      created_by: user.id,
      meta: { allowed_models: ['kimi-k3'], cloud_agent_run_id: 'car_missing' },
    });

    await controller.bootSweep();

    const failed = (await db.agentRuns.getRunById(run.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('container lost across restart');
    expect(docker.removed).toContain(containerNameFor('car_orphan'));
    expect((await db.apiClients.getById(orphanRelay.id))!.status).toBe('disabled');

    // A run whose container is still alive is left running untouched.
    const other = await createInternalTestUser(db, { email: `ca-alive-${Date.now()}@test.local` });
    const alive = await enqueue(controller, other);
    await controller.pump();
    await controller.bootSweep();
    expect((await db.agentRuns.getRunById(alive.id))!.status).toBe('running');

    // A later restart is a fresh admission decision: a surviving container
    // may not inherit an unverified/project-0 user home from an older process.
    const fencedRestart = createCloudAgentController({
      db,
      docker,
      config,
      assertUserWorkspaceQuota: async (userId) => {
        if (userId === other.id) throw new WorkspaceQuotaAttestationError();
      },
    });
    await fencedRestart.bootSweep({ pump: false });
    expect((await db.agentRuns.getRunById(alive.id))!.failure_code).toBe('workspace_quota_unverified');
    expect(docker.removed).toContain(containerNameFor(alive.id));
  });
});
