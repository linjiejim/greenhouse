/**
 * What a Bots conversation row says — in the drawer and the archived sheet —
 * kept pure so the root vitest pins it (./row-text.test.ts).
 * Mirrors the web sidebar's row (apps/web/src/components/bots/bots-sidebar-panel.tsx
 * `ConversationRow`): the vendored `conversationTitle`, and a one-line preview
 * that says who spoke ("You: …", "Fern: …" in a group, the DM's own Bot bare).
 *
 * Before the Bot list has answered, a name we have not heard about yet is not a
 * deleted Bot (web invariant 17): the title is '' (the row draws a skeleton bar)
 * and a group speaker goes unnamed.
 */

import type { BotConversationSummary, BotView } from '../../shared/bots';
import type { PlantState } from '../../ui/plant-avatar/plant-ids';
import { conversationBotIds, conversationTitle } from '../vendor/web-helpers';

/** Localized copy, built by the caller (this module never reads the language). */
export interface RowCopy {
  deletedBot: string;
  untitledGroup: string;
  archivedName(name: string): string;
  youSaid(text: string): string;
  botSaid(name: string, text: string): string;
  noMessages: string;
}

/** The Bot directory slice a row reads (`useBots`). */
export interface RowDirectory {
  byId: Record<string, BotView>;
  botsLoaded: boolean;
}

type Row = Pick<BotConversationSummary, 'kind' | 'title' | 'owner_bot_id' | 'members' | 'last_message'>;

/** The row's title; '' while the Bot list has not answered. */
export function rowTitle(row: Row, dir: RowDirectory, copy: RowCopy): string {
  const bots = new Map<string, BotView>();
  for (const id of conversationBotIds(row)) {
    const bot = dir.byId[id];
    if (bot) bots.set(id, bot);
  }
  return conversationTitle(row, bots, {
    unknownBot: dir.botsLoaded ? copy.deletedBot : '',
    group: dir.botsLoaded ? copy.untitledGroup : '',
    archived: copy.archivedName,
  });
}

/** The one-line preview of the last message, whitespace collapsed (the web truncates the same way). */
export function rowPreview(row: Row, dir: RowDirectory, copy: RowCopy): string {
  const last = row.last_message;
  if (!last) return copy.noMessages;
  const text = last.preview.replace(/\s+/g, ' ').trim();
  if (last.role === 'user') return copy.youSaid(text);
  if (last.bot_id && row.kind === 'group') {
    const name = dir.byId[last.bot_id]?.name ?? (dir.botsLoaded ? copy.deletedBot : '');
    return name ? copy.botSaid(name, text) : text;
  }
  return text;
}

/**
 * The row's time, short and Messages-style (it shares the line with the name,
 * so it must stay narrow at large text sizes): the time of day today,
 * "Yesterday", the weekday within the week, else the date — with the year
 * when it isn't this year. '' for an unreadable timestamp.
 */
export function rowTime(at: number, now: number, locale: string, yesterday: string): string {
  if (!Number.isFinite(at)) return '';
  const day = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  const date = new Date(at);
  try {
    if (days <= 0) return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    if (days === 1) return yesterday;
    if (days < 7) return date.toLocaleDateString(locale, { weekday: 'short' });
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return date.toLocaleDateString(
      locale,
      sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' },
    );
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * A DM row's plant face (lists change face, they don't move — except the Bot
 * replying right now): asleep when no one can reply, leaning in when a card
 * waits, talking while it replies, else at rest.
 */
export function rowPose(
  signal: { badge: 'needs_you' | 'unread' | null; working: boolean },
  replyable: boolean,
): { state: PlantState; animate: boolean } {
  if (!replyable) return { state: 'sleep', animate: false };
  if (signal.badge === 'needs_you') return { state: 'waiting', animate: false };
  if (signal.working) return { state: 'speaking', animate: true };
  return { state: 'idle', animate: false };
}
