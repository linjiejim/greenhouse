/**
 * Bots routing helpers: `#/bots?c=<sessionId>` is the one address of a
 * conversation, and every surface (sidebar, page, request deep links, the
 * `#/chat?session=` redirect) builds it the same way.
 */

import { useEffect, useState } from 'react';
import type { BotConversationSummary, BotView } from '@greenhouse/types/bots';

export function botsConversationHash(sessionId: string): string {
  return `#/bots?c=${encodeURIComponent(sessionId)}`;
}

/** Open a conversation. `replace` keeps an automatic jump out of the back stack. */
export function openBotsConversation(sessionId: string, options: { replace?: boolean } = {}): void {
  const hash = botsConversationHash(sessionId);
  if (window.location.hash === hash) return;
  if (options.replace) window.location.replace(hash);
  else window.location.hash = hash;
}

function currentConversationFromHash(): string | null {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [path, query] = hash.split('?');
  if (path.split('/')[0] !== 'bots') return null;
  return new URLSearchParams(query ?? '').get('c');
}

/** The open conversation id, following the hash (the sidebar has no router params of its own). */
export function useCurrentBotsConversation(): string | null {
  const [current, setCurrent] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : currentConversationFromHash(),
  );
  useEffect(() => {
    const sync = () => setCurrent(currentConversationFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return current;
}

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

/** A fresh Chat session with this Bot (by-session mode): the Chat page reads `profile`. */
export function openChatWith(botId: string): void {
  window.location.hash = `#/chat?profile=${encodeURIComponent(`bot:${botId}`)}`;
}
