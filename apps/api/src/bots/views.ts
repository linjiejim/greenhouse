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
  RoomParticipant,
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
  RoomParticipantView,
  SharedBotView,
} from '@greenhouse/types/bots';
import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import type { MessageRow, PipelineStep, Reference } from '@greenhouse/types/session';
import { safeJsonParse } from '@greenhouse/utils/json';
import { publicationOf } from './public.js';
import { isVaultAvailable } from './vault/crypto.js';
import { parseBotEvent } from './engine/transcript.js';

export function toBotView(row: BotRow, dmSessionId: string | null): BotView {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    instructions: row.instructions,
    avatar: safeJsonParse(row.avatar, {}) as AvatarConfig,
    model_id: row.model_id,
    tools: row.tools == null ? null : (safeJsonParse(row.tools, []) as string[]),
    connectors: row.connectors == null ? null : (safeJsonParse(row.connectors, []) as string[]),
    max_steps: row.max_steps,
    template_key: row.template_key,
    status: row.status,
    dm_session_id: dmSessionId,
    current_version: row.current_version,
    user_id: row.user_id,
    visibility: row.visibility,
    published_version: row.published_version,
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
    connectors: row.connectors == null ? null : (safeJsonParse(row.connectors, []) as string[]),
    model_id: row.model_id,
    max_steps: row.max_steps,
    avatar: safeJsonParse(row.avatar, {}) as AvatarConfig,
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

/**
 * What a room (P5) adds to a summary, as one reader sees it: the people, their own read marker,
 * and for each Agent whose it is and whether this reader may @ it (D44).
 */
export interface RoomViewExtras {
  readerId: string;
  participants: RoomParticipant[];
  /** Agent id → its owner (`bots.user_id`). */
  agentOwners: ReadonlyMap<string, string>;
  /** Agents this reader may address: their own, or public ones offered to them. */
  addressable: ReadonlySet<string>;
  /** How to show each Agent to this reader (name, role, avatar, template). */
  profiles: ReadonlyMap<string, RoomAgentProfile>;
}

export type RoomAgentProfile = NonNullable<BotMemberView['profile']>;

export function toRoomParticipantView(row: RoomParticipant): RoomParticipantView {
  return { user_id: row.user_id, nickname: row.nickname, role: row.role, joined_at: row.joined_at };
}

export function toConversationSummary(
  conversation: ConversationWithMembers | (BotConversationRow & { members: BotConversationMemberRow[] }),
  extras: {
    lastMessage: {
      content: string;
      role: string;
      bot_id: string | null;
      author_user_id?: string | null;
      created_at: string;
    } | null;
    pendingRequests: number;
    /** Bot replies since `last_read_at` (`db.bots.unreadCounts`, capped). */
    unreadCount: number;
    working: boolean;
    /** A room: its people and this reader's view of its Agents. */
    room?: RoomViewExtras;
  },
): BotConversationSummary {
  const room = conversation.kind === 'room' ? extras.room : undefined;
  const last = extras.lastMessage;
  // In a room someone else's message is news to this reader like a reply is.
  const lastForAttention =
    room && last && last.role === 'user' && last.author_user_id && last.author_user_id !== room.readerId
      ? { ...last, role: 'participant' }
      : last;
  return {
    session_id: conversation.session_id,
    kind: conversation.kind,
    title: conversation.title,
    ...(conversation.kind === 'task' ? { model_id: conversation.model_id } : {}),
    owner_bot_id: conversation.owner_bot_id,
    lead_bot_id: conversation.lead_bot_id,
    members: conversation.members.map((member) =>
      room
        ? {
            ...toMemberView(member),
            owner_user_id: room.agentOwners.get(member.bot_id) ?? member.user_id,
            brought_by_user_id: member.user_id,
            addressable: room.addressable.has(member.bot_id),
            ...(room.profiles.has(member.bot_id) ? { profile: room.profiles.get(member.bot_id)! } : {}),
          }
        : toMemberView(member),
    ),
    ...(room ? { participants: room.participants.map(toRoomParticipantView) } : {}),
    last_message: last
      ? {
          preview: previewText(last.content),
          bot_id: last.bot_id,
          role: last.role,
          created_at: last.created_at,
          ...(room ? { author_user_id: last.author_user_id ?? null } : {}),
        }
      : null,
    attention: conversationAttention({
      pendingRequests: extras.pendingRequests,
      lastMessage: lastForAttention,
      lastReadAt: room
        ? (room.participants.find((p) => p.user_id === room.readerId)?.last_read_at ?? null)
        : conversation.last_read_at,
      working: extras.working,
    }),
    pending_requests: extras.pendingRequests,
    unread_count: extras.unreadCount,
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
  /** In a room: the person who wrote this member message (P5); null everywhere else. */
  author_user_id: string | null;
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
    author_user_id: row.author_user_id ?? null,
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

/** Whether the password vault can encrypt on this deployment — exactly the vault module's own check. */
export function vaultAvailable(): boolean {
  return isVaultAvailable();
}

/** Someone else's public Agent as a member sees it (no instructions, tools or settings). */
export function toSharedBotView(
  row: BotRow,
  owner: { id: string; nickname: string },
  dmSessionId: string | null,
  available: boolean,
): SharedBotView {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    avatar: safeJsonParse(row.avatar, {}) as AvatarConfig,
    template_key: row.template_key,
    owner,
    dm_session_id: dmSessionId,
    available,
    computer: publicationOf(row).grants.computer,
  };
}
