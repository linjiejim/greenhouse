/**
 * Mission Sandbox Runner — the process PID 1 hands off to inside the isolated
 * runtime container (design: docs/specs/20260812-trusted-execution-platform-convergence.md).
 *
 * Drives one Pi coding-agent session in /workspace, journals every harness
 * event to /session/journal.jsonl (full fidelity, survives api restarts), and
 * pushes step-level events to the api's internal surface with retry — the DB
 * is the UI's source of truth, this process is disposable.
 *
 * Credentials in this process are run-scoped only: a relay key whose
 * api_clients row is disabled at end-of-run, and a task token that expires at
 * the wall budget. LLM traffic goes through the internal relay
 * (`$GREENHOUSE_API_BASE/api/llm/v1`, OpenAI-compatible); on upstream 429/quota
 * exhaustion the session downgrades to the fallback model and continues.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
// Type-only: the shared protocol contract is erased at compile time, so the
// image still installs nothing but pi-coding-agent (see docker/package.json).
// Emitting an event type not in this union is a typecheck failure here rather
// than an unrecognized row in the user's timeline.
import type { AgentRunEventType } from '@greenhouse/types/cloud-agent';
import { collectArtifacts, guessContentType } from './artifacts.js';
import { buildRelayModelsConfig, parseModelMaxTokens } from './models-config.js';
import { loadPlatformTools } from './platform-tools.js';
import { ensureWorkspaceContext } from './toolchain.js';

// ─── Environment ─────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[runner] missing required env: ${name}`);
    process.exit(2);
  }
  return value;
}

const RUN_ID = requireEnv('GREENHOUSE_RUN_ID');
const TASK_TOKEN = requireEnv('GREENHOUSE_TASK_TOKEN');
const API_BASE = requireEnv('GREENHOUSE_API_BASE').replace(/\/$/, '');
// Pi resolves `$GREENHOUSE_RELAY_KEY` from process.env; this read only validates
// the runner contract before the session is constructed.
const _RELAY_KEY = requireEnv('GREENHOUSE_RELAY_KEY');
const MODEL = requireEnv('GREENHOUSE_MODEL');
const FALLBACK_MODEL = process.env.GREENHOUSE_FALLBACK_MODEL || null;
const MODEL_MAX_TOKENS = parseModelMaxTokens(process.env.GREENHOUSE_MODEL_MAX_TOKENS);
const MAX_REQUESTS = Number(process.env.GREENHOUSE_MAX_REQUESTS ?? 300);
const PROMPT_PATH = process.env.GREENHOUSE_PROMPT_PATH ?? '/session/prompt.md';

const WORKSPACE = '/workspace';
const SESSION_DIR = '/session';
const ARTIFACTS_DIR = join(WORKSPACE, 'artifacts');
const JOURNAL_PATH = join(SESSION_DIR, 'journal.jsonl');
const PROVIDER_ID = 'greenhouse-relay';

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACTS = 50;
const PUSH_INTERVAL_MS = 2_000;
const HEARTBEAT_MS = 30_000;

// ─── Event pipeline (journal first, then push with retry) ─

interface OutboundEvent {
  seq: number;
  type: AgentRunEventType;
  payload: string;
}

/** Serialize the exact event payload for the permanent Mission timeline. */
function serializeEventPayload(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text;
}

class EventPipe {
  private queue: OutboundEvent[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  emit(type: AgentRunEventType, payload: Record<string, unknown>): void {
    this.seq += 1;
    const event = { seq: this.seq, type, payload: serializeEventPayload(payload) };
    appendFileSync(JOURNAL_PATH, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
    this.queue.push(event);
  }

  /** Full-fidelity journal line without an api push (text deltas etc.). */
  journalOnly(record: Record<string, unknown>): void {
    appendFileSync(JOURNAL_PATH, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), PUSH_INTERVAL_MS);
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.queue.slice(0, 200);
      const res = await fetch(`${API_BASE}/api/missions/internal/runs/${RUN_ID}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TASK_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      });
      // 4xx =永久拒绝（run 终态/鉴权失效），重试无意义；丢弃防止无限循环。
      // 5xx/网络错误 = api 部署重启窗口，保留队列下轮重推（seq 幂等）。
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        this.queue.splice(0, batch.length);
      }
    } catch {
      // network blip — keep the queue, the next tick retries
    } finally {
      this.flushing = false;
    }
  }

  async drain(attempts = 5): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (let i = 0; i < attempts && this.queue.length > 0; i++) {
      await this.flush();
      if (this.queue.length > 0) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

const pipe = new EventPipe();

// ─── Completion / artifacts ──────────────────────────────

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TASK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Follow-up runs share the workspace: earlier runs' artifacts are still in
// artifacts/, so this run prefers what it touched itself. The 5s slack absorbs
// container/host clock skew; anything older is REPORTED as skipped rather than
// dropped, and the control plane's terminal sweep re-checks the whole directory
// by content hash so a preserved timestamp can no longer lose a deliverable.
const RUN_STARTED_MS = Date.now();

export interface ArtifactUploadResult {
  uploaded: number;
  /** Deliverables that exist in the workspace but never reached the api. */
  failed: Array<{ path: string; reason: string }>;
  skipped: number;
}

/**
 * A failure here is the worst kind of silent: the agent wrote the file, sees it
 * on disk, and truthfully reports success — while the user gets a completed
 * mission with the deliverable missing (2026-07-31, a CJK-named report). So
 * failures get their own event type AND are surfaced in the outcome text, and
 * everything the collector declined to send gets an `artifact.skipped` row.
 */
async function uploadArtifacts(): Promise<ArtifactUploadResult> {
  let uploaded = 0;
  const failed: Array<{ path: string; reason: string }> = [];
  const { upload, skipped } = collectArtifacts({
    root: ARTIFACTS_DIR,
    freshSinceMs: RUN_STARTED_MS - 5_000,
    maxFiles: MAX_ARTIFACTS,
    maxBytes: MAX_ARTIFACT_BYTES,
  });
  for (const skip of skipped) {
    pipe.emit('artifact.skipped', {
      path: skip.path,
      reason: skip.reason,
      ...(skip.detail ? { detail: skip.detail } : {}),
    });
  }
  for (const candidate of upload) {
    const path = candidate.path;
    const fail = (reason: string) => {
      failed.push({ path, reason });
      pipe.emit('artifact.failed', { path, error: reason });
    };
    try {
      const buffer = readFileSync(candidate.absolutePath);
      let res: Response | null = null;
      let networkError: unknown;
      // Events and completion already retry across api restarts; deliverables
      // need the same durability. The endpoint is content-idempotent by
      // (run,path,sha256), so a response lost after commit is safe to replay.
      for (let attempt = 0; attempt < 5; attempt++) {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(buffer)]), path.split('/').pop() ?? 'artifact');
        form.append('path', path);
        form.append('content_type', guessContentType(path));
        try {
          res = await fetch(`${API_BASE}/api/missions/internal/runs/${RUN_ID}/artifacts`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TASK_TOKEN}` },
            body: form,
          });
          if (res.ok || (res.status >= 400 && res.status < 500)) break;
        } catch (err) {
          networkError = err;
        }
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
      }
      if (res?.ok) {
        uploaded += 1;
        pipe.emit('artifact.created', { path, bytes: buffer.length });
      } else if (!res) {
        fail(`upload failed after retries (${String(networkError ?? 'network error')})`);
      } else if (res.status === 409) {
        // The control plane already closed runner writes (cancel / wall budget
        // won the terminal CAS while this upload was in flight). Its terminal
        // sweep owns the directory now, so this is not a user-visible failure.
        console.error('[runner] artifact upload closed by control plane; terminal sweep will recover', path);
      } else {
        fail(`upload rejected (${res.status})`);
      }
    } catch (err) {
      fail(String(err));
    }
  }
  return { uploaded, failed, skipped: skipped.length };
}

interface RunTally {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  lastAssistantText: string;
}

async function reportCompletion(
  status: 'completed' | 'failed',
  tally: RunTally,
  error?: string,
  failureCode?: string,
): Promise<void> {
  await pipe.drain();
  const body = {
    status,
    result_summary: tally.lastAssistantText.slice(0, 4000) || undefined,
    error,
    failure_code: failureCode,
    used_requests: tally.requests,
    input_tokens: tally.inputTokens,
    output_tokens: tally.outputTokens,
  };
  for (let i = 0; i < 5; i++) {
    try {
      const res = await postJson(`/api/missions/internal/runs/${RUN_ID}/complete`, body);
      if (res.ok || res.status === 409) return;
    } catch {
      // retry below
    }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  console.error('[runner] failed to report completion after retries');
}

// ─── Provider config (written before the harness boots) ──

function writeModelsJson(): string {
  const modelsPath = join(SESSION_DIR, 'models.json');
  writeFileSync(
    modelsPath,
    JSON.stringify(
      buildRelayModelsConfig({
        providerId: PROVIDER_ID,
        apiBase: API_BASE,
        model: MODEL,
        fallbackModel: FALLBACK_MODEL,
        maxTokens: MODEL_MAX_TOKENS,
      }),
      null,
      2,
    ),
  );
  return modelsPath;
}

const QUOTA_ERROR_RE = /\b429\b|quota|rate.?limit|too many requests/i;

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const prompt = readFileSync(PROMPT_PATH, 'utf8');
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  // Deliverable convention and the sandbox toolchain inventory ride the project
  // context file, not a patched system prompt — pi reads AGENTS.md from cwd on
  // session start. The inventory is refreshed every run (the workspace outlives
  // the image it was created under), notes outside the managed block are kept.
  ensureWorkspaceContext(join(WORKSPACE, 'AGENTS.md'));

  const tally: RunTally = { requests: 0, inputTokens: 0, outputTokens: 0, lastAssistantText: '' };

  const modelsPath = writeModelsJson();
  const modelRuntime = await ModelRuntime.create({
    modelsPath,
    authPath: join(SESSION_DIR, 'auth.json'),
  });
  const model = modelRuntime.getModel(PROVIDER_ID, MODEL);
  if (!model) throw new Error(`model ${MODEL} not resolvable via ${PROVIDER_ID}`);

  // Owner-scoped platform tools (knowledge/projects/CRM/… per the user's
  // actual permissions); fail-open to a pure workspace agent if unreachable.
  const platformTools = await loadPlatformTools(API_BASE, TASK_TOKEN, {
    onManifest: (metrics) =>
      pipe.emit('run.heartbeat', { platform_tools: metrics.count, tool_schema_bytes: metrics.schema_bytes }),
    onApprovalRequested: (approval) => pipe.emit('tool.approval_requested', approval),
    onToolStarted: (call) => pipe.emit('tool.started', call),
    onToolCompleted: (call) => pipe.emit('tool.completed', call),
  });
  const platformToolNames = new Set(platformTools.map((tool) => tool.name));

  const { session } = await createAgentSession({
    cwd: WORKSPACE,
    agentDir: join(SESSION_DIR, 'agent'),
    modelRuntime,
    model,
    customTools: platformTools,
    sessionManager: SessionManager.continueRecent(WORKSPACE, join(SESSION_DIR, 'sessions')),
  });

  let sawQuotaError = false;
  let emittedRunStarted = false;
  /** Error marker of the most recent assistant message — null after a healthy one. */
  let lastErrorMessage: string | null = null;
  session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case 'agent_start':
        // Pi re-enters the agent loop on every provider-retry and follow-up
        // prompt; only the first entry is the run starting. Mapping them all
        // used to paint one "Run started" row per 429 retry on the timeline.
        if (emittedRunStarted) {
          pipe.journalOnly({ kind: 'agent_restart', model: session.model?.id ?? MODEL });
        } else {
          emittedRunStarted = true;
          pipe.emit('run.started', { model: session.model?.id ?? MODEL });
        }
        break;
      case 'message_update':
        // Full fidelity for replay/debugging; far too chatty for the DB.
        pipe.journalOnly({ kind: 'delta', ev: event.assistantMessageEvent });
        break;
      case 'message_end': {
        const message = event.message as {
          role?: string;
          content?: Array<{ type: string; text?: string }>;
          usage?: { input?: number; output?: number };
          errorMessage?: string;
        };
        if (message.role !== 'assistant') break;
        tally.requests += 1;
        tally.inputTokens += message.usage?.input ?? 0;
        tally.outputTokens += message.usage?.output ?? 0;
        const text = (message.content ?? [])
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text) {
          tally.lastAssistantText = text;
          pipe.emit('message.assistant', { text, model: session.model?.id });
        }
        lastErrorMessage = message.errorMessage ?? null;
        if (message.errorMessage && QUOTA_ERROR_RE.test(message.errorMessage)) sawQuotaError = true;
        break;
      }
      case 'tool_execution_start':
        // Platform-tool hooks persisted the exact pre-clipping input already.
        if (platformToolNames.has(event.toolName)) break;
        pipe.emit('tool.started', { tool: event.toolName, args: serializeEventPayload(event.args) });
        break;
      case 'tool_execution_end':
        // Platform-tool hooks persisted the exact HTTP result before the
        // model-facing 16 KB context guard was applied.
        if (platformToolNames.has(event.toolName)) break;
        pipe.emit('tool.completed', {
          tool: event.toolName,
          is_error: event.isError,
          result: serializeEventPayload(event.result),
        });
        break;
      default:
        break;
    }
  });

  pipe.start();
  const heartbeat = setInterval(() => pipe.emit('run.heartbeat', { requests: tally.requests }), HEARTBEAT_MS);

  // Request budget: abort the session once the cap is hit (provider quota is
  // deployment-shared — a runaway loop must not eat the whole team's budget).
  const budgetWatch = setInterval(() => {
    if (tally.requests >= MAX_REQUESTS) {
      void session.abort();
    }
  }, 1_000);

  /**
   * `session.prompt()` resolving is not the same as the turn succeeding: when
   * the provider keeps erroring, Pi retries with backoff and eventually gives
   * up by ENDING the loop on an errored assistant message instead of throwing
   * (observed 2026-08-03: four terminal provider 429s → an empty "completed" run
   * whose outcome message had nothing to say, and the fallback model never
   * engaged). Surface that ending as a real failure so the quota downgrade /
   * failed status below applies. A budget abort also ends on an error marker;
   * the request-budget check after this call owns that message, so it is not
   * shadowed here.
   */
  const promptOrThrow = async (text: string): Promise<void> => {
    lastErrorMessage = null;
    await session.prompt(text);
    if (lastErrorMessage && tally.requests < MAX_REQUESTS) throw new Error(lastErrorMessage);
  };

  let status: 'completed' | 'failed' = 'completed';
  let errorMessage: string | undefined;
  let failureCode: string | undefined;
  try {
    try {
      await promptOrThrow(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Downgrade once on quota exhaustion, then continue the same session.
      if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL && (QUOTA_ERROR_RE.test(message) || sawQuotaError)) {
        const fallback = modelRuntime.getModel(PROVIDER_ID, FALLBACK_MODEL);
        if (!fallback) throw err;
        pipe.emit('run.heartbeat', { downgraded_to: FALLBACK_MODEL, reason: 'quota' });
        await session.setModel(fallback);
        await promptOrThrow('Continue the task. The previous model hit its quota; keep going from where you left off.');
      } else {
        throw err;
      }
    }
    if (tally.requests >= MAX_REQUESTS) {
      status = 'failed';
      errorMessage = `request budget exhausted (${MAX_REQUESTS})`;
      failureCode = 'request_budget_exceeded';
    }
  } catch (err) {
    status = 'failed';
    errorMessage = err instanceof Error ? err.message : String(err);
    failureCode = /user denied/i.test(errorMessage)
      ? 'approval_denied'
      : /approval expired/i.test(errorMessage)
        ? 'approval_expired'
        : 'runner_failed';
    console.error('[runner] session failed:', errorMessage);
  } finally {
    clearInterval(heartbeat);
    clearInterval(budgetWatch);
  }

  const { uploaded, failed, skipped } = await uploadArtifacts();
  pipe.emit(status === 'completed' ? 'run.completed' : 'run.failed', {
    requests: tally.requests,
    artifacts: uploaded,
    ...(failed.length > 0 ? { artifacts_failed: failed.length } : {}),
    ...(skipped > 0 ? { artifacts_skipped: skipped } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  });
  if (failed.length > 0) {
    // The outcome message is built from result_summary, so this is the one
    // place the user is guaranteed to see it.
    tally.lastAssistantText +=
      `\n\n⚠️ ${failed.length} file(s) could not be delivered: ` +
      failed.map((f) => `${f.path} (${f.reason})`).join('; ');
  }
  await reportCompletion(status, tally, errorMessage, failureCode);
  session.dispose();
  process.exit(status === 'completed' ? 0 : 1);
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[runner] fatal:', message);
  try {
    await reportCompletion(
      'failed',
      { requests: 0, inputTokens: 0, outputTokens: 0, lastAssistantText: '' },
      message,
      'runner_fatal',
    );
  } finally {
    process.exit(1);
  }
});
