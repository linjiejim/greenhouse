/**
 * Mission API — long-running agent tasks executed by the Sandbox Runner.
 *
 * Consumes canonical /api/missions/*; /api/cloud-agent remains a compatibility alias. Event
 * payloads arrive as JSON strings (runner protocol, truncated server-side at
 * 16 KB) — parse them defensively at the render layer with lib/utils safeParse.
 */

import { isAgentRunActive, type AgentRunEvent, type AgentRunStatus } from '@greenhouse/types/cloud-agent';
import { authFetch } from '../auth';
import { rpc } from './client';

/** Local aliases over the shared wire contract (@greenhouse/types/cloud-agent). */
export type CloudAgentRunStatus = AgentRunStatus;
export type CloudAgentEvent = AgentRunEvent;

export interface CloudAgentRun {
  id: string;
  status: CloudAgentRunStatus;
  title: string;
  dispatch_id: string | null;
  original_prompt: string;
  prompt: string;
  input_manifest: string;
  model: string;
  fallback_model: string | null;
  /** Persistent per-user workspace the run executes in (mission follow-ups reuse it). */
  workspace_id: number;
  /** Chat session the run converses through (mission runs), or null for standalone runs. */
  session_id: string | null;
  max_wall_ms: number;
  max_requests: number;
  used_requests: number;
  input_tokens: number;
  output_tokens: number;
  result_summary: string | null;
  failure_code: string | null;
  error: string | null;
  journal_storage_key: string | null;
  queue_position: number | null;
  queue_reason: 'user_active' | 'global_capacity' | 'ready' | null;
  pending_approval_count: number;
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CloudAgentApproval {
  id: string;
  run_id: string;
  tool_id: string;
  action: string | null;
  input_json: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

export interface CloudAgentArtifact {
  id: number;
  path: string;
  size_bytes: number;
  content_type: string;
  sha256: string;
  created_at: string;
}

/** Non-terminal statuses — the dock stays live while one of these holds. */
export const isCloudAgentRunActive = isAgentRunActive;

/** The API answered 503 — Mission admission is closed in this environment. */
export class CloudAgentDisabledError extends Error {
  constructor() {
    super('Missions are not available in this environment');
    this.name = 'CloudAgentDisabledError';
  }
}

export type MissionRuntimeAvailability = 'checking' | 'ready' | 'disabled' | 'unavailable';

/** Public-safe admission posture used to gate the Chat `/Skill` picker. */
export async function getMissionRuntimeAvailability(): Promise<Exclude<MissionRuntimeAvailability, 'checking'>> {
  const res = await authFetch('/health');
  if (!res.ok) return 'unavailable';
  const data = (await res.json().catch(() => null)) as { mission?: { state?: unknown } } | null;
  const state = data?.mission?.state;
  return state === 'ready' || state === 'disabled' || state === 'unavailable' ? state : 'unavailable';
}

export async function listCloudAgentRuns(
  limit: number,
  offset: number,
): Promise<{ runs: CloudAgentRun[]; total: number }> {
  const args = { query: { limit: String(limit), offset: String(offset) } };
  const res = await rpc.api.missions.runs.$get(args);
  if (!res.ok) throw new Error(`Failed to load tasks: ${res.status}`);
  return res.json();
}

/** A mission session's run lineage, oldest first (server orders by created_at). */
export async function listCloudAgentRunsBySession(sessionId: string): Promise<CloudAgentRun[]> {
  const args = { query: { session_id: sessionId } };
  const res = await rpc.api.missions.runs.$get(args);
  if (!res.ok) throw new Error(`Failed to load mission runs: ${res.status}`);
  return (await res.json()).runs;
}

export async function getCloudAgentRun(
  id: string,
): Promise<{ run: CloudAgentRun; artifacts: CloudAgentArtifact[]; approvals: CloudAgentApproval[] }> {
  const res = await rpc.api.missions.runs[':id'].$get({ param: { id } });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || `Failed to load task: ${res.status}`);
  }
  return res.json();
}

export async function listCloudAgentRunEvents(
  id: string,
  after: number,
): Promise<{ events: CloudAgentEvent[]; run_status: CloudAgentRunStatus }> {
  const args = { param: { id }, query: { after: String(after) } };
  const res = await rpc.api.missions.runs[':id'].events.$get(args);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || `Failed to load events: ${res.status}`);
  }
  return res.json();
}

/**
 * Dedupe-and-order incoming polled events into the known list (seq is the
 * replay cursor; duplicates arrive when a poll races the initial replay).
 * Returns `prev` unchanged when nothing new came in, so setState bails out.
 */
export function mergeCloudAgentEvents(prev: CloudAgentEvent[], incoming: CloudAgentEvent[]): CloudAgentEvent[] {
  if (incoming.length === 0) return prev;
  const known = new Set(prev.map((e) => e.seq));
  const added = incoming.filter((e) => !known.has(e.seq));
  if (added.length === 0) return prev;
  return [...prev, ...added].sort((a, b) => a.seq - b.seq);
}

// ─── Attachments (mission inputs) ────────────────────────
// Mirrors the server limits in apps/api/src/routes/cloud-agent.ts.

export const MAX_CLOUD_AGENT_ATTACHMENTS = 10;
export const MAX_CLOUD_AGENT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Reference to an uploaded attachment blob, passed back on run creation. */
export interface CloudAgentAttachmentRef {
  key: string;
  name: string;
}

/**
 * Upload one attachment (any file type, ≤100 MB). Raw authFetch on purpose:
 * the body is FormData and the hc client is reserved for JSON (see ./client.ts
 * conventions and lib/api/upload.ts for the same pattern).
 */
export async function uploadCloudAgentAttachment(file: File): Promise<{ key: string; name: string; size: number }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await authFetch('/api/missions/attachments', { method: 'POST', body: formData });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `Upload failed: ${res.status}`);
  }
  return res.json();
}

export interface CreateCloudAgentRunInput {
  title?: string;
  /** May be empty when `skill` is set — the skill's own SKILL.md is the task then. */
  prompt: string;
  /** Mission-ready Skill Center skill name (composer `/` picker) — server re-validates at launch. */
  skill?: string;
  /** Composer direct-launch: write the prompt as the user's turn in the bound session. */
  write_user_turn?: boolean;
  model?: string;
  /** Bind the run to a mission chat session (server writes the user turn). */
  session_id?: string;
  /** Direct launch from a new Chat: create and bind an ordinary session during admission. */
  create_session_profile_id?: string;
  /** Reuse an existing workspace so the agent keeps prior context/artifacts. */
  workspace_id?: number;
  /** Mission-preset staged blobs (≤10) — materialized into the sandbox ./inputs/. */
  attachments?: CloudAgentAttachmentRef[];
  /** Conversation attachments (chat_files ids) — same destination, zero copy. */
  chat_file_ids?: string[];
  /** Stable identity emitted by one Mission Dispatch card. */
  dispatch_id?: string;
  budget?: 'light' | 'standard' | 'deep';
}

export async function decideCloudAgentApproval(
  runId: string,
  approvalId: string,
  decision: 'approve' | 'deny',
): Promise<CloudAgentApproval> {
  const res = await authFetch(
    `/api/missions/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  );
  const data = (await res.json().catch(() => null)) as { approval?: CloudAgentApproval; error?: string } | null;
  if (!res.ok || !data?.approval) throw new Error(data?.error || `Failed to decide approval: ${res.status}`);
  return data.approval;
}

export async function createCloudAgentRun(input: CreateCloudAgentRunInput): Promise<CloudAgentRun> {
  const args = { json: input };
  const res = await rpc.api.missions.runs.$post(args);
  if (res.status === 503) throw new CloudAgentDisabledError();
  const data = await res.json();
  if (res.ok && 'run' in data) return data.run;
  throw new Error(('error' in data && typeof data.error === 'string' && data.error) || 'Failed to start task');
}

export async function cancelCloudAgentRun(id: string): Promise<CloudAgentRun> {
  const res = await rpc.api.missions.runs[':id'].cancel.$post({ param: { id } });
  if (res.status === 503) throw new CloudAgentDisabledError();
  const data = await res.json();
  if (res.ok && 'run' in data && data.run) return data.run;
  throw new Error(('error' in data && typeof data.error === 'string' && data.error) || 'Failed to cancel task');
}

/** Authenticated download endpoint — fetch via downloadAuthenticatedFile, not <a href>. */
export function cloudAgentArtifactDownloadUrl(runId: string, artifactId: number): string {
  return `/api/missions/runs/${encodeURIComponent(runId)}/artifacts/${artifactId}/download`;
}

/**
 * Ceiling on an HTML artifact the side pane will fetch-and-render.
 *
 * The pane pulls the bytes into a string and hands them to a sandboxed iframe
 * via `srcdoc`, so the file has to be a *page*, not a dataset. 12 MB comfortably
 * covers an html-slides deck with a dozen full-bleed images inlined as
 * data URIs (the skill mandates a single self-contained file) while still
 * refusing to marshal a 50 MB data dump through a JS string. It was 2 MB, which
 * blocked exactly the branded, image-heavy decks the preview is meant for.
 */
export const MAX_HTML_PREVIEW_BYTES = 12 * 1024 * 1024;

/** Whether a mission artifact is a small-enough .html to open in the pane. */
export function isPreviewableHtmlArtifact(path: string, sizeBytes?: number): boolean {
  if (sizeBytes !== undefined && sizeBytes > MAX_HTML_PREVIEW_BYTES) return false;
  return /\.html?$/i.test(path);
}

export function cloudAgentJournalDownloadUrl(runId: string): string {
  return `/api/missions/runs/${encodeURIComponent(runId)}/journal`;
}

/**
 * Authenticated download for a mission INPUT. The storage key is the handle
 * (attachments have no table); the server re-checks its user prefix, so a key
 * from another account 404s.
 */
export function cloudAgentAttachmentDownloadUrl(storageKey: string): string {
  return `/api/missions/attachments/download?key=${encodeURIComponent(storageKey)}`;
}
