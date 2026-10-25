/**
 * Home's rules. React-free (./home.test.ts): the greeting for the hour, and the recent
 * conversations — pinned ones first (in their pinned order), then the newest.
 */

import type { ChatSession } from '../shared/greenhouse-types';
import { parseMs } from './time';

export type Greeting = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';

export function greetingFor(hour: number): Greeting {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 13) return 'noon';
  if (hour >= 13 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

export const RECENT_ON_HOME = 5;

/** The profiles that are Sprouty (the built-in assistant); anything else is an agent of its own. */
const SPROUTY_PROFILES = new Set(['sprouty', 'team', 'desktop']);

/** The agent a conversation was held with when it is not Sprouty (`custom:<id>[@v]`), else null. */
export function conversationAgent(profileId: string | null | undefined): string | null {
  const id = profileId?.trim();
  if (!id || SPROUTY_PROFILES.has(id)) return null;
  return id.replace(/@\d+$/, '');
}

export function orderConversations(sessions: readonly ChatSession[]): ChatSession[] {
  const time = (s: ChatSession) => {
    const ms = parseMs(s.updated_at);
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...sessions].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned && (a.pin_sort ?? 0) !== (b.pin_sort ?? 0)) return (a.pin_sort ?? 0) - (b.pin_sort ?? 0);
    return time(b) - time(a);
  });
}

/** A saved list of conversations, or null when the copy is not one. */
export function parseSessions(saved: unknown): ChatSession[] | null {
  if (!Array.isArray(saved)) return null;
  return saved.filter((s): s is ChatSession => !!s && typeof (s as ChatSession).id === 'string');
}

/** The list with one conversation pinned or unpinned (optimistic, before the station answers). */
export function withPinned(sessions: readonly ChatSession[], id: string, pinned: boolean): ChatSession[] {
  return sessions.map((s) => (s.id === id ? { ...s, pinned, pin_sort: pinned ? -Date.now() : undefined } : s));
}
