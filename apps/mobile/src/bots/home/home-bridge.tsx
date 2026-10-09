/**
 * The new chat's ties to the member's Bots (spec docs/specs/20261008-mobile-bots.md
 * §2.5.2, D4) — used by the home conversation screen (app/(drawer)/(main)/index.tsx):
 *
 *  - `useProfileBot` — the Bot behind a `?profile=` new chat ("Ask Dandy in a
 *    New Chat"): its directory entry and its ongoing DM, for the hero's name
 *    and the "Back to Dandy" button.
 *  - `useBotsWarm` — the home reads the Bot and conversation lists for the ☰
 *    badge and the hero; the realtime bridge keeps them fresh, this only fills
 *    what nobody has read yet (a cold start before the WS is up).
 *
 * Both loaders wait while auth is loading (`useAuth.loading`: startup and a
 * station switch, whose store reset clears `botsLoaded` before the new
 * station's session is in) — whatever the caller passes.
 */

import { useEffect, useMemo } from 'react';
import type { BotView } from '../../shared/bots';
import { useAuth } from '../../store/auth';
import { sproutyBot, sproutyDm, useBots } from '../store';

/**
 * The Bot a `?profile=` new chat talks to: `sprouty` or `bot:<id>`, with its
 * ongoing DM (null until known). null for any other profile — a system agent
 * picked in the agent capsule is not a Bot.
 */
export function useProfileBot(profile: string | undefined): { bot: BotView | null; dm: string | null } | null {
  // `bot:<id>`, possibly pinned to a version (`bot:<id>@<v>`)
  const botId = profile?.startsWith('bot:') ? profile.slice('bot:'.length).split('@')[0] || null : null;
  const isBot = profile === 'sprouty' || !!botId;
  const bot = useBots((s) => (profile === 'sprouty' ? sproutyBot(s) : botId ? (s.byId[botId] ?? null) : null));
  const dm = useBots((s) => {
    if (profile === 'sprouty') return sproutyDm(s);
    if (!botId) return null;
    const direct = s.byId[botId]?.dm_session_id;
    return (
      direct ?? s.conversations.find((row) => row.kind === 'direct' && row.owner_bot_id === botId)?.session_id ?? null
    );
  });
  const botsLoaded = useBots((s) => s.botsLoaded);
  const settled = useAuth((s) => !s.loading);
  useEffect(() => {
    if (settled && isBot && !botsLoaded) void useBots.getState().loadBots();
  }, [settled, isBot, botsLoaded]);
  return useMemo(() => (isBot ? { bot, dm } : null), [isBot, bot, dm]);
}

/** Fill the lists the home reads (☰ badge, the `?profile=` hero) when nothing has read them yet. */
export function useBotsWarm(wanted: boolean): void {
  const enabled = useAuth((s) => wanted && !s.loading);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const conversationsLoaded = useBots((s) => s.conversationsLoaded);
  useEffect(() => {
    if (!enabled) return;
    const store = useBots.getState();
    if (!botsLoaded) void store.loadBots();
    if (!conversationsLoaded) void store.loadConversations();
  }, [enabled, botsLoaded, conversationsLoaded]);
}
