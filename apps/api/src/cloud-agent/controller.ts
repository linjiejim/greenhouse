/**
 * Cloud Agent controller — queue admission, container lifecycle, reaper.
 *
 * Pure orchestration over durable state (design: docs/specs/20260731-
 * cloud-agent-runtime.md, D9): `agent_runs` rows are the state machine,
 * containers are dockerd's children (they survive pm2 restarts), and every
 * transition is a compare-and-set so cancel/complete/reap races resolve to
 * exactly one winner. There is no in-memory queue — pump() recomputes
 * admission from the DB each pass, so a restart loses nothing.
 *
 * Credential lifecycle: each run gets a dedicated relay key (LLM quota
 * attribution) + a signed task token (event/artifact push). Both die with the
 * run: the key is disabled in finalize, the token expires at the wall budget.
 */

import { logger } from '@greenhouse/utils/logger';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { createAgentRunId, type DatabaseProvider, type AgentRunRow, type AgentWorkspaceRow } from '@greenhouse/db';
import { AGENT_RUN_SERVER_SEQ_BASE } from '@greenhouse/types/cloud-agent';
import type { ServerWsEvent } from '@greenhouse/types/ws';

import { generateApiKey } from '../auth/api-key.js';
import { createTaskToken } from '../auth/task-token.js';
import type { SandboxRunnerConfig } from './config.js';
import { containerNameFor, DockerControlPlaneError, type DockerCli } from './docker.js';
import {
  assertRunInputsReady,
  discardRunInputs,
  prepareRunDirs,
  prepareRunInputMountpoint,
  prepareRunInputs,
  promptPathFor,
  runInputsDirFor,
  runInputsPresent,
} from './workspace.js';
import { sweepWorkspaceArtifacts } from './artifact-sweep.js';
import {
  buildSessionTranscript,
  TRANSCRIPT_FILE_NAME,
  transcriptPromptNote,
  uniqueInputName,
} from './conversation-transcript.js';
import { ensureSkillsSynced } from './skills-sync.js';
import { getObjectAtKey } from '../storage/uploads.js';
import { sanitizeUploadName } from '../storage/filename.js';
import { isOwnedAttachmentKey } from './attachment-keys.js';
import { WorkspaceQuotaAttestationError, type AssertUserWorkspaceQuota } from './quota-preflight.js';
import { relayOutputLimits } from './model-limits.js';
import { abortMissionRelayRequests } from './relay-requests.js';
import {
  archiveRunJournal,
  archiveStaleWorkspaces,
  measureWorkspaceBytes,
  restoreWorkspaceIfArchived,
  WorkspaceMeasurementLimitError,
} from './workspace-lifecycle.js';

const ACTIVE: ReadonlyArray<AgentRunRow['status']> = ['starting', 'running'];
/** Container-exited grace before the reaper declares a run dead — the runner
 * POSTs completion right before exiting, and that request may still be in
 * flight when tick() inspects the container. Completion updates the row, so
 * a fresh updated_at defers judgment to the next tick. */
const DEFAULT_EXIT_GRACE_MS = 90_000;

export interface EnqueueRunInput {
  title: string;
  prompt: string;
  model: string;
  fallbackModel: string | null;
  /** Reuse an existing workspace (mission follow-up); ownership is validated by the route. */
  workspaceId?: number | null;
  /** Mission conversation this run speaks through; ownership is validated by the route. */
  sessionId?: string | null;
  /**
   * Files to materialize in the workspace's `inputs/`, route-validated. Two
   * handle kinds, both resolving to an object already in storage — nothing is
   * ever copied:
   *   `key` — a mission staging blob (the sprouty-mission preset)
   *   `id`  — a `chat_files` row attached to the conversation (dispatch cards)
   */
  attachments?: Array<{ key?: string; id?: string; name: string }>;
  dispatchId?: string | null;
  /** Mission-ready Skill Center skill to run — route-validated; prepends a usage preamble to the runner prompt. */
  skillName?: string | null;
  /**
   * Composer direct-launch: the prompt is the user's own typed words, so write
   * it as their turn — and, because those words lean on what the conversation
   * already produced, hand the sandbox that conversation as `./inputs/` file
   * (see conversation-transcript.ts).
   */
  writeUserTurn?: boolean;
  maxWallMs?: number;
  maxRequests?: number;
}

export interface RunnerCompletionInput {
  status: 'completed' | 'failed';
  result_summary?: string;
  error?: string;
  used_requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  failure_code?: string;
}

export interface CloudAgentControllerDeps {
  db: DatabaseProvider;
  docker: DockerCli;
  config: SandboxRunnerConfig;
  /** Test seam — production uses the default. */
  exitGraceMs?: number;
  /**
   * Lifecycle push to the run owner (id + status only, never content — the
   * timeline stays on the event replay endpoint; session-modes spec D7).
   * Injected so the controller stays free of the WS layer; production wires
   * connectionManager in index.ts.
   */
  notify?: (userId: string, event: ServerWsEvent) => void;
  /** Close global admission when Docker can no longer prove execution state. */
  onExecutionPlaneFailure?: (error: DockerControlPlaneError) => void;
  /** Fresh kernel proof for `<dataRoot>/homes/<userId>` on each admission. */
  assertUserWorkspaceQuota: AssertUserWorkspaceQuota;
}

export function createCloudAgentController({
  db,
  docker,
  config,
  exitGraceMs = DEFAULT_EXIT_GRACE_MS,
  notify,
  onExecutionPlaneFailure,
  assertUserWorkspaceQuota,
}: CloudAgentControllerDeps) {
  let pumping = false;
  let pumpAgain = false;
  let lastArchiveSweepAt = 0;
  let executionPlaneFailed = false;
  let startsInFlight = 0;
  const startDrainWaiters = new Set<() => void>();

  function reportExecutionPlaneFailure(err: unknown): boolean {
    if (!(err instanceof DockerControlPlaneError)) return false;
    executionPlaneFailed = true;
    onExecutionPlaneFailure?.(err);
    return true;
  }

  /**
   * Close admission synchronously, then resolve only after every claim/start
   * operation that was already in flight has drained. Runtime containment
   * must await this barrier: otherwise a delayed `docker run` can return a
   * live container after quarantine has already reported success.
   */
  function closeAdmission(): Promise<void> {
    executionPlaneFailed = true;
    if (startsInFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => startDrainWaiters.add(resolve));
  }

  function beginStart(): void {
    startsInFlight += 1;
  }

  function endStart(): void {
    startsInFlight -= 1;
    if (startsInFlight !== 0) return;
    for (const resolve of startDrainWaiters) resolve();
    startDrainWaiters.clear();
  }

  /** Push a run's current state to its owner. Never throws into a transition. */
  function emitRunState(run: AgentRunRow): void {
    try {
      notify?.(run.user_id, {
        type: 'mission:run',
        runId: run.id,
        sessionId: run.session_id,
        status: run.status,
      });
    } catch (err) {
      logger.error('[cloud-agent] failed to push run state', { runId: run.id, err: String(err) });
    }
  }

  /**
   * Terminal marker for the run timeline when the CONTROL PLANE ended the run
   * (cancel, wall budget, container lost) — the runner never got to emit one,
   * so without this the timeline just stops mid-step with no closing row.
   *
   * The seq lives in a reserved high segment: the runner owns its own counter
   * and the api holds no copy, and a lower seq would fall behind clients'
   * `?after=` cursor and never be delivered. Duplicate (run_id, seq) rows are
   * dropped by the unique index, so a repeat is a no-op.
   */
  async function appendServerTerminalEvent(run: AgentRunRow): Promise<void> {
    if (run.status !== 'canceled' && run.status !== 'failed') return;
    try {
      await db.agentRuns.appendEvents(run.id, [
        {
          seq: AGENT_RUN_SERVER_SEQ_BASE + 1,
          type: run.status === 'canceled' ? 'run.canceled' : 'run.failed',
          payload: JSON.stringify({ source: 'controller', ...(run.error ? { error: run.error } : {}) }),
        },
      ]);
    } catch (err) {
      logger.error('[cloud-agent] failed to append terminal event', { runId: run.id, err: String(err) });
    }
  }

  /**
   * Attach deliverables the runner never uploaded, and give each a timeline
   * row so a recovered file is visibly a recovered file.
   *
   * Ordered BEFORE the outcome message on purpose: that message embeds the
   * artifact list, so sweeping afterwards would recover the bytes but leave
   * the user's chat card claiming there were none.
   *
   * On a run the CONTROL PLANE ended (cancel, reaper, boot sweep), the sweep's
   * declines get rows too, for the same reason the runner's do: an
   * `artifact.skipped` row is the user's only clue that a file is missing from
   * an otherwise settled run, and on these paths the runner never got to emit
   * any. On a runner-reported terminal the runner's own upload pass already
   * reported its declines, and the sweep re-declining the same files (an
   * oversize deliverable, the per-run ceiling) would double every row — so
   * there the sweep recovers silently. Skip seqs live in a fixed sub-band
   * above the recovered rows (recovered ≤ MAX_ARTIFACTS_PER_RUN = 50) so a
   * repeat settle numbers the same skips identically and the (run_id, seq)
   * unique index dedupes them — a seq derived from this attempt's recovered
   * count would renumber on the retry and duplicate every skip row.
   */
  async function recoverArtifacts(run: AgentRunRow, opts: { runnerReported?: boolean } = {}): Promise<void> {
    const SWEEP_SKIP_SEQ_OFFSET = 100;
    const pending: Array<{ path: string; bytes: number }> = [];
    const result = await sweepWorkspaceArtifacts(db, config, run, (path, bytes) => pending.push({ path, bytes }));
    const { recovered } = result;
    const skipped = opts.runnerReported ? [] : result.skipped;
    if (recovered === 0 && skipped.length === 0) return;
    try {
      await db.agentRuns.appendEvents(run.id, [
        ...pending.map((item, index) => ({
          // Reserved high segment, same reason as the terminal marker: clients
          // replay with `?after=<lastSeq>`, so anything below the runner's last
          // seq would never be fetched. +2 upward keeps the terminal marker at
          // +1 sorting first among control-plane rows.
          seq: AGENT_RUN_SERVER_SEQ_BASE + 2 + index,
          type: 'artifact.created' as const,
          payload: JSON.stringify({ path: item.path, bytes: item.bytes, recovered: true }),
        })),
        ...skipped.map((item, index) => ({
          seq: AGENT_RUN_SERVER_SEQ_BASE + SWEEP_SKIP_SEQ_OFFSET + index,
          type: 'artifact.skipped' as const,
          payload: JSON.stringify({ path: item.path, reason: item.reason, source: 'controller' }),
        })),
      ]);
    } catch (err) {
      logger.error('[cloud-agent] failed to append recovered artifact events', { runId: run.id, err: String(err) });
    }
  }

  /**
   * Everything a winning terminal CAS owes the user, in one place.
   *
   * `settled_at` marks exactly one thing: **the user has their result**. The
   * client keys its transcript reload on it (`use-mission-run`), so anything
   * that blocks it hides a delivered outcome behind a manual page reload.
   * Therefore only the outcome message — artifacts recovered first, since that
   * message embeds their list — gates it.
   *
   * Journal archiving and workspace byte accounting are diagnostics and quota
   * bookkeeping: nobody is waiting on them, and their failures are typically
   * environmental (bad object-storage credentials) rather than transient, so
   * gating on them wedges the run's UI permanently while retrying forever
   * changes nothing. They log and move on — best effort, and honestly so.
   * `recoverUnsettledRuns` therefore retries precisely what is worth retrying:
   * an outcome the user never received.
   */
  async function settle(run: AgentRunRow, opts: { runnerReported?: boolean } = {}): Promise<void> {
    if (!opts.runnerReported) await appendServerTerminalEvent(run);
    emitRunState(run);
    await finalize(run);
    let delivered = true;
    await recoverArtifacts(run, opts);
    try {
      await archiveRunJournal(db, config, run);
    } catch (err) {
      logger.error('[cloud-agent] failed to archive run journal', { runId: run.id, err: String(err) });
    }
    try {
      const workspace = await db.agentRuns.getWorkspaceById(run.workspace_id);
      if (workspace?.status === 'active') {
        const diskBytes = await measureWorkspaceBytes(config, workspace);
        await db.agentRuns.updateWorkspace(workspace.id, { disk_bytes: diskBytes, last_used_at: nowIso() });
      }
    } catch (err) {
      logger.error('[cloud-agent] failed to account workspace bytes', { runId: run.id, err: String(err) });
    }
    try {
      await enqueueOutcomeMessage(run);
      await drainOutcomeOutbox();
    } catch (err) {
      delivered = false;
      logger.error('[cloud-agent] failed to enqueue outcome message', { runId: run.id, err: String(err) });
    }
    if (delivered) {
      const settled = await db.agentRuns.updateRun(run.id, { settled_at: nowIso() });
      if (settled) emitRunState(settled);
    }
  }

  async function disableRelayKey(run: AgentRunRow): Promise<void> {
    if (!run.relay_client_id) return;
    try {
      await db.apiClients.update(run.relay_client_id, { status: 'disabled' });
    } catch (err) {
      logger.error('[cloud-agent] failed to disable relay key', { runId: run.id, err: String(err) });
    }
  }

  /** Post-terminal cleanup. Idempotent; safe to repeat from the boot sweep. */
  async function finalize(run: AgentRunRow): Promise<void> {
    abortMissionRelayRequests(run.id, `mission_${run.status}`);
    await disableRelayKey(run);
    try {
      await docker.removeContainer(containerNameFor(run.id));
    } catch (err) {
      reportExecutionPlaneFailure(err);
      throw err;
    }
  }

  /**
   * Disable run-scoped relay keys that survived a control-plane crash before
   * their id was checkpointed onto agent_runs. The run id also lives in the
   * api_clients metadata specifically so boot reconciliation can close this
   * narrow credential leak window.
   */
  async function disableOrphanRelayKeys(activeRunIds: ReadonlySet<string>): Promise<void> {
    const clients = await db.apiClients.list();
    for (const client of clients) {
      if (client.channel !== 'relay' || client.status !== 'active') continue;
      const parsedMeta = safeJsonParse(client.meta, {});
      const meta =
        parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)
          ? (parsedMeta as Record<string, unknown>)
          : {};
      const runId = typeof meta.cloud_agent_run_id === 'string' ? meta.cloud_agent_run_id : null;
      if (!runId || activeRunIds.has(runId)) continue;
      try {
        await db.apiClients.update(client.id, { status: 'disabled' });
      } catch (err) {
        logger.error('[cloud-agent] failed to disable orphan relay key', {
          clientId: client.id,
          runId,
          err: String(err),
        });
      }
    }
  }

  /**
   * A conversation whose messages are entirely server-written (the
   * `sprouty-mission` preset). Tool-dispatched runs live in ordinary chats
   * instead, where the user speaks for themselves — see enqueueRun.
   */
  async function isMissionConversation(sessionId: string): Promise<boolean> {
    const session = await db.sessions.getById(sessionId);
    return session?.channel === 'mission';
  }

  async function buildOutcomeContent(run: AgentRunRow): Promise<string> {
    if (run.status === 'canceled') return 'Mission canceled.';
    if (run.status !== 'completed') return `Mission failed: ${run.error ?? 'unknown error'}`;

    let content =
      run.result_summary?.trim() ||
      'Mission completed, but the sandbox agent returned no final summary — see the task timeline for what happened.';
    const artifacts = await db.agentRuns.listArtifacts(run.id);
    if (artifacts.length > 0) {
      const items = artifacts.map((artifact) => ({
        id: artifact.id,
        run_id: run.id,
        path: artifact.path,
        size_bytes: artifact.size_bytes,
        content_type: artifact.content_type,
      }));
      content += `\n\n\`\`\`mission-artifacts\n${JSON.stringify(items)}\n\`\`\``;
    }
    return content;
  }

  async function enqueueOutcomeMessage(run: AgentRunRow): Promise<void> {
    if (!run.session_id) return;
    await db.agentRuns.enqueueOutcome({
      run_id: run.id,
      session_id: run.session_id,
      message_id: `cloud-agent-outcome:${run.id}`,
      content: await buildOutcomeContent(run),
    });
  }

  async function ensureMissingOutcomes(): Promise<void> {
    for (const run of await db.agentRuns.listRunsMissingOutcome()) {
      try {
        await enqueueOutcomeMessage(run);
      } catch (err) {
        logger.error('[cloud-agent] failed to rebuild missing outcome', { runId: run.id, err: String(err) });
      }
    }
  }

  async function drainOutcomeOutbox(): Promise<void> {
    for (const item of await db.agentRuns.listPendingOutcomes()) {
      try {
        await db.sessions.addMessageOnce(item.message_id, {
          session_id: item.session_id,
          role: 'assistant',
          content: item.content,
        });
        await db.agentRuns.markOutcomeDelivered(item.run_id);
      } catch (err) {
        await db.agentRuns.markOutcomeFailed(item.run_id, toErrorMessage(err));
      }
    }
  }

  /** Resume a process that died after the terminal CAS but before settle(). */
  async function recoverUnsettledRuns(): Promise<void> {
    for (const run of await db.agentRuns.listUnsettledTerminalRuns()) {
      try {
        const events = await db.agentRuns.listEvents(run.id, { limit: 1000 });
        const hasTerminalEvent = events.some(
          (event) => event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.canceled',
        );
        await settle(run, { runnerReported: hasTerminalEvent });
      } catch (err) {
        logger.error('[cloud-agent] failed to recover unsettled run', { runId: run.id, err: String(err) });
      }
    }
  }

  async function startRun(run: AgentRunRow): Promise<void> {
    // `claimNextQueuedRun` committed queued → starting under the global DB
    // admission lock before this Docker work begins.
    emitRunState(run);

    try {
      // Queued rows may predate this process or an ops quota repair. Re-attest
      // immediately before touching the workspace or issuing credentials so a
      // stale/project-0 home can never reach Docker.
      await assertUserWorkspaceQuota(run.user_id);
      const owner = await db.users.getById(run.user_id);
      if (!owner || owner.status !== 'active' || (owner.role !== 'team' && owner.role !== 'super')) {
        const canceled = await db.agentRuns.transitionRun(run.id, ['starting'], {
          status: 'canceled',
          failure_code: 'account_unavailable',
          error: 'Run owner account is unavailable',
          ended_at: nowIso(),
        });
        if (canceled) await settle(canceled);
        return;
      }
      const dirs = await prepareRunDirs(config.dataRoot, run.user_id, run.workspace_id, run.id, run.prompt);
      const inputDir = runInputsDirFor(config.dataRoot, run.user_id, run.workspace_id, run.id);
      // Ask the staging directory, not `input_manifest` — the manifest lists
      // user attachments only, and `inputs/` also carries the launch
      // conversation transcript, which deliberately is not an attachment.
      const hasInputs = await runInputsPresent(inputDir);
      if (hasInputs) {
        await assertRunInputsReady(inputDir);
        await prepareRunInputMountpoint(dirs.workspaceDir);
      }
      await db.agentRuns.updateWorkspace(run.workspace_id, { last_used_at: nowIso() });

      const allowedModels = [run.model, ...(run.fallback_model ? [run.fallback_model] : [])];
      const { raw: relayKey, hash } = generateApiKey();
      const relayClient = await db.apiClients.create({
        app_id: `cloud-agent-${run.id}`,
        app_name: `Sandbox Runner ${run.id}`,
        api_key_hash: hash,
        user_id: run.user_id,
        channel: 'relay',
        created_by: run.user_id,
        meta: { allowed_models: allowedModels, cloud_agent_run_id: run.id },
      });
      await db.agentRuns.updateRun(run.id, { relay_client_id: relayClient.id });

      const taskToken = createTaskToken(run.user_id, run.id, run.max_wall_ms);

      // CLOUD_AGENT_SKILLS_DIR pins an ops-managed dir; otherwise the shared
      // dir is materialized from the Skill Center (TTL-throttled, fail-open
      // to the last good copy). Pi discovers ~/.agents/skills natively.
      const skillsDir = config.skillsDir ?? (await ensureSkillsSynced(db, config.dataRoot));
      const mounts = [
        { host: dirs.workspaceDir, container: '/workspace' },
        ...(hasInputs
          ? [
              {
                host: inputDir,
                container: '/workspace/inputs',
                readonly: true,
              },
            ]
          : []),
        { host: dirs.sessionDir, container: '/session' },
        ...(skillsDir ? [{ host: skillsDir, container: '/home/agent/.agents/skills', readonly: true }] : []),
      ];
      const containerId = await docker.startContainer({
        runId: run.id,
        image: config.image,
        network: config.network,
        memory: config.memory,
        cpus: config.cpus,
        runtime: config.dockerRuntime,
        mounts,
        env: {
          GREENHOUSE_RUN_ID: run.id,
          GREENHOUSE_TASK_TOKEN: taskToken,
          GREENHOUSE_API_BASE: config.apiBase,
          GREENHOUSE_RELAY_KEY: relayKey,
          GREENHOUSE_MODEL: run.model,
          GREENHOUSE_FALLBACK_MODEL: run.fallback_model ?? '',
          // The relay's per-model output caps: the runner declares them to
          // its SDK so no request ever asks for more than the relay accepts.
          GREENHOUSE_MODEL_MAX_TOKENS: JSON.stringify(relayOutputLimits([run.model, run.fallback_model])),
          GREENHOUSE_MAX_REQUESTS: String(run.max_requests),
          GREENHOUSE_PROMPT_PATH: promptPathFor(run.id),
        },
      });

      // A concurrent execution-plane failure may close admission while Docker
      // is still creating this container. Tear down any late success before it
      // can be published as running.
      if (executionPlaneFailed) {
        await docker.removeContainer(containerId);
        throw new DockerControlPlaneError('Mission admission closed while starting the sandbox container');
      }

      const running = await db.agentRuns.transitionRun(run.id, ['starting'], {
        status: 'running',
        container_id: containerId,
      });
      // The DB transition above is an await boundary. A control-plane failure
      // may have closed admission after the pre-transition check; suppress the
      // running notification and remove the late container. Quarantine runs
      // after the start barrier and terminalizes the row if this CAS won.
      if (executionPlaneFailed) {
        await docker.removeContainer(containerId);
        throw new DockerControlPlaneError('Mission admission closed while publishing the sandbox container');
      }
      if (!running) {
        // Canceled during startup: the cancel path won the CAS; tear down the
        // container it could not have known about yet.
        const current = await db.agentRuns.getRunById(run.id);
        await finalize(current ?? { ...run, relay_client_id: relayClient.id });
        return;
      }
      emitRunState(running);
      logger.info('[cloud-agent] run started', { runId: run.id, containerId });
    } catch (err) {
      reportExecutionPlaneFailure(err);
      const message = toErrorMessage(err);
      logger.error('[cloud-agent] run failed to start', { runId: run.id, err: message });
      const failed = await db.agentRuns.transitionRun(run.id, ['starting'], {
        status: 'failed',
        failure_code:
          err instanceof WorkspaceQuotaAttestationError ? 'workspace_quota_unverified' : 'runtime_start_failed',
        error: `failed to start: ${message}`,
        ended_at: nowIso(),
      });
      if (failed) await settle(failed);
      else {
        const current = await db.agentRuns.getRunById(run.id);
        if (current) await finalize(current);
      }
    }
  }

  const controller = {
    closeAdmission,
    /**
     * Create workspace + run rows. Admission is a separate pump() call — the
     * route fires it without awaiting so enqueue latency never includes a
     * docker start.
     */
    async enqueueRun(userId: string, input: EnqueueRunInput): Promise<AgentRunRow> {
      if (executionPlaneFailed) throw new Error('Mission runtime admission is closed');
      // Run before creating a workspace row or any host directory. A missing
      // newly-created user's quota must fail closed instead of letting mkdir()
      // create a project-0 tree that later escapes the per-user hard limit.
      await assertUserWorkspaceQuota(userId);
      if (input.dispatchId) {
        const existing = await db.agentRuns.getRunByDispatchId(input.dispatchId);
        if (existing) {
          if (existing.user_id !== userId) throw new Error('Dispatch ID is already owned by another user');
          return existing;
        }
      }

      // A named skill must actually be in the sandbox mount: the route
      // validated it against the DB, but the TTL-throttled sync may not have
      // materialized a skill published/reviewed/updated within the last few
      // minutes. Force a pass now (no-op when nothing changed; failures fall
      // back to the last good directory — same policy as run start). A pinned
      // CLOUD_AGENT_SKILLS_DIR is ops-managed and never synced.
      if (input.skillName && !config.skillsDir) {
        await ensureSkillsSynced(db, config.dataRoot, { force: true });
      }

      let workspaceId = input.workspaceId ?? null;
      if (!workspaceId && input.sessionId) {
        const session = await db.sessions.getById(input.sessionId);
        if (!session || session.user_id !== userId) throw new Error('Conversation not found');
        const agentId = await db.coworkers.scopeForSession(input.sessionId);
        if (agentId) workspaceId = await db.coworkers.ensureWorkspace(agentId, userId, input.title);
      }
      let workspace: AgentWorkspaceRow;
      if (!workspaceId) {
        workspace = await db.agentRuns.createWorkspace({ user_id: userId, name: input.title });
        workspaceId = workspace.id;
      } else {
        const existingWorkspace = await db.agentRuns.getWorkspaceById(workspaceId);
        if (!existingWorkspace || existingWorkspace.user_id !== userId) throw new Error('Workspace not found');
        workspace = await restoreWorkspaceIfArchived(db, config, existingWorkspace);
      }

      // Resolve uploaded inputs before the run becomes queue-visible. Their
      // bytes are materialized into a host-only, per-run directory below;
      // never write through the sandbox-owned workspace tree.
      //
      // The staging blob is deliberately KEPT (it used to be deleted right
      // here "so storage holds no second copy"). The conversation outlives the
      // workspace — missions render their inputs as downloadable chips forever,
      // so the object store has to stay the source of truth for them, exactly
      // as it already is for artifacts. Lifetime follows the workspace
      // archival policy, not the run.
      const resolvedAttachments: Array<{
        key?: string;
        id?: string;
        name: string;
        buffer: Buffer;
        content_type: string;
      }> = [];
      for (const att of input.attachments ?? []) {
        const safeName = sanitizeUploadName(att.name);
        if (!safeName) throw new Error('Attachment filename is malformed');
        // Resolve either handle to its storage key. A chat_files attachment is
        // read straight from where it already lives — promoting a chat file
        // into a sandbox copies no bytes (convergence spec D4).
        let storageKey = att.key;
        if (storageKey && !isOwnedAttachmentKey(userId, storageKey)) {
          throw new Error('Attachment key is outside the run owner namespace');
        }
        if (!storageKey && att.id) {
          const chatFile = await db.chatFiles.getById(att.id);
          if (
            !chatFile ||
            chatFile.created_by !== userId ||
            (input.sessionId != null && chatFile.session_id !== input.sessionId)
          ) {
            throw new Error('Chat attachment is outside the run owner session');
          }
          storageKey = chatFile.storage_key;
        }
        if (!storageKey) continue;
        const stored = await getObjectAtKey(storageKey);
        if (!stored) continue; // expired/duplicate use — skip, never fail the run
        resolvedAttachments.push({
          ...(att.id ? { id: att.id } : { key: storageKey }),
          name: safeName,
          buffer: stored.buffer,
          content_type: stored.contentType,
        });
      }

      // A direct launch's brief is the user's own words, and those words point
      // at what the conversation already produced — which the sandbox cannot
      // see. Hand it the conversation as a file rather than as prompt text
      // (conversation-transcript.ts). The dispatch-card path is excluded on
      // purpose: there a model that CAN see the chat wrote a self-contained
      // brief. Session ownership was validated by the route.
      const transcript =
        input.writeUserTurn && input.sessionId ? await buildSessionTranscript(db, input.sessionId) : null;
      const transcriptBuffer = transcript ? Buffer.from(transcript, 'utf8') : null;

      const measuredBytes = await measureWorkspaceBytes(config, workspace);
      await db.agentRuns.updateWorkspace(workspace.id, { disk_bytes: measuredBytes });
      const totalBefore = await db.agentRuns.sumWorkspaceDiskByUser(userId);
      const inputBytes =
        resolvedAttachments.reduce((sum, attachment) => sum + attachment.buffer.length, 0) +
        (transcriptBuffer?.length ?? 0);
      if (totalBefore + inputBytes > config.userDiskQuotaBytes) {
        throw new Error(
          `Mission workspace quota exceeded (${totalBefore + inputBytes} > ${config.userDiskQuotaBytes} bytes)`,
        );
      }

      const attachedNames: string[] = [];
      const attachmentChips: Array<{
        key?: string;
        id?: string;
        name: string;
        size_bytes: number;
        content_type: string;
      }> = [];
      for (const attachment of resolvedAttachments) {
        const name = attachedNames.includes(attachment.name)
          ? `${attachedNames.length}-${attachment.name}`
          : attachment.name;
        attachedNames.push(name);
        attachmentChips.push({
          ...(attachment.id ? { id: attachment.id } : { key: attachment.key }),
          name,
          size_bytes: attachment.buffer.length,
          content_type: attachment.content_type,
        });
      }
      // A skill run's task statement is the skill preamble + the user's brief
      // (which may be empty — the skill's own SKILL.md is the task then). The
      // preamble goes into the run row and the runner prompt; the user turn
      // written below keeps only the user's own words.
      const taskPrompt = input.skillName
        ? `Use the installed agent skill "${input.skillName}" for this task: read ~/.agents/skills/${input.skillName}/SKILL.md first and follow it.` +
          (input.prompt
            ? `\n\n${input.prompt}`
            : `\n\nNo further brief was given — carry out the skill's own workflow and deliver what it describes.`)
        : input.prompt;
      // The transcript is not a user attachment: it gets no chip, no manifest
      // entry and no mention in the "the user attached N file(s)" line — it is
      // named by its own note so the two stay distinguishable in the sandbox.
      const transcriptName = transcriptBuffer ? uniqueInputName(TRANSCRIPT_FILE_NAME, attachedNames) : null;
      const runnerPrompt = [
        taskPrompt,
        attachedNames.length > 0
          ? `[The user attached ${attachedNames.length} file(s), available in ./inputs/: ${attachedNames.join(', ')}]`
          : '',
        transcriptName ? transcriptPromptNote(transcriptName) : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const runId = createAgentRunId();
      await prepareRunInputs(config.dataRoot, userId, workspaceId, runId, [
        ...resolvedAttachments.map((attachment, index) => ({
          name: attachedNames[index]!,
          buffer: attachment.buffer,
        })),
        ...(transcriptBuffer && transcriptName ? [{ name: transcriptName, buffer: transcriptBuffer }] : []),
      ]);

      let run: AgentRunRow;
      try {
        run = await db.agentRuns.createRun({
          id: runId,
          user_id: userId,
          workspace_id: workspaceId,
          dispatch_id: input.dispatchId ?? null,
          title: input.title,
          original_prompt: taskPrompt,
          prompt: runnerPrompt,
          input_manifest: JSON.stringify(attachmentChips),
          model: input.model,
          fallback_model: input.fallbackModel,
          session_id: input.sessionId ?? null,
          max_wall_ms: input.maxWallMs,
          max_requests: input.maxRequests,
        });
      } catch (err) {
        await discardRunInputs(config.dataRoot, userId, workspaceId, runId);
        if (input.dispatchId && isUniqueViolation(err)) {
          const existing = await db.agentRuns.getRunByDispatchId(input.dispatchId);
          if (existing?.user_id === userId) return existing;
        }
        throw err;
      }
      const finalBytes = await measureWorkspaceBytes(config, workspace);
      await db.agentRuns.updateWorkspace(workspace.id, { disk_bytes: finalBytes, last_used_at: nowIso() });
      // The mission conversation is server-written on both ends (spec D2):
      // the prompt lands as the user turn here, the outcome as the assistant
      // turn at finalization.
      //
      // ONLY when the prompt is genuinely the user's own words: a mission
      // conversation (channel='mission', server-written on both ends) or the
      // composer's direct skill launch (writeUserTurn — the brief was typed
      // into the composer). When the run was dispatched by the
      // `mission_dispatch` tool from an ordinary chat, that conversation
      // already holds the user's real turn plus the task card showing this
      // prompt verbatim — writing another "user" message would put words the
      // user never typed into their own bubble (session-modes spec D5). The
      // assistant outcome message is written on ALL paths.
      if (input.sessionId && (input.writeUserTurn || (await isMissionConversation(input.sessionId)))) {
        if (input.prompt || attachmentChips.length > 0) {
          // Rendered as chips by the web's attachments fence handler; degrades
          // to a visible JSON block elsewhere (same contract as the
          // mission-artifacts fence on the assistant side).
          const fence =
            attachmentChips.length > 0 ? `\`\`\`attachments\n${JSON.stringify(attachmentChips)}\n\`\`\`` : '';
          const messageContent = [input.prompt, fence].filter(Boolean).join('\n\n');
          await db.sessions.addMessage({ session_id: input.sessionId, role: 'user', content: messageContent });
          await db.sessions.touch(input.sessionId);
        }
        // First turn names the conversation — these paths never run the chat
        // title service, so an untitled session would stay "Untitled" forever.
        const session = await db.sessions.getById(input.sessionId);
        if (session && !session.title) await db.sessions.updateTitle(session.id, input.title);
      }
      // Tell every open surface of this user that a task now exists — the Task
      // Dock picks it up without waiting for its fallback poll, including in
      // the tab that did NOT press Launch.
      emitRunState(run);
      return run;
    },

    /**
     * Queue admission: global cap + one active run per user, recomputed from
     * the DB. Re-arms itself when called mid-pass (a wind-down must not
     * swallow a concurrent wake-up — same trap as workflow-engine's
     * ensureDriving).
     */
    async pump(): Promise<void> {
      if (executionPlaneFailed) return;
      if (pumping) {
        pumpAgain = true;
        return;
      }
      pumping = true;
      try {
        for (;;) {
          if (executionPlaneFailed) return;
          // Track the DB claim as part of the start operation too. Admission
          // can close while the claim transaction is awaiting PostgreSQL; the
          // barrier must not let quarantine finish before that newly-starting
          // row becomes visible.
          beginStart();
          try {
            const claimed = await db.agentRuns.claimNextQueuedRun(config.maxConcurrent);
            if (!claimed) return;
            if (executionPlaneFailed) return;
            await startRun(claimed);
          } finally {
            endStart();
          }
        }
      } finally {
        pumping = false;
        if (pumpAgain) {
          pumpAgain = false;
          void controller.pump().catch((err) => logger.error('[cloud-agent] pump failed', { err: String(err) }));
        }
      }
    },

    /** User-initiated cancel from any non-terminal status. */
    async cancelRun(runId: string): Promise<AgentRunRow | undefined> {
      const canceled = await db.agentRuns.transitionRun(runId, ['queued', 'starting', 'running'], {
        status: 'canceled',
        ended_at: nowIso(),
      });
      if (canceled) {
        await settle(canceled);
        await controller.pump();
      }
      return canceled;
    },

    /** Account-security suspension: cancel all queued and running work, then refill capacity once. */
    async cancelRunsForUser(userId: string): Promise<number> {
      const runs = await db.agentRuns.listNonTerminalRunsByUser(userId);
      let canceledCount = 0;
      for (const run of runs) {
        const canceled = await db.agentRuns.transitionRun(run.id, ['queued', 'starting', 'running'], {
          status: 'canceled',
          failure_code: 'account_unavailable',
          error: 'Run canceled because the owner credentials were suspended',
          ended_at: nowIso(),
        });
        if (!canceled) continue;
        canceledCount += 1;
        await settle(canceled);
      }
      if (canceledCount > 0) await controller.pump();
      return canceledCount;
    },

    /** Runner-reported completion (POST /internal/runs/:id/complete). */
    async handleRunnerCompletion(runId: string, input: RunnerCompletionInput): Promise<AgentRunRow | undefined> {
      const done = await db.agentRuns.transitionRun(runId, ['starting', 'running'], {
        status: input.status,
        result_summary: input.result_summary ?? null,
        failure_code: input.status === 'failed' ? (input.failure_code ?? 'runner_failed') : null,
        error: input.error ?? null,
        // Request admission is server-authoritative at the relay boundary.
        // The untrusted runner's tally is telemetry only and must never
        // overwrite the atomic counter (including by reporting a lower value).
        ...(input.input_tokens !== undefined ? { input_tokens: input.input_tokens } : {}),
        ...(input.output_tokens !== undefined ? { output_tokens: input.output_tokens } : {}),
        ended_at: nowIso(),
      });
      if (done) {
        // The runner already emitted its own run.completed / run.failed.
        await settle(done, { runnerReported: true });
        await controller.pump();
      }
      return done;
    },

    /**
     * Reaper pass: enforce wall-clock budgets and detect containers that died
     * without reporting completion. Runs on an interval; also frees capacity.
     */
    async tick(): Promise<void> {
      const active = await db.agentRuns.listActiveRuns();
      for (const run of active) {
        try {
          // Cheap safety checks go first. A hostile inode storm must never
          // delay the wall-clock/container reaper behind a recursive walk.
          const startedAtMs = run.started_at ? Date.parse(run.started_at) : Date.now();
          if (Date.now() - startedAtMs > run.max_wall_ms) {
            const timedOut = await db.agentRuns.transitionRun(run.id, [...ACTIVE], {
              status: 'failed',
              failure_code: 'wall_budget_exceeded',
              error: `wall-clock budget exceeded (${Math.round(run.max_wall_ms / 60_000)} min)`,
              ended_at: nowIso(),
            });
            if (timedOut) await settle(timedOut);
            continue;
          }
          if (run.status === 'running') {
            const state = await docker.inspectContainer(containerNameFor(run.id));
            if (!state || !state.running) {
              const updatedAtMs = Date.parse(run.updated_at);
              if (Date.now() - updatedAtMs >= exitGraceMs) {
                const logsTail = state ? await docker.tailLogs(containerNameFor(run.id), 20) : '';
                const failed = await db.agentRuns.transitionRun(run.id, ['running'], {
                  status: 'failed',
                  failure_code: state ? 'container_exited' : 'container_missing',
                  error: state
                    ? `container exited (code ${state.exitCode}) without reporting completion${logsTail ? `\n${logsTail.slice(-2000)}` : ''}`
                    : 'container disappeared',
                  ended_at: nowIso(),
                });
                if (failed) await settle(failed);
              }
              continue;
            }
          }

          const workspace = await db.agentRuns.getWorkspaceById(run.workspace_id);
          if (workspace?.status !== 'active') continue;
          let diskBytes: number;
          try {
            diskBytes = await measureWorkspaceBytes(config, workspace);
          } catch (error) {
            if (!(error instanceof WorkspaceMeasurementLimitError)) throw error;
            const unaccountable = await db.agentRuns.transitionRun(run.id, [...ACTIVE], {
              status: 'failed',
              failure_code: 'workspace_accounting_limit_exceeded',
              error: error.message,
              ended_at: nowIso(),
            });
            if (unaccountable) await settle(unaccountable);
            continue;
          }
          await db.agentRuns.updateWorkspace(workspace.id, { disk_bytes: diskBytes });
          const userBytes = await db.agentRuns.sumWorkspaceDiskByUser(run.user_id);
          if (userBytes > config.userDiskQuotaBytes) {
            const overQuota = await db.agentRuns.transitionRun(run.id, [...ACTIVE], {
              status: 'failed',
              failure_code: 'workspace_quota_exceeded',
              error: `workspace operational limit exceeded (${userBytes} > ${config.userDiskQuotaBytes} bytes)`,
              ended_at: nowIso(),
            });
            if (overQuota) await settle(overQuota);
          }
        } catch (err) {
          if (reportExecutionPlaneFailure(err)) {
            return;
          }
          // One unreadable workspace or transient Docker/DB error must not
          // block every other run and the durable-outcome drain on this pass.
          logger.error('[cloud-agent] run reaper pass failed', { runId: run.id, err: String(err) });
        }
      }
      await recoverUnsettledRuns();
      await ensureMissingOutcomes();
      await drainOutcomeOutbox();
      if (Date.now() - lastArchiveSweepAt >= 6 * 60 * 60_000) {
        lastArchiveSweepAt = Date.now();
        await archiveStaleWorkspaces(db, config);
      }
      await controller.pump();
    },

    /**
     * Startup reconciliation after an api restart (`pm2 delete && pm2 start`
     * on every deploy): DB says active but the container is gone → failed;
     * containers wearing our label without an active run → removed. Never
     * blocks main() — callers fire-and-forget.
     */
    async bootSweep(options: { pump?: boolean } = {}): Promise<void> {
      const active = await db.agentRuns.listActiveRuns();
      const activeIds = new Set(active.map((r) => r.id));

      for (const run of active) {
        const state = await docker.inspectContainer(containerNameFor(run.id));
        if (state?.running) {
          try {
            // A process restart is a fresh admission decision. Never inherit a
            // pre-upgrade/project-0 container merely because Docker survived.
            await assertUserWorkspaceQuota(run.user_id);
            continue; // still executing — runner will keep pushing events
          } catch (err) {
            if (!(err instanceof WorkspaceQuotaAttestationError)) throw err;
            await docker.removeContainer(containerNameFor(run.id));
            const failed = await db.agentRuns.transitionRun(run.id, [...ACTIVE], {
              status: 'failed',
              failure_code: 'workspace_quota_unverified',
              error: err.message,
              ended_at: nowIso(),
            });
            if (failed) await settle(failed);
            continue;
          }
        }
        const failed = await db.agentRuns.transitionRun(run.id, [...ACTIVE], {
          status: 'failed',
          failure_code: state ? 'container_exited_during_restart' : 'container_lost_during_restart',
          error: state
            ? `container exited (code ${state.exitCode}) while the api was down`
            : 'container lost across restart',
          ended_at: nowIso(),
        });
        if (failed) await settle(failed);
      }

      const containers = await docker.listAgentContainers();
      for (const container of containers) {
        if (!activeIds.has(container.runId)) {
          logger.warn('[cloud-agent] removing orphan container', { name: container.name, runId: container.runId });
          await docker.removeContainer(container.id);
        }
      }
      // Re-read after the transitions above: runs lost across restart are now
      // terminal, so every active cloud-agent relay key not in this set is stale.
      const activeAfterSweep = new Set((await db.agentRuns.listActiveRuns()).map((run) => run.id));
      await disableOrphanRelayKeys(activeAfterSweep);
      await recoverUnsettledRuns();
      await ensureMissingOutcomes();
      await drainOutcomeOutbox();
      lastArchiveSweepAt = Date.now();
      await archiveStaleWorkspaces(db, config);
      if (options.pump !== false) await controller.pump();
    },
  };
  return controller;
}

export type CloudAgentController = ReturnType<typeof createCloudAgentController>;
