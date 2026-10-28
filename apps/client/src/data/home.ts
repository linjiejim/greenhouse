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

/** How many recent conversations home lists (a setting in 「我」); 0 lists none. */
export const HOME_RECENT_CHOICES = [0, 3, 5, 10] as const;
export type HomeRecent = (typeof HOME_RECENT_CHOICES)[number];
export const DEFAULT_HOME_RECENT: HomeRecent = 3;

/** A saved choice, or null when it is not one of HOME_RECENT_CHOICES. */
export function homeRecentOf(raw: string | null | undefined): HomeRecent | null {
  const n = Number(raw);
  return (HOME_RECENT_CHOICES as readonly number[]).includes(n) && raw !== null && raw !== ''
    ? (n as HomeRecent)
    : null;
}

/** The profiles that are Sprouty (the built-in assistant); anything else is an agent of its own. */
const SPROUTY_PROFILES = new Set(['sprouty', 'desktop']);

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

/**
 * Tapping the greeting sprout: each tap answers with the next face (a happy hop, a wave, a
 * chatter), then it rests; EGG_TAPS taps within EGG_WINDOW_MS make the easter egg (a happy spin)
 * and start the count again.
 */
export const SPROUT_REACTIONS = ['done', 'hello', 'speaking'] as const;
export type SproutReaction = (typeof SPROUT_REACTIONS)[number];
export const EGG_TAPS = 5;
export const EGG_WINDOW_MS = 2000;
/** How long a reaction shows before the sprout rests (each tap restarts it). */
export const SPROUT_REACTION_MS = 900;

export interface SproutTaps {
  /** Taps so far: picks the next face. */
  count: number;
  /** When the taps of the current run came (ms), the oldest first. */
  recent: readonly number[];
}

export const NO_SPROUT_TAPS: SproutTaps = { count: 0, recent: [] };

export function tapSprout(
  taps: SproutTaps,
  now: number,
): { taps: SproutTaps; reaction: SproutReaction; egg: boolean } {
  const recent = [...taps.recent.filter((at) => now - at < EGG_WINDOW_MS), now];
  const egg = recent.length >= EGG_TAPS;
  const reaction = egg ? 'done' : SPROUT_REACTIONS[taps.count % SPROUT_REACTIONS.length]!;
  return { taps: { count: taps.count + 1, recent: egg ? [] : recent }, reaction, egg };
}
