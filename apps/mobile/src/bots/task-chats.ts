/**
 * Task chats on the phone — separate chats with their own context, answered by one Agent on the
 * Agents engine (`bot_conversations.kind = 'task'`; spec docs/specs/20261011-agent-first-class.md
 * §5a, D20–D27). The thread machinery is the DM's (./thread/engine.ts); what differs lives here,
 * React-free so the root vitest pins it (./task-chats.test.ts):
 *
 *  - who can reply and what the thread is called — the vendored web helpers only know DMs and
 *    retired groups, so the task branch comes first and everything else goes to them;
 *  - the new chat's Agent (`?profile=`) and how a failed create reads (an older server without
 *    task chats answers 400 with no code — the new chat falls back to the chat engine there);
 *  - the first message, handed from the new-chat screen to the thread it opens (`putFirstSend` /
 *    `takeFirstSend` — memory only, taken once);
 *  - edit / answer again (D23 — task chats only): the member message they go back to and the
 *    reply the menu offers "Regenerate" on, and an edit's text with the message's file fence kept.
 */

import type { ComposerImage } from '../chat/composer';
import type { TranslationKey } from '../lib/i18n';
import type { BotConversationSummary, BotEvent, BotMessage, BotView } from '../shared/bots';
import type { SendInput } from './contract';
import { conversationReplyable, conversationTitle, type ConversationTitleCopy } from './vendor/web-helpers';

export type ConversationKind = BotConversationSummary['kind'];

export function isTaskChat(conversation: Pick<BotConversationSummary, 'kind'> | null | undefined): boolean {
  return conversation?.kind === 'task';
}

/**
 * Whether anyone can still reply: a task chat while its Agent is active (like a DM — the server
 * answers 409 `bot_archived` otherwise); DMs and retired groups by the web's rule.
 */
export function conversationCanReply(
  conversation: Pick<BotConversationSummary, 'kind' | 'owner_bot_id'>,
  activeIds: ReadonlySet<string>,
): boolean {
  if (conversation.kind === 'task') return !!conversation.owner_bot_id && activeIds.has(conversation.owner_bot_id);
  return conversationReplyable(conversation, activeIds);
}

/** How the vendored transcript reads a conversation: a task chat's Agent speaks under the title, like a DM's. */
export function transcriptKind(kind: ConversationKind): 'direct' | 'group' {
  return kind === 'group' ? 'group' : 'direct';
}

export interface ThreadTitleCopy extends ConversationTitleCopy {
  /** A task chat with no title yet (the server names it after its first reply) — the web's `chat`. */
  chat: string;
}

/** A thread's name: a task chat's own title (else "New chat"); a DM's Agent; an old group's title or roster. */
export function threadTitle(
  conversation: Pick<BotConversationSummary, 'kind' | 'title' | 'owner_bot_id' | 'members'>,
  bots: ReadonlyMap<string, BotView>,
  copy: ThreadTitleCopy,
): string {
  if (conversation.kind === 'task') return conversation.title?.trim() || copy.chat;
  return conversationTitle(conversation, bots, copy);
}

// ─── Starting one ────────────────────────────────────────

/**
 * The Agent a new chat goes to, from its `?profile=`: `bot:<id>` (possibly pinned, `@<v>`) → the
 * id; `sprouty`, none or anything else → null — the server's default, the member's Sprouty.
 */
export function chatBotId(profile: string | null | undefined): string | null {
  if (!profile?.startsWith('bot:')) return null;
  return profile.slice('bot:'.length).split('@')[0] || null;
}

/**
 * Why `POST /api/bots/conversations {kind:'task'}` failed: `unsupported` — an older server read it
 * as a DM request without `bot_ids` (400, no code; a current one answers every malformed field of
 * this request with a code or not at all); `agent_gone` — the chosen Agent is archived or deleted
 * (start the chat with Sprouty instead, as the chat engine does); else `failed`.
 */
export function taskChatFailure(result: {
  status: number;
  code: string | null;
}): 'unsupported' | 'agent_gone' | 'failed' {
  if (result.status === 400 && result.code === null) return 'unsupported';
  if (result.status === 404 || result.code === 'bot_not_found' || result.code === 'bot_archived') return 'agent_gone';
  return 'failed';
}

/** Stations (by id) that turned out to have no task chats this app run: new chats go to the chat engine there. */
const unsupported = new Set<string>();

export function taskChatsSupported(stationId: string | null | undefined): boolean {
  return !unsupported.has(stationId ?? '');
}

export function noteTaskChatsUnsupported(stationId: string | null | undefined): void {
  unsupported.add(stationId ?? '');
}

/** A new chat's first message on its way to the thread: what to send, and what to give back if it is refused. */
export interface FirstSend {
  input: SendInput;
  /** The composer's uploaded images (the thread's composer takes them back on a refusal). */
  images: ComposerImage[];
}

/** The new-chat screen's first message, waiting for the thread it just created (taken once, memory only). */
const firstSends = new Map<string, FirstSend>();

export function putFirstSend(sessionId: string, first: FirstSend): void {
  firstSends.set(sessionId, first);
}

export function takeFirstSend(sessionId: string): FirstSend | null {
  const first = firstSends.get(sessionId) ?? null;
  firstSends.delete(sessionId);
  return first;
}

/** Forget every handed-over message (sign-out, another station). */
export function clearFirstSends(): void {
  firstSends.clear();
}

// ─── Edit / answer again ─────────────────────────────────

export interface RewindTarget {
  /** The chat's last member message: what an edit changes and an answer-again answers. */
  memberId: string;
  /** Its bubble can be edited (a plain member message — not a row with an event). */
  editable: boolean;
  /** The last reply after it, which carries "Regenerate" (null: it has none — the turn left only a card or a line). */
  replyId: string | null;
}

/**
 * What edit / answer again would go back to — task chats only (D23: a DM is a long record other
 * Agents, summaries and notes refer to), and only while nothing is in flight here (a run, a send,
 * a load): the server refuses a rewind mid-run (409 `busy`), and the rows must be the server's.
 * The member message is the last `user` row, as the server reads it (`not_last` otherwise).
 */
export function rewindTarget(o: {
  kind: ConversationKind | null;
  messages: readonly BotMessage[];
  /** Nobody can reply here (an archived Agent). */
  readOnly: boolean;
  /** A run, a send in flight or a load: the transcript is about to change. */
  busy: boolean;
}): RewindTarget | null {
  if (o.kind !== 'task' || o.readOnly || o.busy) return null;
  let at = -1;
  for (let i = o.messages.length - 1; i >= 0; i -= 1) {
    if (o.messages[i].role === 'user') {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const member = o.messages[at];
  let replyId: string | null = null;
  for (let i = o.messages.length - 1; i > at; i -= 1) {
    const message = o.messages[i];
    if (message.role === 'assistant' && !message.bot_event) {
      replyId = message.id;
      break;
    }
  }
  return { memberId: member.id, editable: !member.bot_event, replyId };
}

/** What a refused rewind says, by the server's 409 code; null = the plain "couldn't" line. */
export function rewindRefusalKey(code: string | null): TranslationKey | null {
  if (code === 'busy') return 'bots.thread.rewindBusy';
  if (code === 'not_last') return 'bots.thread.rewindNotLast';
  if (code === 'requests_pending') return 'bots.thread.rewindCards';
  return null;
}

/** The file fences the server writes into a member message (```attachments, legacy ```mission-attachments). */
const FILE_FENCE = /```(?:mission-)?attachments\s*\n[\s\S]*?```/g;

/**
 * An edit's new content: the member's new text, with the message's file fences kept (the bubble
 * shows them as chips; the composer only ever held the text — dropping them would drop the files).
 */
export function editedContent(original: string, text: string): string {
  const fences = original.match(FILE_FENCE) ?? [];
  return [text.trim(), ...fences].filter(Boolean).join('\n\n');
}

/**
 * The other chat a transcript line links to: `chat_opened` (an Agent started a task in a new chat —
 * written where it was proposed) → that chat; `chat_origin` (the new chat's first line) → the
 * conversation it came from. Null for every other line.
 */
export function linkedChat(event: BotEvent | null | undefined): { c: string; title: string } | null {
  if (event?.kind === 'chat_opened') return event.session_id ? { c: event.session_id, title: event.title ?? '' } : null;
  if (event?.kind === 'chat_origin') return event.from_session_id ? { c: event.from_session_id, title: '' } : null;
  return null;
}

/** A chats-list row that is an Agent task chat (`include=agent_chats`: `channel: 'bots'` + `agent_chat`) — it opens as a thread. */
export function isAgentChatRow(session: { channel?: string; agent_chat?: unknown }): boolean {
  return session.channel === 'bots' || !!session.agent_chat;
}
