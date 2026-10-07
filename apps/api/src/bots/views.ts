/**
 * Bots — DB rows → wire shapes (`@greenhouse/types/bots`).
 *
 * One place that decides what a member's client may see: rows are parsed
 * (JSON text columns), internal columns (`name_key`, `user_id`, digest JSON)
 * never leave, and every response shape is fully typed (no `any` reaches
 * `c.json`, which would collapse the route's inferred contract).
 */

import type {
  BotConversationRow,
  BotConversationMemberRow,
  BotRequestRow,
  BotRow,
  BotSharedNoteRow,
  BotVersionRow,
  ConversationWithMembers,
  UserMemoryStatus,
} from '@greenhouse/db';
import type {
  BotConversationAttention,
  BotConversationSummary,
  BotEvent,
  BotMemberView,
  BotRequestPayload,
  BotRequestView,
  BotSharedNoteView,
  BotVersionView,
  BotView,
} from '@greenhouse/types/bots';
import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import type { MessageRow, PipelineStep, Reference } from '@greenhouse/types/session';
import { safeJsonParse } from '@greenhouse/utils/json';
import { parseHexKey } from '@greenhouse/utils/crypto';
import { parseBotEvent } from './engine/transcript.js';

export function toBotView(row: BotRow, dmSessionId: string | null, ownerNickname?: string): BotView {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    instructions: row.instructions,
    avatar: safeJsonParse(row.avatar, {}) as AvatarConfig,
    model_id: row.model_id,
    tools: row.tools == null ? null : (safeJsonParse(row.tools, []) as string[]),
    max_steps: row.max_steps,
    template_key: row.template_key,
    status: row.status,
    dm_session_id: dmSessionId,
    lifecycle_status: row.lifecycle_status,
    lifecycle_note: row.lifecycle_note,
    is_shared: row.is_shared,
    current_version: row.current_version,
    published_version: row.published_version,
    next_review_at: row.next_review_at,
    forked_from: row.forked_from,
    user_id: row.user_id,
    ...(ownerNickname !== undefined ? { owner_nickname: ownerNickname } : {}),
    last_active_at: row.last_active_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A version row on the wire (`GET /api/bots/:id/versions`). */
export function toBotVersionView(row: BotVersionRow): BotVersionView {
  return {
    version: row.version,
    manifest_hash: row.manifest_hash,
    change_log: row.change_log,
    name: row.name,
    role: row.role,
    description: row.description,
    instructions: row.instructions,
    tools: row.tools == null ? null : (safeJsonParse(row.tools, []) as string[]),
    model_id: row.model_id,
    max_steps: row.max_steps,
    avatar: safeJsonParse(row.avatar, {}) as AvatarConfig,
    purpose: row.purpose,
    audience: row.audience,
    risk_level: row.risk_level,
    budget_policy: safeJsonParse(row.budget_policy, {}) as Record<string, unknown>,
    eval_refs: safeJsonParse(row.eval_refs, []) as unknown[],
    owner_backup_user_id: row.owner_backup_user_id,
    review_due_at: row.review_due_at,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function toMemberView(row: BotConversationMemberRow): BotMemberView {
  return { bot_id: row.bot_id, role: row.role, position: row.position };
}

export function toNoteView(row: BotSharedNoteRow): BotSharedNoteView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    author_bot_id: row.author_bot_id,
    status: row.status,
    pinned: row.pinned,
    updated_at: row.updated_at,
  };
}

export function toRequestView(row: BotRequestRow): BotRequestView {
  const result = row.result ? (safeJsonParse(row.result, null) as Record<string, unknown> | null) : null;
  return {
    id: row.id,
    session_id: row.session_id,
    bot_id: row.bot_id,
    kind: row.kind,
    status: row.status,
    payload: safeJsonParse(row.payload, {}) as BotRequestPayload,
    result: result && typeof result === 'object' ? result : null,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

/** One line of preview for the conversation list (markdown and fences flattened). */
export function previewText(content: string, max = 120): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function conversationAttention(input: {
  pendingRequests: number;
  lastMessage: { role: string; created_at: string } | null;
  lastReadAt: string | null;
  working: boolean;
}): BotConversationAttention {
  if (input.pendingRequests > 0) return 'needs_you';
  const last = input.lastMessage;
  if (
    last &&
    last.role !== 'user' &&
    (!input.lastReadAt || Date.parse(last.created_at) > Date.parse(input.lastReadAt))
  ) {
    return 'unread';
  }
  if (input.working) return 'working';
  return 'idle';
}

export function toConversationSummary(
  conversation: ConversationWithMembers | (BotConversationRow & { members: BotConversationMemberRow[] }),
  extras: {
    lastMessage: { content: string; role: string; bot_id: string | null; created_at: string } | null;
    pendingRequests: number;
    working: boolean;
  },
): BotConversationSummary {
  return {
    session_id: conversation.session_id,
    kind: conversation.kind,
    title: conversation.title,
    owner_bot_id: conversation.owner_bot_id,
    lead_bot_id: conversation.lead_bot_id,
    members: conversation.members.map(toMemberView),
    last_message: extras.lastMessage
      ? {
          preview: previewText(extras.lastMessage.content),
          bot_id: extras.lastMessage.bot_id,
          role: extras.lastMessage.role,
          created_at: extras.lastMessage.created_at,
        }
      : null,
    attention: conversationAttention({
      pendingRequests: extras.pendingRequests,
      lastMessage: extras.lastMessage,
      lastReadAt: conversation.last_read_at,
      working: extras.working,
    }),
    pending_requests: extras.pendingRequests,
    last_activity_at: conversation.last_activity_at,
  };
}

/** A persisted transcript row as the Bots page renders it (JSON columns parsed). */
export interface BotMessageView {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  bot_id: string | null;
  bot_event: BotEvent | null;
  pipeline: PipelineStep[];
  references: Reference[];
  reasoning: string | null;
  model: string | null;
  images: Array<{ id: string; url: string }>;
  created_at: string;
  seq: number;
}

/**
 * The column is plain text; a Bots transcript only ever holds these three.
 * Anything else (a future/foreign writer) renders as a Bot turn rather than
 * widening the wire type back to `string`.
 */
function messageRole(role: string): BotMessageView['role'] {
  return role === 'user' || role === 'system' ? role : 'assistant';
}

/** Current status of a memory a receipt points at; 'deleted' when the row is gone. */
export type BotMemoryState = UserMemoryStatus | 'deleted';

export function toMessageView(row: MessageRow): BotMessageView {
  const pipeline = safeJsonParse(row.pipeline, []);
  const references = safeJsonParse(row.references_, []);
  const images = safeJsonParse(row.images, []);
  return {
    id: row.id,
    role: messageRole(row.role),
    content: row.content,
    bot_id: row.bot_id ?? null,
    bot_event: parseBotEvent(row.bot_event),
    pipeline: Array.isArray(pipeline) ? (pipeline as PipelineStep[]) : [],
    references: Array.isArray(references) ? (references as Reference[]) : [],
    reasoning: row.reasoning,
    model: row.model,
    images: Array.isArray(images)
      ? (images as unknown[]).filter(
          (image): image is { id: string; url: string } =>
            typeof image === 'object' &&
            image !== null &&
            typeof (image as { id?: unknown }).id === 'string' &&
            typeof (image as { url?: unknown }).url === 'string',
        )
      : [],
    created_at: row.created_at,
    seq: row.seq,
  };
}

/**
 * Whether the password vault can encrypt on this deployment — the same key the
 * vault module requires (`PROVIDER_TOKEN_ENCRYPTION_KEY`, 32 bytes hex).
 */
export function vaultAvailable(): boolean {
  const raw = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
  if (!raw) return false;
  try {
    return parseHexKey(raw, 'PROVIDER_TOKEN_ENCRYPTION_KEY').length === 32;
  } catch {
    return false;
  }
}
