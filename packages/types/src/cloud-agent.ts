/**
 * Cloud Agent run contract — shared by the sandbox runner, the api and the web.
 *
 * The event protocol used to have no single source: the runner emitted string
 * literals, the api validated them with a regex, and the web re-typed them in a
 * comment. `run.canceled` existed in the web's list and in its timeline switch
 * while nothing had ever emitted it — a ghost that only a shared definition
 * makes impossible.
 *
 * Design spec: docs/specs/20260731-cloud-agent-runtime.md (protocol),
 * docs/specs/20260731-session-modes-tool-unification.md (this consolidation).
 */

// ─── Run status ──────────────────────────────────────────

export type AgentRunStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'canceled';

/** Statuses the controller still owns (a container exists or is about to). */
export const AGENT_RUN_ACTIVE_STATUSES = ['queued', 'starting', 'running'] as const satisfies readonly AgentRunStatus[];

export function isAgentRunActive(status: AgentRunStatus): boolean {
  return (AGENT_RUN_ACTIVE_STATUSES as readonly string[]).includes(status);
}

// ─── Event protocol ──────────────────────────────────────

/**
 * Step-level events replayed into the run timeline.
 *
 * Emitted by the RUNNER, in the sandbox:
 *   run.started · message.assistant · tool.started · tool.completed
 *   tool.approval_requested
 *   run.heartbeat · artifact.created · artifact.failed · artifact.skipped
 *   run.completed · run.failed
 *
 * Emitted by the CONTROL PLANE, when a run ends without the runner reporting
 * (user cancel, wall-budget reaper, container lost across a restart), and when
 * the terminal sweep recovers deliverables the runner never uploaded:
 *   run.canceled · run.failed · artifact.created
 *
 * `artifact.skipped` exists because every silent drop in the collector was a
 * file the agent truthfully reported writing and the user never received: a
 * stale mtime, the 50-file ceiling, an unreadable subdirectory. Dropping one
 * without a row makes the artifact list a false capability claim.
 */
export type AgentRunEventType =
  | 'run.started'
  | 'run.heartbeat'
  | 'message.assistant'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.approval_requested'
  | 'artifact.created'
  | 'artifact.failed'
  | 'artifact.skipped'
  | 'run.completed'
  | 'run.failed'
  | 'run.canceled';

export const AGENT_RUN_EVENT_TYPES = [
  'run.started',
  'run.heartbeat',
  'message.assistant',
  'tool.started',
  'tool.completed',
  'tool.approval_requested',
  'artifact.created',
  'artifact.failed',
  'artifact.skipped',
  'run.completed',
  'run.failed',
  'run.canceled',
] as const satisfies readonly AgentRunEventType[];

/**
 * Why a deliverable in `artifacts/` was not uploaded by the runner. Reported
 * rather than swallowed; the terminal sweep recovers most of these from the
 * host workspace afterwards, so a skipped row is usually followed by a
 * `recovered` artifact.created.
 */
export type AgentArtifactSkipReason = 'stale_mtime' | 'over_limit' | 'too_large' | 'unreadable' | 'walk_error';

/**
 * Seq offset for events the CONTROL PLANE writes.
 *
 * The runner owns a plain incrementing counter and the api holds no copy of it,
 * so a server-written event has to land in a segment that cannot collide.
 * It must be ABOVE the runner's range, not below: clients replay with
 * `?after=<lastSeq>`, so an event with a smaller seq than one already delivered
 * would never be fetched. Sorting last is also chronologically right — these
 * only ever mark the end of a run.
 */
export const AGENT_RUN_SERVER_SEQ_BASE = 1_000_000_000;

/**
 * One row of `agent_run_events` as served to clients. `payload` is a JSON
 * STRING (the runner authors it and the api retains it exactly) — parse it
 * defensively at the render layer and never trust its shape.
 */
export interface AgentRunEvent {
  id: number;
  seq: number;
  /** A known type, or an unrecognized one from a newer runner (rendered neutrally). */
  type: AgentRunEventType | (string & {});
  payload: string;
  created_at: string;
}
