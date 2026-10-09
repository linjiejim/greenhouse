/**
 * Bots API — the one client for every Bots resource (endpoint table in
 * apps/api/src/bots/AGENTS.md → HTTP contract):
 * - `/api/bots*`             Bots, conversations, shared notes, background
 *                            tasks and the "needs you" requests
 * - `/api/bots/computer/*`   the member's computer (status, take over, type…)
 * - `/api/bots/vault/*`      the password vault
 * - `/api/admin/bot-computers/*`  everyone's computers (super)
 *
 * Typed RPC over `rpc` (hc<AppType>): response types flow from the routes'
 * `c.json(...)` and are checked structurally against the declared return types
 * (the wire types in @greenhouse/types/bots), so a server shape change is a
 * compile error here — never cast over it. Routes without a validator take
 * their json/query through a variable (hc types no input for them); param
 * values are `encodeURIComponent`-ed explicitly because hc does not. The one
 * exception is the computer's file transfer — binary bodies, so the download
 * is a raw authFetch and the upload an XHR with progress (../upload-progress).
 *
 * Every failure is a `BotsApiError` carrying the HTTP status and the server's
 * machine-readable `code` (`vault_unavailable`, `user_in_control`,
 * `page_gone`, …) so callers explain it in the member's language. Test them
 * with `isBotsApiError(err, code?)`.
 *
 * Secrets: `typeIntoComputer`, the vault writes and a sign-in decision carry
 * values the member typed. They go out in the request body only — never in a
 * URL, never logged.
 */

import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import type {
  BotConversationDetail,
  BotConversationSummary,
  BotDigestView,
  BotMessage,
  BotRequestDecision,
  BotRequestStatus,
  BotRequestView,
  BotSharedNoteView,
  BotTaskView,
  BotTemplateKey,
  BotView,
  ComputerAdminRow,
  ComputerFileEntry,
  ComputerFileList,
  ComputerProcessLog,
  ComputerProcessView,
  ComputerRuntimeView,
  ComputerStatusView,
  VaultAccessView,
  VaultItemView,
  VaultItemWrite,
  BotVersionView,
} from '@greenhouse/types/bots';
import { apiWebSocketUrl } from '../api-base';
import { authFetch } from '../auth';
import { saveBlobAs } from '../file-download';
import { postWithProgress } from '../upload-progress';
import { rpc } from './client';
import { saveWorkspaceSettings } from './workspace-settings';

/** A persisted transcript row (the shared wire type). */
export type { BotMessage } from '@greenhouse/types/bots';

// ─── Errors ──────────────────────────────────────────────

/**
 * A failed Bots call: HTTP status plus the API's machine-readable `code`, when
 * it sent one, and the `reason` that refines a code (`over_quota` +
 * `host_disk`: the server's disk, not the member's own).
 */
export class BotsApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly reason: string | null;

  constructor(message: string, status: number, code: string | null = null, reason: string | null = null) {
    super(message);
    this.name = 'BotsApiError';
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

/** Narrow a caught error to a Bots API failure — optionally one with this `code`. */
export function isBotsApiError(err: unknown, code?: string): err is BotsApiError {
  return err instanceof BotsApiError && (code === undefined || err.code === code);
}

/**
 * The entry a typed code → copy map holds for a failure's `code`. Own keys
 * only, so a code the map does not know (a newer server) — or one that names
 * an Object.prototype member — falls through to the caller's fallback.
 */
export function copyForCode<C extends string, V>(
  map: Partial<Record<C, V>>,
  code: string | null | undefined,
): V | undefined {
  if (!code || !Object.prototype.hasOwnProperty.call(map, code)) return undefined;
  return map[code as C];
}

/** The non-ok branch of every call: the server's `{ error, code? }` as a BotsApiError. */
async function failure(res: { status: number; json(): Promise<unknown> }): Promise<BotsApiError> {
  const data: unknown = await res.json().catch(() => null);
  const body: { error?: unknown; code?: unknown; reason?: unknown } = data && typeof data === 'object' ? data : {};
  const message = typeof body.error === 'string' && body.error ? body.error : `Request failed (${res.status})`;
  return new BotsApiError(
    message,
    res.status,
    typeof body.code === 'string' ? body.code : null,
    typeof body.reason === 'string' ? body.reason : null,
  );
}

const enc = encodeURIComponent;

// ─── Bots ────────────────────────────────────────────────

export interface BotsOverview {
  /** Active Bots — pickers, the avatar strip and the mention list. */
  bots: BotView[];
  /**
   * Archived Bots, so an archived Bot's conversation, messages, cards and
   * audit rows still show its real name and face (read-only).
   */
  archived_bots: BotView[];
  computer: ComputerRuntimeView;
  vault_available: boolean;
  pending_requests: number;
}

export interface BotMemoryView {
  id: number;
  title: string;
  content: string;
  category: string;
  status: string;
  pinned: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface BotWriteInput {
  template_key?: BotTemplateKey;
  name?: string;
  role?: string;
  description?: string;
  instructions?: string;
  avatar?: AvatarConfig;
  model_id?: string | null;
  /** Tool ids the Bot may use; null = inherit the owner's whole allowed set. */
  tools?: string[] | null;
  max_steps?: number | null;
  change_log?: string;
}

/** A shared Bot as listed to other members (published manifest + owner). */
export interface ConversationPage {
  conversation: BotConversationDetail;
  messages: BotMessage[];
  has_more: boolean;
  /**
   * Current status of every memory a receipt on this page names (`active`,
   * `archived`, `superseded`, `deleted`…), so an undone receipt stays undone
   * after a reload. Optional: without it, undo state lasts for the tab.
   */
  memory_states?: Record<string, string>;
}

export async function listBots(): Promise<BotsOverview> {
  const res = await rpc.api.bots.$get();
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Every Bot the overview knows, active first — for "who wrote / who asked" lookups. */
export function allBotsOf(overview: Pick<BotsOverview, 'bots' | 'archived_bots'>): BotView[] {
  return [...overview.bots, ...overview.archived_bots];
}

/** First visit: creates the member's first Bot + its DM (idempotent). */
export async function bootstrapBots(): Promise<{ bot: BotView; dm_session_id: string; created: boolean }> {
  const res = await rpc.api.bots.bootstrap.$post();
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function createBot(input: BotWriteInput): Promise<{ bot: BotView; dm_session_id: string | null }> {
  const args = { json: input };
  const res = await rpc.api.bots.$post(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function updateBot(botId: string, input: Omit<BotWriteInput, 'template_key'>): Promise<{ bot: BotView }> {
  const args = { param: { id: enc(botId) }, json: input };
  const res = await rpc.api.bots[':id'].$patch(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function archiveBot(botId: string): Promise<void> {
  const res = await rpc.api.bots[':id'].$delete({ param: { id: enc(botId) } });
  if (!res.ok) throw await failure(res);
}

export async function listBotVersions(botId: string): Promise<{
  bot_id: string;
  profile_id: string;
  current_version: number;
  versions: BotVersionView[];
}> {
  const res = await rpc.api.bots[':id'].versions.$get({ param: { id: enc(botId) } });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export interface BotFolderView {
  id: number;
  name: string;
  /** The folder in the Knowledge library (`#/knowledge/folder/<id>`). */
  url: string;
}

export interface BotFileView {
  id: number;
  doc_id: string;
  title: string;
  url: string;
  updated_at: string;
}

/** The Bot's private reference folder and its documents (folder null until first use). */
export async function listBotFiles(botId: string): Promise<{ folder: BotFolderView | null; docs: BotFileView[] }> {
  const res = await rpc.api.bots[':id'].files.$get({ param: { id: enc(botId) } });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as { folder: BotFolderView | null; docs: BotFileView[] };
}

/** Create the Bot's reference folder on first use. */
export async function ensureBotFolder(botId: string): Promise<{ folder: BotFolderView }> {
  const res = await rpc.api.bots[':id'].files.ensure.$post({ param: { id: enc(botId) } });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function listBotMemories(botId: string): Promise<{ memories: BotMemoryView[] }> {
  const res = await rpc.api.bots[':id'].memories.$get({ param: { id: enc(botId) } });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function deleteBotMemory(botId: string, memoryId: number): Promise<void> {
  const res = await rpc.api.bots[':id'].memories[':memoryId'].$delete({
    param: { id: enc(botId), memoryId: String(memoryId) },
  });
  if (!res.ok) throw await failure(res);
}

/**
 * Undo a user-level memory the Bot just wrote (archived, restorable from
 * Settings → Memory — the receipt's "Undo" is not a hard delete).
 */
export async function archiveUserMemory(memoryId: number): Promise<void> {
  const args = { param: { id: String(memoryId) }, json: { status: 'archived' } };
  const res = await rpc.api.auth.me.memories[':id'].$patch(args);
  if (!res.ok) throw await failure(res);
}

// ─── Conversations ───────────────────────────────────────

export async function listConversations(): Promise<{ conversations: BotConversationSummary[] }> {
  const res = await rpc.api.bots.conversations.$get();
  if (!res.ok) throw await failure(res);
  return res.json();
}

/**
 * That Bot's DM, created if needed (with its greeting). The only conversation
 * a member opens: group chats were retired (any other count is
 * `400 groups_retired`) — Bots bring each other in as guests.
 */
export async function createConversation(botId: string): Promise<{ conversation: BotConversationDetail }> {
  const args = { json: { bot_ids: [botId] } };
  const res = await rpc.api.bots.conversations.$post(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function getConversation(
  sessionId: string,
  opts: { beforeSeq?: number; limit?: number } = {},
): Promise<ConversationPage> {
  const query: Record<string, string> = {};
  if (opts.beforeSeq !== undefined) query.before_seq = String(opts.beforeSeq);
  if (opts.limit !== undefined) query.limit = String(opts.limit);
  const args = { param: { id: enc(sessionId) }, query };
  const res = await rpc.api.bots.conversations[':id'].$get(args);
  if (!res.ok) throw await failure(res);
  const page = await res.json();
  return { ...page, messages: page.messages.map(withMessageRole) };
}

/**
 * The route types `role` as the column's plain string; a transcript row is
 * one of three. Narrowed by value (anything unexpected reads as a Bot reply),
 * never by cast.
 */
function withMessageRole<T extends { role: string }>(message: T): Omit<T, 'role'> & { role: BotMessage['role'] } {
  const role = message.role === 'user' || message.role === 'system' ? message.role : 'assistant';
  return { ...message, role };
}

/** Invite a Bot into a DM as a guest (409 `group_closed` in a retired group chat). */
export async function addConversationMember(
  sessionId: string,
  botId: string,
): Promise<{ conversation: BotConversationDetail }> {
  const args = { param: { id: enc(sessionId) }, json: { bot_id: botId } };
  const res = await rpc.api.bots.conversations[':id'].members.$post(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Send a guest away (409 `group_closed` in a retired group chat). */
export async function removeConversationMember(
  sessionId: string,
  botId: string,
): Promise<{ conversation: BotConversationDetail }> {
  const res = await rpc.api.bots.conversations[':id'].members[':botId'].$delete({
    param: { id: enc(sessionId), botId: enc(botId) },
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function markConversationRead(sessionId: string): Promise<void> {
  const res = await rpc.api.bots.conversations[':id'].read.$post({ param: { id: enc(sessionId) } });
  if (!res.ok) throw await failure(res);
}

/** Summarise now ("tidy up"); 409 while a turn runs. */
export async function compactConversation(sessionId: string): Promise<{ digest: BotDigestView | null }> {
  const res = await rpc.api.bots.conversations[':id'].compact.$post({ param: { id: enc(sessionId) } });
  if (!res.ok) throw await failure(res);
  return res.json();
}

// ─── Shared notes ────────────────────────────────────────

export async function listNotes(sessionId: string): Promise<{ notes: BotSharedNoteView[] }> {
  const res = await rpc.api.bots.conversations[':id'].notes.$get({ param: { id: enc(sessionId) } });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function createNote(
  sessionId: string,
  input: { title: string; body?: string; pinned?: boolean },
): Promise<{ note: BotSharedNoteView }> {
  const args = { param: { id: enc(sessionId) }, json: input };
  const res = await rpc.api.bots.conversations[':id'].notes.$post(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function updateNote(
  sessionId: string,
  noteId: number,
  patch: { title?: string; body?: string; status?: 'open' | 'done'; pinned?: boolean },
): Promise<{ note: BotSharedNoteView }> {
  const args = { param: { id: enc(sessionId), noteId: String(noteId) }, json: patch };
  const res = await rpc.api.bots.conversations[':id'].notes[':noteId'].$patch(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function deleteNote(sessionId: string, noteId: number): Promise<void> {
  const res = await rpc.api.bots.conversations[':id'].notes[':noteId'].$delete({
    param: { id: enc(sessionId), noteId: String(noteId) },
  });
  if (!res.ok) throw await failure(res);
}

// ─── Background tasks ────────────────────────────────────

export async function listConversationTasks(sessionId: string): Promise<{ tasks: BotTaskView[] }> {
  const res = await rpc.api.bots.conversations[':id'].tasks.$get({ param: { id: enc(sessionId) } });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function cancelBotTask(runId: string): Promise<void> {
  const res = await rpc.api.bots.tasks[':runId'].cancel.$post({ param: { runId: enc(runId) } });
  if (!res.ok) throw await failure(res);
}

// ─── "Needs you" requests ────────────────────────────────

export async function listRequests(status: BotRequestStatus = 'pending'): Promise<{ requests: BotRequestView[] }> {
  const args = { query: { status } };
  const res = await rpc.api.bots.requests.$get(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Pending requests a take-over would answer (take over, sign in), for one conversation, oldest first. */
export function computerRequestsFor(requests: readonly BotRequestView[], sessionId: string): BotRequestView[] {
  return requests.filter(
    (request) =>
      request.status === 'pending' &&
      request.session_id === sessionId &&
      (request.kind === 'takeover' || request.kind === 'login'),
  );
}

/**
 * Settle a card. A `409` is either "already settled" (code `already_decided`
 * — another tab, or it expired — or `deciding`, another decision in flight)
 * or a decision the server could not carry out while the request stays
 * pending (a secure sign-in's `page_gone` / `origin_mismatch` / `no_fields` /
 * `failed` / `invalid` / `computer_restarted`, a task `limit`, `bot_gone`), or
 * `group_closed` for a card in a retired group chat — the
 * `BotRequestErrorCode`s, read in `request-decision.ts`.
 */
export async function decideRequest(
  requestId: string,
  decision: BotRequestDecision,
): Promise<{ request: BotRequestView }> {
  const args = { param: { id: enc(requestId) }, json: decision };
  const res = await rpc.api.bots.requests[':id'].$post(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

// ─── The member's computer ───────────────────────────────

export async function fetchComputerStatus(): Promise<ComputerStatusView> {
  const res = await rpc.api.bots.computer.$get();
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Wake the computer. Resolves once it is running — or with `queue_position` set when the org's slots are full. */
export async function startComputer(): Promise<ComputerStatusView> {
  const res = await rpc.api.bots.computer.start.$post();
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function stopComputer(): Promise<ComputerStatusView> {
  const res = await rpc.api.bots.computer.stop.$post();
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Recreate the computer; `wipeData` also deletes its home volume (files + browser sign-ins). */
export async function resetComputer(wipeData: boolean): Promise<ComputerStatusView> {
  const args = { json: { wipe_data: wipeData } };
  const res = await rpc.api.bots.computer.reset.$post(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** One-time, 60-second ticket for the live viewer WebSocket. Fetch it right before connecting. */
export async function createComputerViewToken(): Promise<{ token: string; expires_at: string }> {
  const res = await rpc.api.bots.computer['view-token'].$post();
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** WebSocket URL of the live viewer (respects the desktop shell's / split-hosting API base). */
export function computerViewerUrl(token: string): string {
  return apiWebSocketUrl(`/api/ws/computer?token=${encodeURIComponent(token)}`);
}

/**
 * Take the lease: the server stops the Bots' computer actions (and starts the
 * computer if it is asleep), then forwards this member's keyboard and mouse.
 */
export async function takeoverComputer(): Promise<ComputerStatusView> {
  const res = await rpc.api.bots.computer.takeover.$post();
  if (!res.ok) throw await failure(res);
  return res.json();
}

/**
 * Give the lease back. The server settles the card it answers — `requestId`
 * when the member took over from one, else the single take-over / sign-in
 * card waiting in `sessionId` (the conversation beside the computer; never a
 * guess across conversations) — and wakes the Bot that asked, with the
 * optional note as context. Neither → the lease is just released.
 */
export async function handbackComputer(
  input: { note?: string; requestId?: string; sessionId?: string } = {},
): Promise<ComputerStatusView> {
  const trimmed = input.note?.trim();
  const args = {
    json: {
      ...(trimmed ? { note: trimmed } : {}),
      ...(input.requestId ? { request_id: input.requestId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    },
  };
  const res = await rpc.api.bots.computer.handback.$post(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

/**
 * Insert text into the focused field of the remote browser (server-side CDP
 * `Input.insertText`): works for Chinese IME output and pasted passwords, which
 * raw VNC key events cannot carry. Only while this member holds the lease.
 */
export async function typeIntoComputer(text: string): Promise<void> {
  const args = { json: { text } };
  const res = await rpc.api.bots.computer.type.$post(args);
  if (!res.ok) throw await failure(res);
}

/**
 * Bring the computer's browser back on screen: restores minimised windows, or
 * opens a new one when every window was closed. 409 `stopped` when the
 * computer is not running. Needs no take-over lease.
 */
export async function restoreComputerWindow(): Promise<void> {
  const res = await rpc.api.bots.computer['restore-window'].$post();
  if (!res.ok) throw await failure(res);
}

/**
 * The member's computer settings — today the timezone it starts with (IANA
 * name; takes effect at the next start). Returns the fresh status view.
 */
export async function updateComputerSettings(settings: { timezone: string }): Promise<ComputerStatusView> {
  const args = { json: settings };
  const res = await rpc.api.bots.computer.settings.$put(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

// ─── The computer's terminal, files and processes ────────
//
// The member's view of the Bots' sandbox (uid agent, home /home/agent): none
// of these need the take-over lease.

/**
 * One-time ticket for the terminal WebSocket — the same scheme as the viewer's,
 * with its own purpose (a view ticket never opens a terminal, and vice versa).
 * Fetch it right before connecting.
 */
export async function createComputerTerminalToken(): Promise<{ token: string; expires_at: string }> {
  const res = await rpc.api.bots.computer['terminal-token'].$post();
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** WebSocket URL of the terminal (respects the desktop shell's / split-hosting API base). */
export function computerTerminalUrl(token: string): string {
  return apiWebSocketUrl(`/api/ws/computer-terminal?token=${encodeURIComponent(token)}`);
}

/** Largest file the upload route takes, per file. */
export const COMPUTER_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/**
 * List a folder of the computer (default `~/work`; `~` = /home/agent, a
 * relative path is under ~/work). Directories first, then by name; at most
 * 500 entries (`truncated` when there are more). Starts the computer if needed.
 */
export async function listComputerFiles(path?: string): Promise<ComputerFileList> {
  const query: Record<string, string> = {};
  if (path) query.path = path;
  const args = { query };
  const res = await rpc.api.bots.computer.files.$get(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Save a file from the computer to the member's device (fetched with auth, then handed to the browser). */
export async function downloadComputerFile(path: string, filename: string): Promise<void> {
  const res = await authFetch(`/api/bots/computer/files/download?path=${enc(path)}`);
  if (!res.ok) throw await failure(res);
  saveBlobAs(await res.blob(), filename);
}

/**
 * Upload one file (≤ 100 MiB) into a folder of the computer, reporting bytes
 * sent. The server sanitises the name and never overwrites (`name (1).ext`…),
 * so the returned entry is what was actually written.
 */
export async function uploadComputerFile(
  dir: string,
  file: File,
  options: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<{ entry: ComputerFileEntry; path: string }> {
  const url = `/api/bots/computer/files/upload?dir=${enc(dir)}&name=${enc(file.name)}`;
  const headers = { 'Content-Type': 'application/octet-stream' };
  let res = await postWithProgress(url, file, { headers, onProgress: options.onProgress, signal: options.signal });
  if (res.status === 401) {
    // The access token expired meanwhile: authFetch refreshes it (or sends the
    // member to sign in) and sends the file again — without byte progress.
    res = await authFetch(url, { method: 'POST', headers, body: file, signal: options.signal });
  }
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Long jobs started with `gh-jobs` (a Bot's run_background, or the terminal). Empty while the computer is off — never starts it. */
export async function listComputerProcesses(): Promise<ComputerProcessView[]> {
  const res = await rpc.api.bots.computer.processes.$get();
  if (!res.ok) throw await failure(res);
  return (await res.json()).processes;
}

/** The tail of a job's log (redacted server-side); `truncated` when earlier output was cut. */
export async function fetchComputerProcessLog(id: string, lines?: number): Promise<ComputerProcessLog> {
  const query: Record<string, string> = {};
  if (lines !== undefined) query.lines = String(lines);
  const args = { param: { id: enc(id) }, query };
  const res = await rpc.api.bots.computer.processes[':id'].log.$get(args);
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Stop a job (SIGTERM, then SIGKILL after 3 s). `stopped: false` = it had already ended. */
export async function stopComputerProcess(id: string): Promise<{ id: string; stopped: boolean }> {
  const res = await rpc.api.bots.computer.processes[':id'].stop.$post({ param: { id: enc(id) } });
  if (!res.ok) throw await failure(res);
  return res.json();
}

// ─── Password vault ──────────────────────────────────────

export interface VaultListResult {
  items: VaultItemView[];
  /** False when the server has no encryption key — the vault cannot store anything. */
  available: boolean;
}

export async function fetchVault(): Promise<VaultListResult> {
  const res = await rpc.api.bots.vault.$get();
  if (!res.ok) {
    const err = await failure(res);
    if (err.code === 'vault_unavailable') return { items: [], available: false };
    throw err;
  }
  return res.json();
}

export async function createVaultItem(write: VaultItemWrite): Promise<VaultItemView> {
  const args = { json: write };
  const res = await rpc.api.bots.vault.$post(args);
  if (!res.ok) throw await failure(res);
  return (await res.json()).item;
}

export async function updateVaultItem(id: string, write: VaultItemWrite): Promise<VaultItemView> {
  const args = { param: { id: enc(id) }, json: write };
  const res = await rpc.api.bots.vault[':id'].$patch(args);
  if (!res.ok) throw await failure(res);
  return (await res.json()).item;
}

/**
 * Withdraw "always allow on this site" grants. `remaining` must be a subset of
 * the item's current `always_origins` — this path can only narrow access.
 */
export function setVaultAlwaysOrigins(id: string, remaining: string[]): Promise<VaultItemView> {
  return updateVaultItem(id, { always_origins: remaining });
}

export async function deleteVaultItem(id: string): Promise<void> {
  const res = await rpc.api.bots.vault[':id'].$delete({ param: { id: enc(id) } });
  if (!res.ok) throw await failure(res);
}

export async function fetchVaultLog(): Promise<VaultAccessView[]> {
  const res = await rpc.api.bots.vault.log.$get();
  if (!res.ok) throw await failure(res);
  return (await res.json()).entries;
}

// ─── Administration (super) ──────────────────────────────

export interface BotComputerCheck {
  id: string;
  ok: boolean;
  /** Server diagnostic (operator-facing, shown verbatim). */
  detail: string;
  /** Shell command that fixes the check, when there is one. */
  fix?: string;
}

export interface AdminBotComputersView {
  runtime: ComputerRuntimeView;
  computers: ComputerAdminRow[];
  settings: { idle_minutes: number; max_running: number };
  checks: BotComputerCheck[];
}

export async function fetchAdminBotComputers(): Promise<AdminBotComputersView> {
  const res = await rpc.api.admin['bot-computers'].$get();
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function adminStopComputer(userId: string): Promise<void> {
  const res = await rpc.api.admin['bot-computers'][':userId'].stop.$post({ param: { userId: enc(userId) } });
  if (!res.ok) throw await failure(res);
}

export async function adminResetComputer(userId: string, wipeData: boolean): Promise<void> {
  const args = { param: { userId: enc(userId) }, json: { wipe_data: wipeData } };
  const res = await rpc.api.admin['bot-computers'][':userId'].reset.$post(args);
  if (!res.ok) throw await failure(res);
}

/**
 * The two capacity knobs are workspace settings; saving goes through the shared
 * settings API. Only the knobs passed are written, so an untouched one keeps
 * following its env fallback.
 */
export async function saveBotComputerSettings(values: { idle_minutes?: number; max_running?: number }): Promise<void> {
  const changes: Record<string, string> = {};
  if (values.idle_minutes !== undefined) changes['bots.computer_idle_minutes'] = String(values.idle_minutes);
  if (values.max_running !== undefined) changes['bots.computer_max_running'] = String(values.max_running);
  if (Object.keys(changes).length > 0) await saveWorkspaceSettings(changes);
}
