/**
 * Mission 用户路由 — /api/missions（/api/cloud-agent 为兼容别名）
 *
 * 用户面（central Bearer + requireInternal + requireFeature('cloud-agent')）：
 * POST /api/missions/runs                       — 发起任务（可带 skill=技能名：校验
 *                                                  mission-ready 后在 runner prompt 前
 *                                                  注入技能使用指令，此时 prompt 可空；
 *                                                  write_user_turn=true 时把 prompt 写成
 *                                                  该会话的 user 消息——composer 直发路径；
 *                                                  新对话可由本请求在 admission 内创建）
 * GET  /api/missions/runs                       — 我的任务列表
 * GET  /api/missions/runs/:id                   — 任务详情（含产物列表）
 * GET  /api/missions/runs/:id/events?after=     — 事件增量拉取（seq 重放）
 * POST /api/missions/runs/:id/cancel            — 取消任务
 * GET  /api/missions/runs/:id/artifacts/:artifactId/download — 产物下载
 * POST /api/missions/attachments                — 上传任务输入附件（mission 预设专用；
 *                                                    普通会话的附件走 /api/chat-files 并以
 *                                                    chat_file_ids 传入，零复制物化）
 * GET  /api/missions/attachments/download?key=  — 输入附件下载（归属=key 前缀）
 *
 * 内部面（run 绑定 task token，见 auth/task-token.ts；在 isPublicPath 豁免
 * 中央 Bearer，先于用户面守卫挂载）：
 * POST /api/missions/internal/runs/:id/events    — runner 批量推事件
 * POST /api/missions/internal/runs/:id/artifacts — runner 上传产物（multipart）
 * POST /api/missions/internal/runs/:id/complete  — runner 上报完结
 * `/api/cloud-agent/internal/*` remains a compatibility alias.
 */

import { toErrorMessage } from '@greenhouse/utils/error';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { getDb } from '@greenhouse/db';
import type { AgentRunRow } from '@greenhouse/db';
import { getModelEntry } from '@greenhouse/agent-core';
import { AGENT_RUN_EVENT_TYPES, AGENT_RUN_SERVER_SEQ_BASE } from '@greenhouse/types/cloud-agent';

import type { AppEnv } from '../app-env.js';
import { mirrorRuntimeRunSoon } from '../runtime/adapters.js';
import { contentDisposition } from '../http/content-disposition.js';
import { getAuthUser } from '../auth/middleware.js';
import { validateTaskToken } from '../auth/task-token.js';
import { getCloudAgentController, getMissionRuntimeStatus } from '../cloud-agent/index.js';
import { loadCloudAgentConfig } from '../cloud-agent/config.js';
import { MAX_ARTIFACT_BYTES, persistArtifact, sanitizeArtifactPath } from '../cloud-agent/artifact-store.js';
import { putObjectAtKey, getObjectAtKey } from '../storage/uploads.js';
import { sanitizeUploadName } from '../storage/filename.js';
import { connectionManager } from '../ws/connection-manager.js';
import { attachmentKeyPrefix, isOwnedAttachmentKey } from '../cloud-agent/attachment-keys.js';
import { WorkspaceQuotaAttestationError } from '../cloud-agent/quota-preflight.js';
import { isSlashSelectableSkill } from '../skills/mission-ready.js';
import { createOwnedSession, SessionCreationError } from '../sessions/creation.js';

const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_EVENTS_PER_BATCH = 200;
const DISPATCH_ID_RE = /^cad_[a-f0-9]{16,64}$/;
const RUN_BUDGETS = {
  light: { maxWallMs: 30 * 60_000, maxRequests: 60 },
  standard: { maxWallMs: 2 * 60 * 60_000, maxRequests: 300 },
  deep: { maxWallMs: 4 * 60 * 60_000, maxRequests: 600 },
} as const;
type RunBudget = keyof typeof RUN_BUDGETS;
/**
 * Event types the runner may push. This used to be a shape regex, which let a
 * typo'd type through as a permanent, unrenderable timeline row; the protocol
 * now has a single definition the runner type-checks against too.
 * `run.canceled` is excluded on purpose — it is the control plane's to write.
 */
const RUNNER_EVENT_TYPES = new Set<string>(AGENT_RUN_EVENT_TYPES.filter((t) => t !== 'run.canceled'));

/**
 * The 30s request-count heartbeat only proves liveness, and the route already
 * touches agent_runs.updated_at for that. Persist heartbeats only when they
 * carry a user-visible state change such as platform tool discovery or model
 * downgrade; otherwise long runs fill the timeline table with invisible rows.
 */
function shouldPersistEvent(event: { type: string; payload: string }): boolean {
  if (event.type !== 'run.heartbeat') return true;
  try {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    return Object.keys(payload).some((key) => key !== 'requests');
  } catch {
    return true; // malformed payload stays auditable instead of disappearing
  }
}

/** Statuses the runner is allowed to report against. */
const RUNNER_WRITABLE: ReadonlyArray<AgentRunRow['status']> = ['starting', 'running'];

// ─── Attachments (mission inputs) ────────────────────────

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_RUN = 10;
/**
 * Streaming pre-guard so an oversize upload is cut off at the socket instead
 * of being buffered whole by parseBody() before the per-file check runs. The
 * headroom covers multipart framing (boundaries + part headers).
 *
 * ⚠️ The reverse proxy in front of the api must allow at least this much
 * (`client_max_body_size` ≥ 110m on the dev nginx) — otherwise nginx answers a
 * bare HTML 413 well below the app limit and the UI can only show "too large"
 * with no usable number.
 */
const MAX_ATTACHMENT_BODY_BYTES = MAX_ATTACHMENT_BYTES + 1024 * 1024;

/**
 * Any file type on purpose (PDF/video/Excel/images/… — 2026-07-31 direction):
 * attachments never execute server-side, they are materialized as plain files
 * in the sandbox workspace `inputs/` where the agent reads them with its own
 * tools. Only the filename is sanitized (it becomes a path segment).
 */
const sanitizeAttachmentName = sanitizeUploadName;

function missionRuntimeUnavailable() {
  return {
    code: 'mission_runtime_unavailable' as const,
    error: 'Missions are not available in this environment',
  };
}

/**
 * Roll back only a session for which admission never produced a run. A late
 * controller failure can happen after the run row exists; in that case the
 * conversation is part of the durable audit trail and must stay.
 */
async function deleteUnstartedMissionSession(sessionId: string): Promise<void> {
  try {
    if ((await getDb().agentRuns.listRunsBySession(sessionId)).length === 0) {
      await getDb().sessions.delete(sessionId);
    }
  } catch (err) {
    logger.error('[cloud-agent] failed to roll back unstarted mission session', {
      sessionId,
      err: toErrorMessage(err),
    });
  }
}

async function decorateQueueInfo(runs: AgentRunRow[]) {
  const [queued, active, pendingApprovals] = await Promise.all([
    getDb().agentRuns.listQueuedRuns(),
    getDb().agentRuns.listActiveRuns(),
    getDb().agentRuns.countPendingApprovalsByRun(runs.map((run) => run.id)),
  ]);
  const activeUsers = new Set(active.map((run) => run.user_id));
  const activeCount = active.length;
  // Historical reads remain available even when an invalid host/runtime
  // configuration has closed Mission admission. Re-parsing that config here
  // would turn a safe GET into a 500.
  const runtime = getMissionRuntimeStatus();
  const maxConcurrent = runtime.state === 'ready' ? runtime.maxConcurrent : 0;
  const positions = new Map(queued.map((run, index) => [run.id, index + 1]));
  return runs.map((run) => {
    const queueReason: 'user_active' | 'global_capacity' | 'ready' | null =
      run.status !== 'queued'
        ? null
        : activeUsers.has(run.user_id)
          ? 'user_active'
          : activeCount >= maxConcurrent
            ? 'global_capacity'
            : 'ready';
    return {
      ...run,
      queue_position: run.status === 'queued' ? (positions.get(run.id) ?? null) : null,
      queue_reason: queueReason,
      pending_approval_count: pendingApprovals[run.id] ?? 0,
    };
  });
}

// ─── User-facing routes ──────────────────────────────────

export function createCloudAgentRoutes() {
  return (
    new Hono<AppEnv>()
      .post(
        '/attachments',
        bodyLimit({
          maxSize: MAX_ATTACHMENT_BODY_BYTES,
          onError: (c) => c.json({ error: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` }, 413),
        }),
        async (c) => {
          if (!getCloudAgentController()) {
            return c.json(missionRuntimeUnavailable(), 503);
          }
          const user = getAuthUser(c);
          const form = await c.req.parseBody().catch(() => null);
          const file = form?.['file'];
          if (!(file instanceof File)) return c.json({ error: 'multipart field "file" is required' }, 400);
          if (file.size > MAX_ATTACHMENT_BYTES) {
            return c.json({ error: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` }, 413);
          }
          const name = sanitizeAttachmentName(file.name || 'file');
          if (!name) return c.json({ error: 'attachment filename is unusable' }, 400);

          const key = `${attachmentKeyPrefix(user.id)}${randomUUID()}/${name}`;
          await putObjectAtKey(key, Buffer.from(await file.arrayBuffer()), file.type || 'application/octet-stream');
          return c.json({ key, name, size: file.size }, 201);
        },
      )

      .post('/runs', async (c) => {
        const user = getAuthUser(c);
        const controller = getCloudAgentController();
        if (!controller) {
          return c.json(missionRuntimeUnavailable(), 503);
        }

        const body = (await c.req.json().catch(() => ({}))) as {
          title?: string;
          prompt?: string;
          model?: string;
          workspace_id?: number;
          session_id?: string;
          create_session_profile_id?: unknown;
          attachments?: Array<{ key?: unknown; name?: unknown }>;
          chat_file_ids?: unknown;
          dispatch_id?: unknown;
          budget?: unknown;
          skill?: unknown;
          write_user_turn?: unknown;
        };
        // Direct skill launches re-validate the slash policy at launch time —
        // a skill can be regrouped, quarantined or archived after listing.
        let skill: { name: string; display_name: string } | null = null;
        if (body.skill !== undefined) {
          if (typeof body.skill !== 'string' || !body.skill.trim()) {
            return c.json({ error: 'skill is malformed' }, 400);
          }
          const row = await getDb().skills.getByName(body.skill.trim());
          if (!row || !isSlashSelectableSkill(row)) {
            return c.json({ error: `skill "${body.skill.trim()}" is not available for direct launch` }, 400);
          }
          skill = { name: row.name, display_name: row.display_name };
        }
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        // A skill run may omit the brief — the skill's own SKILL.md is the task.
        if (!prompt && !skill) return c.json({ error: 'prompt is required' }, 400);
        if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
          return c.json({ error: `prompt exceeds ${MAX_PROMPT_BYTES} bytes` }, 400);
        }
        const dispatchId = body.dispatch_id === undefined ? null : body.dispatch_id;
        if (dispatchId !== null && (typeof dispatchId !== 'string' || !DISPATCH_ID_RE.test(dispatchId))) {
          return c.json({ error: 'dispatch_id is malformed' }, 400);
        }
        if (dispatchId) {
          const existing = await getDb().agentRuns.getRunByDispatchId(dispatchId);
          if (existing) {
            if (existing.user_id !== user.id) return c.json({ error: 'dispatch_id is already in use' }, 409);
            return c.json({ run: (await decorateQueueInfo([existing]))[0], idempotent: true }, 200);
          }
        }
        const budget: RunBudget = body.budget === undefined ? 'standard' : (body.budget as RunBudget);
        if (!(budget in RUN_BUDGETS)) return c.json({ error: 'budget must be light, standard, or deep' }, 400);

        let createSessionProfileId: string | null = null;
        if (body.create_session_profile_id !== undefined) {
          if (typeof body.create_session_profile_id !== 'string' || !body.create_session_profile_id.trim()) {
            return c.json({ error: 'create_session_profile_id is malformed' }, 400);
          }
          if (body.session_id !== undefined) {
            return c.json({ error: 'session_id and create_session_profile_id are mutually exclusive' }, 400);
          }
          createSessionProfileId = body.create_session_profile_id.trim();
        }

        // Mission conversation binding — both references must belong to the
        // caller before the controller acts on them (integration spec D2).
        let sessionId: string | null = null;
        if (body.session_id !== undefined) {
          if (typeof body.session_id !== 'string' || !body.session_id) {
            return c.json({ error: 'session_id is malformed' }, 400);
          }
          const session = await getDb().sessions.getById(body.session_id);
          if (!session || session.user_id !== user.id) return c.json({ error: 'Session not found' }, 404);
          sessionId = session.id;
        }
        // The composer's direct-launch path: the brief IS the user's own words
        // (typed into the composer), so writing it as their turn is not
        // fabrication — unlike the dispatch-card path, where the conversation
        // already holds the user's real turn (session-modes spec D5).
        const writeUserTurn = body.write_user_turn === true;
        if (writeUserTurn && !sessionId && !createSessionProfileId) {
          return c.json({ error: 'write_user_turn requires a session binding' }, 400);
        }
        let workspaceId: number | null = null;
        if (body.workspace_id !== undefined) {
          if (!Number.isInteger(body.workspace_id)) return c.json({ error: 'workspace_id is malformed' }, 400);
          const workspace = await getDb().agentRuns.getWorkspaceById(body.workspace_id);
          if (!workspace || workspace.user_id !== user.id) return c.json({ error: 'Workspace not found' }, 404);
          workspaceId = workspace.id;
        }

        const config = loadCloudAgentConfig();
        const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.defaultModel;
        if (!getModelEntry(model)) return c.json({ error: `unknown model: ${model}` }, 400);
        const fallbackModel =
          config.fallbackModel && config.fallbackModel !== model && getModelEntry(config.fallbackModel)
            ? config.fallbackModel
            : null;

        const title =
          (typeof body.title === 'string' && body.title.trim()) ||
          (prompt ? prompt.split('\n')[0]!.slice(0, 80) : skill!.display_name);

        // Attachment refs must be blobs THIS user uploaded (key prefix check).
        const attachments: Array<{ key?: string; id?: string; name: string }> = [];
        if (body.attachments !== undefined) {
          if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ATTACHMENTS_PER_RUN) {
            return c.json({ error: `at most ${MAX_ATTACHMENTS_PER_RUN} attachments per run` }, 400);
          }
          for (const att of body.attachments) {
            const name = typeof att.name === 'string' ? sanitizeAttachmentName(att.name) : null;
            if (typeof att.key !== 'string' || !isOwnedAttachmentKey(user.id, att.key) || !name) {
              return c.json({ error: 'attachment reference is malformed' }, 400);
            }
            attachments.push({ key: att.key, name });
          }
        }

        // Conversation attachments (dispatch-card path). The session bound is
        // the authorization — an id from another conversation resolves to
        // nothing, so a card cannot smuggle someone else's file into a sandbox.
        if (body.chat_file_ids !== undefined) {
          if (!Array.isArray(body.chat_file_ids) || body.chat_file_ids.some((id) => typeof id !== 'string')) {
            return c.json({ error: 'chat_file_ids is malformed' }, 400);
          }
          if (!sessionId) return c.json({ error: 'chat_file_ids requires session_id' }, 400);
          if (attachments.length + body.chat_file_ids.length > MAX_ATTACHMENTS_PER_RUN) {
            return c.json({ error: `at most ${MAX_ATTACHMENTS_PER_RUN} attachments per run` }, 400);
          }
          const rows = await getDb().chatFiles.listBySessionAndIds(sessionId, body.chat_file_ids as string[]);
          if (rows.length !== new Set(body.chat_file_ids as string[]).size) {
            return c.json({ error: 'attachment reference is malformed' }, 400);
          }
          for (const row of rows) attachments.push({ id: row.id, name: row.name });
        }

        let createdSessionId: string | null = null;
        if (createSessionProfileId) {
          try {
            const session = await createOwnedSession(user, { title, profileId: createSessionProfileId });
            sessionId = session.id;
            createdSessionId = session.id;
          } catch (err) {
            if (err instanceof SessionCreationError) return c.json({ error: err.message }, err.status);
            throw err;
          }
        }

        let run: AgentRunRow;
        try {
          run = await controller.enqueueRun(user.id, {
            title,
            prompt,
            model,
            fallbackModel,
            workspaceId,
            sessionId,
            attachments,
            dispatchId,
            skillName: skill?.name ?? null,
            writeUserTurn,
            maxWallMs: RUN_BUDGETS[budget].maxWallMs,
            maxRequests: RUN_BUDGETS[budget].maxRequests,
          });
        } catch (err) {
          if (createdSessionId) await deleteUnstartedMissionSession(createdSessionId);
          const message = toErrorMessage(err);
          if (err instanceof WorkspaceQuotaAttestationError) {
            return c.json({ code: 'mission_workspace_quota_unavailable', error: message }, 503);
          }
          if (/quota exceeded/i.test(message)) return c.json({ error: message }, 413);
          if (/Dispatch ID/i.test(message)) return c.json({ error: message }, 409);
          throw err;
        }
        // Admission is async on purpose: enqueue latency must not include a docker start.
        mirrorRuntimeRunSoon('mission', run.id);
        void controller.pump().catch((err) => logger.error('[cloud-agent] pump failed', { err: String(err) }));
        return c.json({ run: (await decorateQueueInfo([run]))[0] }, 201);
      })

      .get('/runs', async (c) => {
        const user = getAuthUser(c);
        // Mission conversations ask for their own run lineage by session.
        const sessionId = c.req.query('session_id');
        if (sessionId) {
          const runs = (await getDb().agentRuns.listRunsBySession(sessionId)).filter(
            (r) => r.user_id === user.id || user.role === 'super',
          );
          return c.json({ runs: await decorateQueueInfo(runs), total: runs.length });
        }
        const limit = Number(c.req.query('limit') ?? 50);
        const offset = Number(c.req.query('offset') ?? 0);
        const runs = await getDb().agentRuns.listRunsByUser(user.id, {
          limit: Number.isFinite(limit) ? limit : 50,
          offset: Number.isFinite(offset) ? offset : 0,
        });
        const total = await getDb().agentRuns.countRunsByUser(user.id);
        return c.json({ runs: await decorateQueueInfo(runs), total });
      })

      .get('/runs/:id', async (c) => {
        const user = getAuthUser(c);
        const run = await getDb().agentRuns.getRunById(c.req.param('id'));
        if (!run || (run.user_id !== user.id && user.role !== 'super')) {
          return c.json({ error: 'Run not found' }, 404);
        }
        const [artifacts, approvals, decorated] = await Promise.all([
          getDb().agentRuns.listArtifacts(run.id),
          getDb().agentRuns.listApprovals(run.id),
          decorateQueueInfo([run]),
        ]);
        return c.json({ run: decorated[0], artifacts, approvals });
      })

      .post('/runs/:id/approvals/:approvalId/decision', async (c) => {
        if (getMissionRuntimeStatus().state !== 'ready') {
          return c.json(missionRuntimeUnavailable(), 503);
        }
        const user = getAuthUser(c);
        const run = await getDb().agentRuns.getRunById(c.req.param('id'));
        if (!run || (run.user_id !== user.id && user.role !== 'super')) {
          return c.json({ error: 'Run not found' }, 404);
        }
        if (!RUNNER_WRITABLE.includes(run.status)) {
          return c.json({ error: `Run is already ${run.status}` }, 409);
        }
        const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown };
        if (body.decision !== 'approve' && body.decision !== 'deny') {
          return c.json({ error: 'decision must be approve or deny' }, 400);
        }
        const approval = await getDb().agentRuns.decideApproval(
          c.req.param('approvalId'),
          run.id,
          run.user_id,
          body.decision,
          user.id,
        );
        if (!approval) return c.json({ error: 'Approval is missing, expired, or already decided' }, 409);
        connectionManager.sendToUser(run.user_id, {
          type: 'mission:run',
          runId: run.id,
          sessionId: run.session_id,
          status: run.status,
        });
        return c.json({ approval });
      })

      .get('/runs/:id/journal', async (c) => {
        const user = getAuthUser(c);
        const run = await getDb().agentRuns.getRunById(c.req.param('id'));
        if (!run || (run.user_id !== user.id && user.role !== 'super')) {
          return c.json({ error: 'Run not found' }, 404);
        }
        if (!run.journal_storage_key) return c.json({ error: 'Run journal is not available' }, 404);
        const stored = await getObjectAtKey(run.journal_storage_key);
        if (!stored) return c.json({ error: 'Run journal content is missing from storage' }, 404);
        return c.body(new Uint8Array(stored.buffer), 200, {
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': contentDisposition(`${run.id}-journal.jsonl`),
          'Cache-Control': 'no-store',
        });
      })

      .get('/runs/:id/events', async (c) => {
        const user = getAuthUser(c);
        const run = await getDb().agentRuns.getRunById(c.req.param('id'));
        if (!run || (run.user_id !== user.id && user.role !== 'super')) {
          return c.json({ error: 'Run not found' }, 404);
        }
        const after = Number(c.req.query('after') ?? 0);
        const events = await getDb().agentRuns.listEvents(run.id, {
          after: Number.isFinite(after) && after > 0 ? after : 0,
        });
        return c.json({ events, run_status: run.status });
      })

      .post('/runs/:id/cancel', async (c) => {
        const user = getAuthUser(c);
        const run = await getDb().agentRuns.getRunById(c.req.param('id'));
        if (!run || (run.user_id !== user.id && user.role !== 'super')) {
          return c.json({ error: 'Run not found' }, 404);
        }
        const controller = getCloudAgentController();
        if (!controller) {
          return c.json(missionRuntimeUnavailable(), 503);
        }
        const canceled = await controller.cancelRun(run.id);
        if (!canceled) return c.json({ error: `Run is already ${run.status}` }, 409);
        mirrorRuntimeRunSoon('mission', run.id);
        return c.json({ run: (await decorateQueueInfo([canceled]))[0] });
      })

      .get('/runs/:id/artifacts/:artifactId/download', async (c) => {
        const user = getAuthUser(c);
        const run = await getDb().agentRuns.getRunById(c.req.param('id'));
        if (!run || (run.user_id !== user.id && user.role !== 'super')) {
          return c.json({ error: 'Run not found' }, 404);
        }
        const artifactId = Number(c.req.param('artifactId'));
        const artifact = Number.isInteger(artifactId) ? await getDb().agentRuns.getArtifactById(artifactId) : undefined;
        if (!artifact || artifact.run_id !== run.id) return c.json({ error: 'Artifact not found' }, 404);

        const stored = await getObjectAtKey(artifact.storage_key);
        if (!stored) return c.json({ error: 'Artifact content is missing from storage' }, 404);
        const filename = artifact.path.split('/').pop() ?? 'artifact';
        return c.body(new Uint8Array(stored.buffer), 200, {
          'Content-Type': artifact.content_type,
          'Content-Disposition': contentDisposition(filename),
          'Cache-Control': 'no-store',
        });
      })

      /**
       * Mission INPUT download — the chips rendered under a user turn.
       *
       * Ownership is the key prefix, not a DB row: attachment blobs are stored
       * at `cloud-agent/attachments/<userId>/<uuid>/<name>` and never get a
       * table of their own (no second consumer would justify one). The prefix
       * check is exact, so a key belonging to someone else 404s even for super
       * — there is no legitimate cross-user read of a mission input.
       */
      .get('/attachments/download', async (c) => {
        const user = getAuthUser(c);
        const key = c.req.query('key') ?? '';
        if (!isOwnedAttachmentKey(user.id, key)) {
          return c.json({ error: 'Attachment not found' }, 404);
        }
        const stored = await getObjectAtKey(key);
        if (!stored) return c.json({ error: 'Attachment not found' }, 404);
        const filename = key.split('/').pop() ?? 'attachment';
        return c.body(new Uint8Array(stored.buffer), 200, {
          'Content-Type': stored.contentType || 'application/octet-stream',
          'Content-Disposition': contentDisposition(filename),
          'Cache-Control': 'no-store',
        });
      })
  );
}

// ─── Internal (runner) routes ────────────────────────────

type TaskAuth = { run: AgentRunRow } | { failure: Response };

/**
 * Validate the run-bound task token and re-read user + run from the DB —
 * a sandbox credential must never outlive account deactivation or the run
 * itself (spec D7; repo rule: every server credential maps to a real,
 * currently-valid internal user).
 */
async function authenticateTask(c: Context<AppEnv>): Promise<TaskAuth> {
  if (getMissionRuntimeStatus().state !== 'ready') {
    return { failure: c.json(missionRuntimeUnavailable(), 503) };
  }
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return { failure: c.json({ error: 'Missing task token' }, 401) };
  }
  const payload = validateTaskToken(header.slice('Bearer '.length).trim());
  if (!payload) return { failure: c.json({ error: 'Invalid or expired task token' }, 401) };
  if (payload.runId !== c.req.param('id')) {
    return { failure: c.json({ error: 'Task token is bound to a different run' }, 403) };
  }

  const user = await getDb().users.getById(payload.uid);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
    return { failure: c.json({ error: 'Task owner is not an active internal user' }, 403) };
  }

  const run = await getDb().agentRuns.getRunById(payload.runId);
  if (!run || run.user_id !== payload.uid) {
    return { failure: c.json({ error: 'Run not found' }, 404) };
  }
  if (!RUNNER_WRITABLE.includes(run.status)) {
    return { failure: c.json({ error: `Run is ${run.status}; runner writes are closed` }, 409) };
  }
  return { run };
}

export function createCloudAgentInternalRoutes() {
  return new Hono<AppEnv>()
    .post('/runs/:id/events', async (c) => {
      const auth = await authenticateTask(c);
      if ('failure' in auth) return auth.failure;

      const body = (await c.req.json().catch(() => ({}))) as {
        events?: Array<{ seq?: unknown; type?: unknown; payload?: unknown }>;
      };
      if (!Array.isArray(body.events) || body.events.length === 0) {
        return c.json({ error: 'events array is required' }, 400);
      }
      if (body.events.length > MAX_EVENTS_PER_BATCH) {
        return c.json({ error: `at most ${MAX_EVENTS_PER_BATCH} events per batch` }, 400);
      }

      const events = [];
      for (const event of body.events) {
        if (!Number.isInteger(event.seq) || (event.seq as number) < 1) {
          return c.json({ error: 'event seq must be a positive integer' }, 400);
        }
        if (typeof event.type !== 'string' || !RUNNER_EVENT_TYPES.has(event.type)) {
          return c.json({ error: `unknown event type: ${String(event.type)}` }, 400);
        }
        // The high seq segment is reserved for control-plane terminal markers.
        if ((event.seq as number) >= AGENT_RUN_SERVER_SEQ_BASE) {
          return c.json({ error: 'event seq is out of range' }, 400);
        }
        const payload = typeof event.payload === 'string' ? event.payload : '{}';
        events.push({ seq: event.seq as number, type: event.type, payload });
      }

      const inserted = await getDb().agentRuns.appendEvents(auth.run.id, events.filter(shouldPersistEvent));
      // Touch the run so the reaper's exit grace sees live runner activity.
      await getDb().agentRuns.updateRun(auth.run.id, {});
      return c.json({ ok: true, inserted });
    })

    .post('/runs/:id/artifacts', async (c) => {
      const auth = await authenticateTask(c);
      if ('failure' in auth) return auth.failure;

      const form = await c.req.parseBody().catch(() => null);
      if (!form) return c.json({ error: 'multipart form body is required' }, 400);
      const file = form['file'];
      const rawPath = form['path'];
      if (!(file instanceof File) || typeof rawPath !== 'string') {
        return c.json({ error: 'fields "file" and "path" are required' }, 400);
      }
      const path = sanitizeArtifactPath(rawPath);
      if (!path) return c.json({ error: 'artifact path is malformed' }, 400);
      if (file.size > MAX_ARTIFACT_BYTES) {
        return c.json({ error: `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes` }, 413);
      }

      const contentType =
        typeof form['content_type'] === 'string' && form['content_type']
          ? form['content_type']
          : 'application/octet-stream';
      // Shared with the terminal sweep (cloud-agent/artifact-store.ts) so a
      // recovered file and an uploaded one obey the same limits, path hygiene
      // and idempotency rules.
      const stored = await persistArtifact(getDb(), {
        runId: auth.run.id,
        path,
        buffer: Buffer.from(await file.arrayBuffer()),
        contentType,
      });
      if (!stored.ok) {
        const status = stored.code === 'conflict' ? 409 : stored.code === 'too_large' ? 413 : 400;
        return c.json({ error: stored.message }, status);
      }
      return stored.idempotent
        ? c.json({ artifact: stored.artifact, idempotent: true }, 200)
        : c.json({ artifact: stored.artifact }, 201);
    })

    .post('/runs/:id/complete', async (c) => {
      const auth = await authenticateTask(c);
      if ('failure' in auth) return auth.failure;

      const controller = getCloudAgentController();
      if (!controller) {
        return c.json(missionRuntimeUnavailable(), 503);
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        status?: unknown;
        result_summary?: unknown;
        error?: unknown;
        used_requests?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
        failure_code?: unknown;
      };
      if (body.status !== 'completed' && body.status !== 'failed') {
        return c.json({ error: 'status must be "completed" or "failed"' }, 400);
      }
      const asCount = (v: unknown): number | undefined =>
        Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined;

      const done = await controller.handleRunnerCompletion(auth.run.id, {
        status: body.status,
        result_summary: typeof body.result_summary === 'string' ? body.result_summary.slice(0, 4000) : undefined,
        error: typeof body.error === 'string' ? body.error.slice(0, 4000) : undefined,
        used_requests: asCount(body.used_requests),
        input_tokens: asCount(body.input_tokens),
        output_tokens: asCount(body.output_tokens),
        failure_code: typeof body.failure_code === 'string' ? body.failure_code.slice(0, 80) : undefined,
      });
      if (!done) return c.json({ error: 'Run already finalized' }, 409);
      return c.json({ ok: true, status: done.status });
    });
}
