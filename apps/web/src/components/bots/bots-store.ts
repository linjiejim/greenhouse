/**
 * Bots client state — the member's Bots, their conversations and the
 * "needs you" count. (The computer's live state belongs to the computer UI's
 * own `useComputerStatus`.)
 *
 * One store because three surfaces render the same facts at once: the shell
 * (nav badge, document title, `#/chat?session=` redirect), the contextual
 * sidebar (the conversation list, Sprouty pinned first) and the Bots page. Each reading
 * its own copy would mean three fetches and three subtly different "needs
 * you" numbers. The server stays the source of truth: this is a cache that WS
 * events (`bots:*`) invalidate, never a place a decision is made.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import type { BotConversationSummary, BotView, ComputerRuntimeView } from '@greenhouse/types/bots';
import * as botsApi from '../../lib/api/bots';

/** Which creation dialog the page should show (opened from the sidebar or the page). */
export type BotsDialog = { kind: 'new-bot'; inviteTo?: string } | { kind: 'invite'; sessionId: string } | null;

interface BotsState {
  /** Active Bots — pickers, the avatar strip, mentions, the invite list. */
  bots: BotView[];
  /**
   * Archived Bots. They never reply again, but their conversations stay
   * readable, so history still needs their names and faces (shown as
   * "Sage (archived)"). Filled from the overview's `archived_bots` and from
   * archiving in this tab.
   */
  archivedBots: BotView[];
  conversations: BotConversationSummary[];
  /** Org-level computer runtime (ready / unavailable / disabled). */
  computerRuntime: ComputerRuntimeView | null;
  vaultAvailable: boolean;
  /** Pending "needs you" requests across every conversation. */
  pending: number;
  /** Every Bots conversation id this member owns — drives the `#/chat?session=` redirect. */
  knownSessionIds: ReadonlySet<string>;
  /** The Bot list arrived at least once. Until then an unknown id means "not loaded yet", never "deleted". */
  botsLoaded: boolean;
  conversationsLoaded: boolean;
  /** The last Bot-list load failed (cleared by the next success) — surfaces show it with a retry. */
  loadError: string | null;
  dialog: BotsDialog;
  /** Bot whose profile drawer is open. */
  profileBotId: string | null;
  /** Open the profile drawer straight into its edit dialog (the Sprouty naming nudge). */
  profileEdit: boolean;

  loadBots: () => Promise<void>;
  loadConversations: () => Promise<void>;
  /**
   * Re-read the Bot list when `ids` name a Bot this tab has never seen (made in
   * another tab, on the phone, or by a Bot's `team.create`), so its
   * conversation shows its name instead of "Deleted Bot" filed under Archived.
   * At most once per unknown id.
   */
  ensureBotsKnown: (ids: Iterable<string>) => Promise<void>;
  upsertBot: (bot: BotView) => void;
  /** The member archived a Bot: it leaves the active list but keeps its name for history. */
  markArchived: (botId: string) => void;
  setPending: (pending: number) => void;
  noteSession: (sessionId: string) => void;
  openDialog: (dialog: BotsDialog) => void;
  openProfile: (botId: string | null, options?: { edit?: boolean }) => void;
  reset: () => void;
}

const INITIAL = {
  bots: [] as BotView[],
  archivedBots: [] as BotView[],
  conversations: [] as BotConversationSummary[],
  computerRuntime: null as ComputerRuntimeView | null,
  vaultAvailable: false,
  pending: 0,
  knownSessionIds: new Set<string>() as ReadonlySet<string>,
  botsLoaded: false,
  conversationsLoaded: false,
  loadError: null as string | null,
  dialog: null as BotsDialog,
  profileBotId: null as string | null,
  profileEdit: false,
};

// In-flight dedupe: the shell, sidebar and page all ask on mount.
let botsInFlight: Promise<void> | null = null;
let conversationsInFlight: Promise<void> | null = null;
// Unknown Bot ids a refresh was already spent on: an id still unknown after one
// re-read really is gone, and must not trigger a load on every render.
const refreshedForIds = new Set<string>();
// Bumped by `reset()` (Bots turned off, sign-out): an answer to a request made
// before it must not repopulate the store, nor keep later loads waiting on it.
let generation = 0;

export const useBotsStore = create<BotsState>((set, get) => ({
  ...INITIAL,

  loadBots: () => {
    if (botsInFlight) return botsInFlight;
    const asked = generation;
    const request = (async () => {
      try {
        const overview = await botsApi.listBots();
        if (asked !== generation) return;
        // `bots` is active-only and `archived_bots` carries the rest; sorting by
        // each Bot's own status keeps a Bot archived mid-request on the right side.
        const everyone = botsApi.allBotsOf(overview);
        set({
          bots: everyone.filter((bot) => bot.status === 'active'),
          archivedBots: mergeArchived(
            get().archivedBots,
            everyone.filter((bot) => bot.status !== 'active'),
          ),
          computerRuntime: overview.computer,
          vaultAvailable: overview.vault_available,
          pending: overview.pending_requests,
          botsLoaded: true,
          loadError: null,
        });
      } catch (err) {
        if (asked === generation) set({ loadError: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        // One load per generation (deduped), so a matching generation means it is ours.
        if (asked === generation) botsInFlight = null;
      }
    })();
    botsInFlight = request;
    return request;
  },

  loadConversations: () => {
    if (conversationsInFlight) return conversationsInFlight;
    const asked = generation;
    const request = (async () => {
      try {
        const { conversations } = await botsApi.listConversations();
        if (asked !== generation) return;
        // Before publishing the list: a row whose Bot this tab has not seen yet
        // would otherwise flash as "Deleted Bot" under Archived.
        await get()
          .ensureBotsKnown(conversations.flatMap(conversationBotIds))
          .catch(() => {});
        if (asked !== generation) return;
        const known = new Set(get().knownSessionIds);
        for (const conversation of conversations) known.add(conversation.session_id);
        set({
          conversations,
          knownSessionIds: known,
          // Per-conversation counts are as fresh as the list; the WS push
          // overrides between fetches.
          pending: conversations.reduce((sum, conversation) => sum + conversation.pending_requests, 0),
          conversationsLoaded: true,
        });
      } finally {
        if (asked === generation) conversationsInFlight = null;
      }
    })();
    conversationsInFlight = request;
    return request;
  },

  ensureBotsKnown: async (ids) => {
    const { bots, archivedBots, botsLoaded } = get();
    // Before the first load every id is unknown; that load answers them all.
    if (!botsLoaded) return;
    const known = new Set([...bots, ...archivedBots].map((bot) => bot.id));
    const unknown = [...new Set(ids)].filter((id) => !known.has(id) && !refreshedForIds.has(id));
    if (unknown.length === 0) return;
    for (const id of unknown) refreshedForIds.add(id);
    await get().loadBots();
  },

  upsertBot: (bot) =>
    set((state) => {
      if (bot.status !== 'active') {
        return {
          bots: state.bots.filter((candidate) => candidate.id !== bot.id),
          archivedBots: mergeArchived(state.archivedBots, [bot]),
        };
      }
      const exists = state.bots.some((candidate) => candidate.id === bot.id);
      const bots = exists
        ? state.bots.map((candidate) => (candidate.id === bot.id ? bot : candidate))
        : [...state.bots, bot];
      return { bots, archivedBots: state.archivedBots.filter((candidate) => candidate.id !== bot.id) };
    }),

  markArchived: (botId) =>
    set((state) => {
      const bot = state.bots.find((candidate) => candidate.id === botId);
      if (!bot) return state;
      return {
        bots: state.bots.filter((candidate) => candidate.id !== botId),
        archivedBots: mergeArchived(state.archivedBots, [{ ...bot, status: 'archived' }]),
      };
    }),

  setPending: (pending) => set({ pending: Math.max(0, pending) }),

  noteSession: (sessionId) =>
    set((state) => {
      if (state.knownSessionIds.has(sessionId)) return state;
      const known = new Set(state.knownSessionIds);
      known.add(sessionId);
      return { knownSessionIds: known };
    }),

  openDialog: (dialog) => set({ dialog }),

  openProfile: (profileBotId, options) => set({ profileBotId, profileEdit: Boolean(profileBotId && options?.edit) }),

  reset: () => {
    generation += 1;
    botsInFlight = null;
    conversationsInFlight = null;
    sproutyOnce = null;
    refreshedForIds.clear();
    set({ ...INITIAL, knownSessionIds: new Set<string>() });
  },
}));

let sproutyOnce: Promise<{ dm_session_id: string }> | null = null;

/**
 * Every member has Sprouty, the built-in main Bot: `POST /bootstrap` creates it (with its DM and
 * greeting) when missing and is idempotent. Called by the landing (no conversation yet) and by
 * the sidebar (a member whose Bots predate Sprouty); one request per page load — a failure may be
 * retried. The lists reload once it answers.
 */
export function ensureSprouty(): Promise<{ dm_session_id: string }> {
  if (!sproutyOnce) {
    const once = botsApi.bootstrapBots().then((result) => {
      const { loadBots, loadConversations } = useBotsStore.getState();
      void loadBots().catch(() => {});
      void loadConversations().catch(() => {});
      return result;
    });
    once.catch(() => {
      if (sproutyOnce === once) sproutyOnce = null;
    });
    sproutyOnce = once;
  }
  return sproutyOnce;
}

/** Whether the org has a usable computer runtime (templates marked "needs computer" warn otherwise). */
export function computerReady(runtime: ComputerRuntimeView | null): boolean {
  return runtime?.state === 'ready';
}

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
function mergeArchived(current: BotView[], incoming: readonly BotView[]): BotView[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((bot) => [bot.id, bot]));
  for (const bot of incoming) byId.set(bot.id, bot);
  return [...byId.values()];
}

/**
 * Every Bot the member has had — active and archived — by id. History
 * (titles, speakers, cards, receipts) renders from this; anything that offers
 * a Bot to talk to uses the active `bots` list instead.
 */
export function useBotDirectory(): Map<string, BotView> {
  const bots = useBotsStore((state) => state.bots);
  const archived = useBotsStore((state) => state.archivedBots);
  return useMemo(() => botsById([...archived, ...bots]), [archived, bots]);
}

/**
 * Where the Bot list stands: `loading` until the first answer (an unknown id
 * then means "not here yet", so callers show a skeleton, never "Deleted Bot"),
 * `error` when that first load failed (show it with a retry), else `ready`.
 */
export function useBotsLoadState(): 'loading' | 'ready' | 'error' {
  return useBotsStore((state) => (state.botsLoaded ? 'ready' : state.loadError ? 'error' : 'loading'));
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
