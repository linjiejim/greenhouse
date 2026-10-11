/**
 * Other members' public Agents on the phone (spec docs/specs/20261011-agent-first-class.md §5c P4,
 * D33–D41; server contract apps/api/src/bots/AGENTS.md「公开 Agent」). Someone publishes one of their
 * Agents to an audience; a member in it finds it under "Browse Agents" (`GET /api/agents`), talks to
 * it in their own DM (`POST /api/agents/:id/conversation`) and may rate its replies. Its owner never
 * reads that DM. Such a DM is a plain `kind: 'direct'` conversation whose `owner_bot_id` is not one
 * of the member's Agents; `GET /api/bots` names those Agents in `shared_bots` (`available: false`
 * once unpublished, paused or no longer offered — the DM stays readable).
 *
 * React-free so the root vitest pins it (./public-agents.test.ts). The store
 * (./store-core.ts) keeps the shared Agents by id and puts each into its `byId` directory as a
 * stand-in `BotView` (`sharedAsBot`), so every surface that names a speaker, draws a plant or
 * titles a thread just works; the few rules that differ live here.
 */

import { isSproutyBot, type BotMessage, type BotView, type SharedBotView } from '../shared/bots';

/** Shared Agents by id (`GET /api/bots` `shared_bots`). */
export type SharedBots = Readonly<Record<string, SharedBotView>>;

/**
 * A shared Agent as a directory entry: who it is, nothing of its definition (the member never sees
 * its instructions, tools or model). Always `active` — whether it still answers is `available`,
 * read through `replyableIds` / `sharedReadOnly`, so its name is never marked "(archived)". It is
 * never the member's main Agent (Sprouty is never public, D1): a `sprouty` template key is dropped.
 */
export function sharedAsBot(view: SharedBotView): BotView {
  return {
    id: view.id,
    name: view.name,
    role: view.role,
    description: view.description,
    instructions: '',
    avatar: view.avatar,
    model_id: null,
    tools: null,
    connectors: null,
    max_steps: null,
    template_key: isSproutyBot(view) ? null : view.template_key,
    status: 'active',
    dm_session_id: view.dm_session_id,
    current_version: 0,
    user_id: view.owner.id,
    visibility: 'public',
    published_version: null,
    last_active_at: null,
    created_at: '',
    updated_at: '',
  };
}

/** `shared_bots` by id; the member's own Agents win (the server never lists them, but be strict). */
export function sharedById(
  views: readonly SharedBotView[] | undefined,
  own: ReadonlySet<string>,
): Record<string, SharedBotView> {
  const out: Record<string, SharedBotView> = {};
  for (const view of views ?? []) if (!own.has(view.id)) out[view.id] = view;
  return out;
}

/**
 * Agents someone can still reply as: the member's own active Agents and the shared ones still
 * offered — the set `conversationCanReply` takes.
 */
export function replyableIds(bots: readonly Pick<BotView, 'id'>[], shared: SharedBots | undefined): Set<string> {
  const ids = new Set(bots.map((bot) => bot.id));
  for (const view of Object.values(shared ?? {})) if (view.available) ids.add(view.id);
  return ids;
}

/** The shared Agent a conversation is with (its owner Agent), if it is someone else's. */
export function sharedOwnerOf(
  conversation: { owner_bot_id: string | null } | null | undefined,
  shared: SharedBots | undefined,
): SharedBotView | null {
  const id = conversation?.owner_bot_id;
  return (id && shared?.[id]) || null;
}

/**
 * May a conversation offer its Agent's computer? Always for the member's own Agents (`view` null).
 * Someone else's has one only when its owner granted it (`computer` — the member gets their own copy)
 * and it is still offered; the computer routes refuse it otherwise (404 `agent_not_found`), so its
 * status is never asked for.
 */
export function computerOffered(view: SharedBotView | null): boolean {
  return !view || (view.available && view.computer);
}

/** A DM with a shared Agent that is no longer offered: read-only (`agent_unavailable`). */
export function sharedReadOnly(
  conversation: { owner_bot_id: string | null } | null | undefined,
  shared: SharedBots | undefined,
): 'agent_unavailable' | null {
  const view = sharedOwnerOf(conversation, shared);
  return view && !view.available ? 'agent_unavailable' : null;
}

/**
 * Can the member rate this reply (👍 / 👎, D38)? A persisted reply of someone else's public Agent —
 * not a system line (its greeting, an event). Their own Agents' replies have no one to tell.
 */
export function rateableReply(
  message: Pick<BotMessage, 'role' | 'bot_id' | 'bot_event'> | null | undefined,
  shared: SharedBots | undefined,
): boolean {
  return (
    !!message && message.role === 'assistant' && !message.bot_event && !!message.bot_id && !!shared?.[message.bot_id]
  );
}

/**
 * The member's ratings once a conversation page arrived: its replies carry them (`my_ratings`; a
 * reply missing from it is unrated, an older server sends none). Replies rated or taken back on this
 * device (`ratedHere`) keep that choice — the member is a rating's only writer, and a page read before
 * the write landed would bring the old one back. Nothing changed → `ratings` itself.
 */
export function withPageRatings(
  ratings: Record<string, 1 | -1>,
  messages: readonly Pick<BotMessage, 'id' | 'role' | 'bot_id'>[],
  myRatings: Readonly<Record<string, 1 | -1>> | undefined,
  ratedHere: ReadonlySet<string>,
): Record<string, 1 | -1> {
  let out = ratings;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.bot_id || ratedHere.has(message.id)) continue;
    const next = myRatings?.[message.id];
    if (out[message.id] === next) continue;
    if (out === ratings) out = { ...ratings };
    if (next === undefined) delete out[message.id];
    else out[message.id] = next;
  }
  return out;
}

/** A rating's comment as the server takes it: trimmed, at most 1000 characters, none when empty. */
export const FEEDBACK_COMMENT_MAX = 1000;

export function feedbackBody(rating: 1 | -1, comment?: string | null): { rating: 1 | -1; comment?: string } {
  const text = (comment ?? '').trim().slice(0, FEEDBACK_COMMENT_MAX);
  return text ? { rating, comment: text } : { rating };
}

/**
 * Why starting a conversation with a public Agent failed: `gone` — it is no longer offered to
 * this member (404: unpublished, paused, out of the audience — or a server without public Agents);
 * `offline` — no answer; `failed` — anything else.
 */
export function startFailure(result: { status: number }): 'gone' | 'offline' | 'failed' {
  if (result.status === 404) return 'gone';
  if (result.status === 0) return 'offline';
  return 'failed';
}

/**
 * The Browse list's rows, in the server's order (a row keeps its place after the member talks to
 * it). A search matches the name, role, description and owner.
 */
export function directoryRows(agents: readonly SharedBotView[], query = ''): SharedBotView[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...agents];
  return agents.filter((agent) =>
    [agent.name, agent.role, agent.description, agent.owner.nickname].join('\n').toLocaleLowerCase().includes(q),
  );
}

/**
 * After `POST /api/agents/:id/conversation`: the Agent as a shared entry with its new DM, so the
 * thread names it before `GET /api/bots` catches up.
 */
export function withConversation(view: SharedBotView, sessionId: string): SharedBotView {
  return { ...view, dm_session_id: sessionId, available: true };
}
