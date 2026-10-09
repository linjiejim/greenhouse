/**
 * Pure helpers lifted from the web Bots components (apps/mobile cannot import the web app; see
 * apps/mobile/AGENTS.md). Each declaration is a verbatim copy of the canonical one named in the
 * section header above it — only `export` added where the canonical one is module-private — and
 * src/bots/vendor/vendor.parity.test.ts compares them declaration by declaration. Do not edit
 * here: change the canonical declaration, re-copy it, and run that test.
 */

import type { BotConversationSummary, BotMessage, BotRequestDecision, BotTaskView, BotView } from '../../shared/bots';
import type { PlantState } from '../../ui/plant-avatar/plant-ids';
import type { PendingSend } from './transcript';

// ─── apps/web/src/components/bots/use-bot-conversation.ts ─

export const PAGE_SIZE = 60;

export interface PendingWithBase extends PendingSend {
  /** Highest persisted seq when it was sent — the persisted copy will be newer. */
  baseSeq: number;
}

/** -1 for an empty transcript: sequence numbers start at 0. */
export function maxSeq(messages: readonly BotMessage[]): number {
  return messages.reduce((max, message) => Math.max(max, message.seq), -1);
}

/** Merge a fresh latest page into what is loaded, keeping older pages the member scrolled to. */
export function mergeLatest(loaded: readonly BotMessage[], latest: readonly BotMessage[]): BotMessage[] {
  if (latest.length === 0) return loaded.length ? [...loaded] : [];
  const floor = Math.min(...latest.map((message) => message.seq));
  return [...loaded.filter((message) => message.seq < floor), ...latest].sort((a, b) => a.seq - b.seq);
}

/** Drop sends whose persisted copy has arrived (matched one-to-one, oldest first). */
export function settlePending(pending: readonly PendingWithBase[], messages: readonly BotMessage[]): PendingWithBase[] {
  const used = new Set<string>();
  // Matching includes `sending`: the API persists the message before it answers,
  // so a reload racing the POST may already contain it.
  return pending.filter((send) => {
    const match = messages.find(
      (message) =>
        message.role === 'user' &&
        !message.bot_event &&
        message.seq > send.baseSeq &&
        !used.has(message.id) &&
        message.content.trim() === send.content.trim(),
    );
    if (!match) return true;
    used.add(match.id);
    return false;
  });
}

// ─── apps/web/src/components/bots/bots-store.ts ──────────

/** Lookup by id, for rendering speakers. */
export function botsById(bots: readonly BotView[]): Map<string, BotView> {
  return new Map(bots.map((bot) => [bot.id, bot]));
}

/** Every Bot a conversation row names: its DM owner and its members. */
export function conversationBotIds(conversation: Pick<BotConversationSummary, 'owner_bot_id' | 'members'>): string[] {
  const ids = conversation.members.map((member) => member.bot_id);
  if (conversation.owner_bot_id) ids.push(conversation.owner_bot_id);
  return ids;
}

/** Newer copies win; order is stable (by first sighting). */
export function mergeArchived(current: BotView[], incoming: readonly BotView[]): BotView[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((bot) => [bot.id, bot]));
  for (const bot of incoming) byId.set(bot.id, bot);
  return [...byId.values()];
}

/**
 * Whether anyone in a conversation can still reply: only a DM whose Bot is
 * still active. A DM whose Bot was archived is read-only, and so is every
 * group — group chats were retired (a Bot brings another into its own DM when
 * it needs one), and the old ones stay as records. The API refuses a message
 * to either (409), so the composer gives way to an explanation instead. Only
 * meaningful once the Bot list is loaded.
 */
export function conversationReplyable(
  conversation: Pick<BotConversationSummary, 'kind' | 'owner_bot_id'>,
  activeIds: ReadonlySet<string>,
): boolean {
  return conversation.kind === 'direct' && !!conversation.owner_bot_id && activeIds.has(conversation.owner_bot_id);
}

// ─── apps/web/src/components/bots/navigation.ts ──────────

/** Copy `conversationTitle` needs, already localized by the caller. */
export interface ConversationTitleCopy {
  /**
   * A DM whose Bot is not in the directory. Pass an empty string while the
   * Bot list is still loading — an id we have not heard about yet is not a
   * deleted Bot.
   */
  unknownBot: string;
  /** A group with no title and no known member. */
  group: string;
  /** "Sage (archived)": the Bot no longer replies; its conversation stays readable. */
  archived: (name: string) => string;
}

/**
 * A conversation's display name: the Bot's name for a DM (marked when that
 * Bot is archived), the title or the roster for a group. `bots` is the full
 * directory — active and archived Bots.
 */
export function conversationTitle(
  conversation: Pick<BotConversationSummary, 'kind' | 'title' | 'owner_bot_id' | 'members'>,
  bots: ReadonlyMap<string, BotView>,
  copy: ConversationTitleCopy,
): string {
  if (conversation.kind === 'direct') {
    const owner = bots.get(conversation.owner_bot_id ?? '');
    if (!owner) return copy.unknownBot;
    return owner.status === 'active' ? owner.name : copy.archived(owner.name);
  }
  if (conversation.title?.trim()) return conversation.title.trim();
  const names = conversation.members.flatMap((member) => {
    const name = bots.get(member.bot_id)?.name;
    return name ? [name] : [];
  });
  return names.length > 0 ? names.join(', ') : copy.group;
}

// ─── apps/web/src/components/bots/request-decision.ts ────

/**
 * A take-over card the computer raised by itself (the member took over while
 * a Bot was mid-action — `interrupted` — or a Bot needed the computer while
 * the member held it — `waiting`), read defensively from the payload: the
 * card renders "you took over" / "is waiting" instead of a Bot's own reason,
 * and handing back lets that Bot continue.
 */
export function implicitTakeover(
  payload: unknown,
): { reason: 'interrupted' | 'waiting'; host: string | null; title: string | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  const fields = payload as Record<string, unknown>;
  if (fields.implicit !== true) return null;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    reason: fields.reason === 'waiting' ? 'waiting' : 'interrupted',
    host: text(fields.host),
    title: text(fields.title),
  };
}

/**
 * A take-over card a Bot raised because a site asked for human verification
 * (payload `kind: 'captcha'` — never one the computer raised itself), read
 * defensively: the card then embeds the screen and offers "Verify here".
 */
export function humanCheckTakeover(payload: unknown): { reason: string; url: string | null } | null {
  if (!payload || typeof payload !== 'object' || implicitTakeover(payload)) return null;
  const fields = payload as Record<string, unknown>;
  if (fields.kind !== 'captcha') return null;
  return {
    reason: typeof fields.reason === 'string' ? fields.reason.trim() : '',
    url: typeof fields.url === 'string' && fields.url.trim() ? fields.url.trim() : null,
  };
}

// ─── apps/web/src/components/bots/login-request-card.tsx ─

/**
 * What the card sends: only the fields the member filled. A second card on a
 * two-step sign-in asks for the password alone, and a user-name-only submit is
 * followed to the next screen by the server — so either field is enough.
 */
export function loginValues(
  fields: { username: string; password: string; otp: string },
  opts: { otpOnly: boolean; saveToVault: boolean },
): NonNullable<BotRequestDecision['login']> | null {
  const username = opts.otpOnly ? '' : fields.username.trim();
  const password = opts.otpOnly ? '' : fields.password;
  const otp = fields.otp.trim();
  if (!username && !password && !otp) return null;
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(otp ? { otp } : {}),
    // Only a user name or a password is worth saving (the server agrees).
    ...(opts.saveToVault && (username || password) ? { save_to_vault: true } : {}),
    submit: true,
  };
}

// ─── apps/web/src/components/bots/instructions-update-card.tsx

export type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string };

/**
 * A readable line diff without a diff library: lines present in only one
 * side are marked, common lines kept in order (set membership — good enough
 * for instructions, which are short and line-structured).
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const old = before.split('\n');
  const next = after.split('\n');
  const oldSet = new Set(old);
  const nextSet = new Set(next);
  const out: DiffLine[] = [];
  for (const line of old) if (!nextSet.has(line)) out.push({ kind: 'removed', text: line });
  for (const line of next) out.push({ kind: oldSet.has(line) ? 'same' : 'added', text: line });
  return out;
}

// ─── apps/web/src/components/bots/conversation-header.tsx ─

export function hostFromInput(input: string): string | null {
  // Tool input streams in as partial JSON; only a complete `url` is worth showing.
  const match = /"url"\s*:\s*"([^"]+)"/.exec(input);
  if (!match) return null;
  try {
    return new URL(match[1]).host || null;
  } catch {
    return null;
  }
}

// ─── apps/web/src/components/bots/bot-task-dock.tsx ──────

export const ACTIVE: ReadonlySet<BotTaskView['status']> = new Set(['queued', 'running', 'waiting']);

/**
 * The owning Bot's pose for a task row. Always static: the dock is a list, and in
 * the Bots surface motion means "this Bot is talking" — a pose, not a loop, is
 * what tells a failed task's Bot from a finished one at a glance.
 */
export const TASK_POSE: Record<BotTaskView['status'], PlantState> = {
  queued: 'idle',
  running: 'idle',
  waiting: 'waiting',
  succeeded: 'done',
  failed: 'error',
  canceled: 'sleep',
  interrupted: 'error',
};

export function elapsed(task: BotTaskView, now: number): string {
  const start = task.started_at ?? task.created_at;
  const end = task.ended_at ? Date.parse(task.ended_at) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(start)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ─── apps/web/src/components/bots/memory-receipts.tsx ────

export interface MemoryReceipt {
  memoryId: number;
  title: string;
  scope: 'user' | 'bot';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** `memory.remember` results in a turn's tool calls. */
export function memoryReceiptsFromCalls(calls: ReadonlyArray<{ name: string; output?: unknown }>): MemoryReceipt[] {
  return calls.flatMap((call) => {
    if (call.name !== 'memory') return [];
    const output = asRecord(call.output);
    const remembered = asRecord(output?.remembered);
    if (!output || output.action !== 'remember' || !remembered || typeof remembered.id !== 'number') return [];
    return [
      {
        memoryId: remembered.id,
        title: typeof remembered.title === 'string' ? remembered.title : '',
        scope: output.scope === 'bot' ? 'bot' : 'user',
      },
    ];
  });
}
