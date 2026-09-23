/**
 * Cloud Agent internal (runner) route integration tests.
 *
 * The task-token boundary: event push, artifact upload, completion — each
 * re-validated against the DB (user must stay active internal, run must stay
 * writable). HTTP-level via the Hono route factory; no central auth
 * middleware is mounted here, mirroring the isPublicPath exemption.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider, UserRow, AgentRunRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

import { createCloudAgentInternalRoutes } from '../../apps/api/src/routes/cloud-agent.js';
import { createTaskToken } from '../../apps/api/src/auth/task-token.js';
import { getObjectAtKey } from '../../apps/api/src/storage/uploads.js';
import { createCloudAgentController } from '../../apps/api/src/cloud-agent/controller.js';
import { _setCloudAgentController } from '../../apps/api/src/cloud-agent/index.js';
import { containerNameFor, type DockerCli, type StartContainerSpec } from '../../apps/api/src/cloud-agent/docker.js';

class FakeDocker implements DockerCli {
  states = new Map<string, { running: boolean; exitCode: number }>();
  async startContainer(spec: StartContainerSpec): Promise<string> {
    this.states.set(containerNameFor(spec.runId), { running: true, exitCode: 0 });
    return `fake-${spec.runId}`;
  }
  async inspectContainer(name: string) {
    return this.states.get(name) ?? null;
  }
  async removeContainer(name: string): Promise<void> {
    this.states.delete(name);
  }
  async listAgentContainers() {
    return [];
  }
  async tailLogs(): Promise<string> {
    return '';
  }
}

let db: DatabaseProvider;
let user: UserRow;
let run: AgentRunRow;
const routes = createCloudAgentInternalRoutes();

function tokenFor(r: AgentRunRow, uid = r.user_id): string {
  return createTaskToken(uid, r.id, r.max_wall_ms);
}

async function postJson(path: string, token: string, body: unknown): Promise<Response> {
  return routes.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Cloud Agent internal routes', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `cai-${Date.now()}-${Math.random()}@test.local` });
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'w' });
    run = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      title: 't',
      prompt: 'p',
      model: 'deepseek-flash',
    });
    await db.agentRuns.transitionRun(run.id, ['queued'], { status: 'running' });
    // Internal credential tests exercise auth/run state, so keep the global
    // Mission execution-plane gate open with a controller-shaped test seam.
    // The completion case below installs a real controller before invoking it.
    _setCloudAgentController({} as ReturnType<typeof createCloudAgentController>);
  });

  afterEach(async () => {
    _setCloudAgentController(null);
    await db.close();
    _resetProvider();
  });

  // ─── Task-token boundary ───────────────────────────────

  it('rejects missing, malformed, and cross-run tokens', async () => {
    expect((await routes.request(`/runs/${run.id}/events`, { method: 'POST' })).status).toBe(401);
    expect((await postJson(`/runs/${run.id}/events`, 'lpct_garbage', { events: [] })).status).toBe(401);

    // Token signed for a different run must not authorize this one.
    const otherToken = createTaskToken(user.id, 'car_other', run.max_wall_ms);
    expect((await postJson(`/runs/${run.id}/events`, otherToken, { events: [] })).status).toBe(403);
  });

  it('rejects a valid token once the user is no longer active internal', async () => {
    const token = tokenFor(run);
    await db.users.update(user.id, { status: 'disabled' });
    const res = await postJson(`/runs/${run.id}/events`, token, {
      events: [{ seq: 1, type: 'run.started', payload: '{}' }],
    });
    expect(res.status).toBe(403);
  });

  it('closes runner writes once the run is terminal', async () => {
    await db.agentRuns.transitionRun(run.id, ['running'], { status: 'canceled' });
    const res = await postJson(`/runs/${run.id}/events`, tokenFor(run), {
      events: [{ seq: 1, type: 'run.started', payload: '{}' }],
    });
    expect(res.status).toBe(409);
  });

  // ─── Events ────────────────────────────────────────────

  it('appends events idempotently and permanently retains oversized payloads', async () => {
    const token = tokenFor(run);
    const fullText = 'x'.repeat(64_000);
    const first = await postJson(`/runs/${run.id}/events`, token, {
      events: [
        { seq: 1, type: 'run.started', payload: '{}' },
        { seq: 2, type: 'message.assistant', payload: JSON.stringify({ text: fullText }) },
      ],
    });
    expect(first.status).toBe(200);
    expect((await first.json()).inserted).toBe(2);

    // Retry with overlap (api restarted mid-push) inserts only the new row.
    const retry = await postJson(`/runs/${run.id}/events`, token, {
      events: [
        { seq: 2, type: 'message.assistant', payload: '{}' },
        { seq: 3, type: 'run.completed', payload: '{}' },
      ],
    });
    expect((await retry.json()).inserted).toBe(1);

    const events = await db.agentRuns.listEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(JSON.parse(events[1]!.payload).text).toBe(fullText);

    const bad = await postJson(`/runs/${run.id}/events`, token, { events: [{ seq: 0, type: 'x', payload: '{}' }] });
    expect(bad.status).toBe(400);
  });

  it('touches on pure heartbeats without storing invisible timeline rows', async () => {
    const token = tokenFor(run);
    const res = await postJson(`/runs/${run.id}/events`, token, {
      events: [
        { seq: 1, type: 'run.heartbeat', payload: JSON.stringify({ requests: 3 }) },
        { seq: 2, type: 'run.heartbeat', payload: JSON.stringify({ downgraded_to: 'pro', reason: 'quota' }) },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).inserted).toBe(1);
    const events = await db.agentRuns.listEvents(run.id);
    expect(events.map((event) => [event.seq, event.type])).toEqual([[2, 'run.heartbeat']]);
  });

  // ─── Artifacts ─────────────────────────────────────────

  it('uploads an artifact to storage, records sha256, and rejects bad paths', async () => {
    const token = tokenFor(run);
    const form = new FormData();
    form.append('file', new File(['# Report\nhello'], 'report.md', { type: 'text/markdown' }));
    form.append('path', 'report.md');
    form.append('content_type', 'text/markdown');

    const res = await routes.request(`/runs/${run.id}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(res.status).toBe(201);
    const { artifact } = (await res.json()) as { artifact: { path: string; sha256: string; storage_key: string } };
    expect(artifact.path).toBe('report.md');

    const stored = await getObjectAtKey(artifact.storage_key);
    expect(stored?.buffer.toString('utf8')).toBe('# Report\nhello');

    // Response-loss retry of the exact same bytes is acknowledged, not turned
    // into a false artifact.failed warning.
    const retryForm = new FormData();
    retryForm.append('file', new File(['# Report\nhello'], 'report.md', { type: 'text/markdown' }));
    retryForm.append('path', 'report.md');
    retryForm.append('content_type', 'text/markdown');
    const retry = await routes.request(`/runs/${run.id}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: retryForm,
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).idempotent).toBe(true);
    expect(await db.agentRuns.listArtifacts(run.id)).toHaveLength(1);

    // Same path with different bytes → 409.
    const dupForm = new FormData();
    dupForm.append('file', new File(['again'], 'report.md'));
    dupForm.append('path', 'report.md');
    const dup = await routes.request(`/runs/${run.id}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: dupForm,
    });
    expect(dup.status).toBe(409);

    // Traversal-shaped path → 400.
    const badForm = new FormData();
    badForm.append('file', new File(['x'], 'x'));
    badForm.append('path', '../escape.md');
    const bad = await routes.request(`/runs/${run.id}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: badForm,
    });
    expect(bad.status).toBe(400);
  });

  /**
   * Regression: the path gate used to be ASCII-only, so every CJK-named
   * deliverable 400'd while its ASCII sibling went through — a 29-minute
   * mission lost its report to a filename check (2026-07-31).
   */
  it('accepts CJK artifact names and normalizes unsafe characters', async () => {
    const token = tokenFor(run);
    const cjk = new FormData();
    cjk.append('file', new File(['<h1>报告</h1>'], 'x.html', { type: 'text/html' }));
    cjk.append('path', 'ECT说明书_不带水泵_V2_审校报告.html');
    const res = await routes.request(`/runs/${run.id}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: cjk,
    });
    expect(res.status).toBe(201);
    const { artifact } = (await res.json()) as { artifact: { path: string; storage_key: string } };
    expect(artifact.path).toBe('ECT说明书_不带水泵_V2_审校报告.html');
    expect((await getObjectAtKey(artifact.storage_key))?.buffer.toString('utf8')).toBe('<h1>报告</h1>');

    // Nested + hostile characters: kept as a file, sanitized in place.
    const odd = new FormData();
    odd.append('file', new File(['x'], 'x'));
    odd.append('path', 'sub dir/汇总"报告*.csv');
    const oddRes = await routes.request(`/runs/${run.id}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: odd,
    });
    expect(oddRes.status).toBe(201);
    const { artifact: odd2 } = (await oddRes.json()) as { artifact: { path: string } };
    expect(odd2.path).toBe('sub dir/汇总_报告_.csv');
  });

  /**
   * The collector reports what it declined to send instead of dropping it in
   * silence. The web timeline had a "skipped" branch for months while nothing
   * ever emitted the event, so the artifact list was quietly incomplete.
   */
  it('accepts artifact.skipped rows from the runner', async () => {
    const res = await postJson(`/runs/${run.id}/events`, tokenFor(run), {
      events: [
        { seq: 1, type: 'artifact.skipped', payload: JSON.stringify({ path: 'old.pdf', reason: 'stale_mtime' }) },
      ],
    });
    expect(res.status).toBe(200);

    const events = await db.agentRuns.listEvents(run.id);
    expect(events.map((e) => e.type)).toEqual(['artifact.skipped']);
    expect(JSON.parse(events[0]!.payload).reason).toBe('stale_mtime');
  });

  // ─── Completion ────────────────────────────────────────

  it('completion finalizes the run through the controller', async () => {
    const docker = new FakeDocker();
    const controller = createCloudAgentController({
      db,
      docker,
      assertUserWorkspaceQuota: async () => undefined,
      config: {
        dataRoot: await mkdtemp(join(tmpdir(), 'cloud-agent-routes-')),
        image: 'test',
        apiBase: 'http://host.docker.internal:3101',
        maxConcurrent: 2,
        network: 'cloud-agent',
        skillsDir: null,
        memory: '1.5g',
        cpus: '2',
        dockerRuntime: null,
        requireHardenedRuntime: false,
        userDiskQuotaBytes: 5 * 1024 * 1024 * 1024,
        userInodeQuota: 25_000,
        hardQuotaMarkerPath: '/tmp/greenhouse-test-quota-marker.json',
        quotaAttestCommand: '/usr/local/sbin/greenhouse-sandbox-runner-quota',
        archiveAfterDays: 14,
        defaultModel: 'deepseek-flash',
        fallbackModel: 'pro',
      },
    });
    _setCloudAgentController(controller);

    // Full lifecycle: a controller-started run has a relay key to disable.
    // Fresh user — the beforeEach run is still 'running' and would block
    // admission under the per-user serialization rule.
    const owner = await createInternalTestUser(db, { email: `cai-owner-${Date.now()}@test.local` });
    const owned = await controller.enqueueRun(owner.id, {
      title: 'full',
      prompt: 'do',
      model: 'deepseek-flash',
      fallbackModel: 'pro',
    });
    await controller.pump();

    // The relay boundary, not the sandbox process, owns request admission.
    // Seed one real server-side debit so completion can prove that an
    // untrusted runner report cannot replace the authoritative counter.
    expect(await db.agentRuns.reserveRequest(owned.id, owner.id)).toMatchObject({ ok: true });

    const res = await postJson(`/runs/${owned.id}/complete`, tokenFor(owned, owner.id), {
      status: 'completed',
      result_summary: 'done',
      used_requests: 7,
      input_tokens: 100,
      output_tokens: 200,
    });
    expect(res.status).toBe(200);

    const finished = (await db.agentRuns.getRunById(owned.id))!;
    expect(finished.status).toBe('completed');
    expect(finished.used_requests).toBe(1);
    expect((await db.apiClients.getById(finished.relay_client_id!))!.status).toBe('disabled');

    // Second completion is a conflict (run already finalized → auth 409s).
    const again = await postJson(`/runs/${owned.id}/complete`, tokenFor(owned, owner.id), { status: 'completed' });
    expect(again.status).toBe(409);
  });
});
