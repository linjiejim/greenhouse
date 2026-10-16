/**
 * Home-screen widget snapshot — SCHEMA TRUTH SOURCE, and the pure rules that fill it.
 *
 * The app publishes one JSON snapshot (plus avatar PNGs) to the App Group
 * (./snapshot.ts → modules/widget-bridge); the Swift `Snapshot` Codable in
 * targets/widget/index.swift decodes exactly this shape — change them
 * together and bump `SNAPSHOT_VERSION` on breaking changes (the widget ignores
 * a snapshot with a newer `v` and falls back to launcher-only mode). The Swift
 * side still calls an Agent entry a `bot`; only the words on screen matter there.
 *
 * What the widget shows:
 * - `bots` — the member's Agents: the main Agent first (its thread is the main
 *   thread), then the Agents whose Agent thread moved last (the drawer's order, so
 *   positions stay put); an Agent waiting on the member beyond the slots takes the
 *   last slot that isn't. Each carries the drawer row's one signal — "needs you"
 *   (pending cards) beats unread, a muted thread shows neither — and the avatar
 *   face that goes with it. Rows never preview messages (PRD §6.2): the line under
 *   a name is the waiting card's title, else the Agent's role.
 * - `defaultAgent` — who "New Chat" starts with (the main Agent).
 * - `sessions` — kept for the Swift schema; always empty (every member has a main Agent).
 *
 * Avatars: the widget can't draw SVG, so every face is rendered by the app
 * (./art-host.tsx) to `<key>.png` in the App Group. `artKey` hashes the SVG
 * text, so a face is rendered once and any builder change renders fresh files.
 *
 * React-free: the root vitest runs ./model.test.ts.
 */

import type { Agent, Conversation, NeedsYou } from '../shared/contract';
import { buildPlantAvatarSvg } from '../ui/plant-avatar/plant-avatar-svg';
import { forSvgXml } from '../ui/plant-avatar/plant-avatar-native';
import { resolvePlantAvatar, type PlantState } from '../ui/plant-avatar/plant-ids';

export const SNAPSHOT_VERSION = 2;
/** Agents on the medium / large widget (the main Agent included). */
export const WIDGET_BOT_SLOTS = 4;
/** Rendered avatar size in points — the widget's largest face (small widget hero); PNG = × screen scale. */
export const ART_POINTS = 84;
/**
 * Size handed to the builder — it only picks the detail level: `avatar` (≤ 44), no brows and
 * no state marks; the portrait's "!" would sit right under the widget's badge.
 */
const ART_BUILD_SIZE = 44;
const PREVIEW_MAX = 80;

// ─── Schema ──────────────────────────────────────────────

/** App Group avatar files (`<key>.png`) per colour scheme; '' = not rendered (the widget draws a fallback). */
export interface WidgetArt {
  light: string;
  dark: string;
}

/** One Agent on the widget (Swift: `SnapshotBot`). */
export interface WidgetBot {
  /** The Agent's id. */
  id: string;
  /** Its Agent thread (the main thread for the main Agent); null opens the main thread. */
  sessionId: string | null;
  name: string;
  /** Face for the current signal: waiting when it needs the member, else at rest. */
  art: WidgetArt;
  /** The main Agent. */
  sprouty: boolean;
  /** The row's one signal (the drawer's rule). */
  badge: 'needs_you' | 'unread' | null;
  /** needs_you → pending cards; unread → unread messages; null → a dot. */
  count: number | null;
  /** The pending card to scroll to (oldest first), when it is known. */
  requestId: string | null;
  /** One line: the waiting card's title, else the Agent's role. */
  preview: string;
  lastAt: number | null;
}

export interface WidgetAgent {
  name: string;
  art: WidgetArt;
  /** The late-night face (22:00–6:00: the plant asleep). */
  sleep: WidgetArt;
}

export interface WidgetSession {
  id: string;
  title: string;
  updatedAt: number | null;
}

export interface WidgetSnapshot {
  v: number;
  updatedAt: number;
  nickname: string;
  lang: 'zh' | 'en';
  /** Who "New Chat" starts with; null = unknown (the widget falls back to its bundled sprout). */
  defaultAgent: WidgetAgent | null;
  /** The member's Agents; empty until the list has loaded. */
  bots: WidgetBot[] | null;
  /** Recent conversations — only shown when `bots` is null, which v2 never sends. */
  sessions: WidgetSession[];
}

/** A face the app still has to render: `svg` → `<key>.png`. */
export interface ArtJob {
  key: string;
  svg: string;
  /** Size in points (× the screen scale = the PNG's pixels); default `ART_POINTS`. A Live Activity's faces are smaller. */
  points?: number;
}

// ─── Rules ───────────────────────────────────────────────

export interface WidgetSource {
  agents: readonly Agent[];
  conversations: readonly Conversation[];
  /** Pending cards, as last listed (only used for the card to open and its title). */
  requests: readonly NeedsYou[];
}

export interface WidgetAgentPick {
  agent: Agent;
  /** Its Agent thread (the main thread for the main Agent), when listed. */
  conversation: Conversation | null;
}

const waiting = (pick: WidgetAgentPick) => (pick.conversation?.pending_requests ?? 0) > 0;
const activity = (conversation: Conversation, parseMs: (iso: string) => number) => parseMs(conversation.last_activity_at) || 0;

/**
 * The Agents the widget shows, in order: the main Agent (never moves), then each Agent with
 * an Agent thread, newest activity first — never re-sorted by attention, so a face stays where
 * the member last saw it. An Agent waiting on the member that didn't make the cut replaces the
 * last slot that isn't waiting. Archived Agents and threads are left out.
 */
export function widgetAgentPicks(
  s: Pick<WidgetSource, 'agents' | 'conversations'>,
  parseMs: (iso: string) => number,
  slots = WIDGET_BOT_SLOTS,
): WidgetAgentPick[] {
  const live = s.conversations.filter((item) => !item.archived);
  const main = s.agents.find((agent) => agent.is_main && !agent.archived_at);
  const threads = new Map<string, Conversation>();
  for (const item of live) if (item.kind === 'direct' && item.agent_id) threads.set(item.agent_id, item);
  const picks: WidgetAgentPick[] = main
    ? [{ agent: main, conversation: live.find((item) => item.kind === 'main') ?? null }]
    : [];
  const others = s.agents
    .filter((agent) => !agent.is_main && !agent.archived_at && threads.has(agent.id))
    .map((agent) => ({ agent, conversation: threads.get(agent.id)! }))
    .sort((a, b) => activity(b.conversation, parseMs) - activity(a.conversation, parseMs));
  picks.push(...others);
  const shown = picks.slice(0, slots);
  const floor = main ? 1 : 0;
  for (const pick of picks.slice(slots).filter(waiting)) {
    let i = shown.length - 1;
    while (i >= floor && waiting(shown[i]!)) i -= 1;
    if (i < floor) break;
    shown[i] = pick;
  }
  return shown;
}

/** A thread's one signal and its number: pending cards beat unread messages; muted shows neither. */
export function widgetBadge(conversation: Conversation | null): Pick<WidgetBot, 'badge' | 'count'> {
  if (!conversation) return { badge: null, count: null };
  if (conversation.pending_requests > 0) return { badge: 'needs_you', count: conversation.pending_requests };
  if (!conversation.muted && conversation.unread > 0) return { badge: 'unread', count: conversation.unread };
  return { badge: null, count: null };
}

/** The oldest pending card of a conversation — the one the thread scrolls to. */
export function firstPendingRequest(requests: readonly NeedsYou[], conversationId: string): NeedsYou | null {
  let first: NeedsYou | null = null;
  for (const request of requests) {
    if (request.conversation_id !== conversationId || request.status !== 'pending') continue;
    if (!first || request.created_at < first.created_at) first = request;
  }
  return first;
}

/** Stable file key of a face: FNV-1a over the SVG text + its length. */
export function artKey(svg: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < svg.length; i += 1) {
    h ^= svg.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `a${(h >>> 0).toString(16).padStart(8, '0')}${svg.length.toString(36)}`;
}

export type AvatarSource = Pick<Agent, 'id' | 'avatar' | 'template_key'>;

/** Both schemes of one face, queued in `jobs` (deduped by key). */
function art(source: AvatarSource | null, state: PlantState, jobs: Map<string, string>): WidgetArt {
  // No identity (the Agent list hasn't answered): the sprout, the same default the app shows.
  const { plant, tint } = source
    ? resolvePlantAvatar(source.avatar, { templateKey: source.template_key, stableId: source.id })
    : { plant: 'sprout' as const, tint: undefined };
  const face = (theme: 'light' | 'dark') => {
    const svg = forSvgXml(buildPlantAvatarSvg({ plant, tint, state, theme, size: ART_BUILD_SIZE }));
    const key = artKey(svg);
    jobs.set(key, svg);
    return key;
  };
  return { light: face('light'), dark: face('dark') };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

export interface WidgetInput {
  now: number;
  nickname: string;
  lang: 'zh' | 'en';
  /** What the app holds; null before the first load. */
  source: WidgetSource | null;
  /** Hermes-safe timestamp parsing (src/data/time.ts `parseMs`). */
  parseMs: (iso: string) => number;
}

/** The snapshot to publish and the faces it needs rendered. */
export function buildWidgetSnapshot(input: WidgetInput): { snapshot: WidgetSnapshot; jobs: ArtJob[] } {
  const jobs = new Map<string, string>();
  const ms = (iso: string | null | undefined) => {
    const t = iso ? input.parseMs(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const source = input.source;
  const bots: WidgetBot[] = source
    ? widgetAgentPicks(source, input.parseMs).map(({ agent, conversation }) => {
        const signal = widgetBadge(conversation);
        const card =
          signal.badge === 'needs_you' && conversation ? firstPendingRequest(source.requests, conversation.id) : null;
        return {
          id: agent.id,
          sessionId: conversation?.id ?? null,
          name: agent.name,
          art: art(agent, signal.badge === 'needs_you' ? 'waiting' : 'idle', jobs),
          sprouty: agent.is_main,
          ...signal,
          requestId: card?.id ?? null,
          preview: oneLine(card?.title || agent.role),
          lastAt: conversation ? ms(conversation.last_activity_at) : null,
        };
      })
    : [];
  const main = source?.agents.find((agent) => agent.is_main && !agent.archived_at) ?? null;
  const snapshot: WidgetSnapshot = {
    v: SNAPSHOT_VERSION,
    updatedAt: input.now,
    nickname: input.nickname,
    lang: input.lang,
    defaultAgent: main ? { name: main.name, art: art(main, 'idle', jobs), sleep: art(main, 'sleep', jobs) } : null,
    bots,
    sessions: [],
  };
  return { snapshot, jobs: [...jobs].map(([key, svg]) => ({ key, svg })) };
}

/** Every avatar file a snapshot points at (the rest of the folder can go). */
export function snapshotArtKeys(snapshot: WidgetSnapshot): string[] {
  const keys = new Set<string>();
  const add = (a: WidgetArt) => {
    if (a.light) keys.add(a.light);
    if (a.dark) keys.add(a.dark);
  };
  for (const bot of snapshot.bots ?? []) add(bot.art);
  if (snapshot.defaultAgent) {
    add(snapshot.defaultAgent.art);
    add(snapshot.defaultAgent.sleep);
  }
  return [...keys];
}

/** Clear the faces that failed to render, so the widget draws its fallback instead of a missing file. */
export function withoutMissingArt(snapshot: WidgetSnapshot, available: ReadonlySet<string>): WidgetSnapshot {
  const keep = (a: WidgetArt): WidgetArt => ({
    light: available.has(a.light) ? a.light : '',
    dark: available.has(a.dark) ? a.dark : '',
  });
  return {
    ...snapshot,
    bots: snapshot.bots?.map((bot) => ({ ...bot, art: keep(bot.art) })) ?? null,
    defaultAgent: snapshot.defaultAgent
      ? { ...snapshot.defaultAgent, art: keep(snapshot.defaultAgent.art), sleep: keep(snapshot.defaultAgent.sleep) }
      : null,
  };
}
