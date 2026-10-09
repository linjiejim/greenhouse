/**
 * Home-screen widget snapshot — SCHEMA TRUTH SOURCE, and the pure rules that fill it.
 *
 * The app publishes one JSON snapshot (plus avatar PNGs) to the App Group
 * (./snapshot.ts → modules/widget-bridge); the Swift `Snapshot` Codable in
 * targets/widget/index.swift decodes exactly this shape — change them
 * together and bump `SNAPSHOT_VERSION` on breaking changes (the widget ignores
 * a snapshot with a newer `v` and falls back to launcher-only mode).
 *
 * What the widget shows (spec docs/specs/20261009-ios-widget-bots.html):
 * - `bots` — Sprouty first, then the Bots whose DM moved last (the drawer's
 *   order, so positions stay put); a Bot waiting on the member beyond the
 *   slots takes the last slot that isn't. Each carries the drawer row's one
 *   signal — "needs you" (pending cards) beats unread — and the avatar face
 *   that goes with it. `null` = Bots unavailable: the widget shows recent
 *   `sessions` instead.
 * - `defaultAgent` — who "New Chat" starts with (Settings → default agent).
 *
 * Avatars: the widget can't draw SVG, so every face is rendered by the app
 * (./art-host.tsx) to `<key>.png` in the App Group. `artKey` hashes the SVG
 * text, so a face is rendered once and any builder change renders fresh files.
 *
 * React-free: the root vitest runs ./model.test.ts.
 */

import type { BotConversationSummary, BotRequestView, BotView } from '../shared/bots';
import { isSproutyBot } from '../shared/bots';
import { drawerRows, sproutyBot, type BotsData } from '../bots/store-core';
import { rowPreview, type RowCopy, type RowDirectory } from '../bots/drawer/row-text';
import { buildPlantAvatarSvg } from '../ui/plant-avatar/plant-avatar-svg';
import { forSvgXml } from '../ui/plant-avatar/plant-avatar-native';
import { resolvePlantAvatar, type PlantState } from '../ui/plant-avatar/plant-ids';

export const SNAPSHOT_VERSION = 2;
/** Bots on the medium / large widget (Sprouty included). */
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

export interface WidgetBot {
  id: string;
  /** The Bot's DM; null only for Sprouty before its DM exists (the deep link bootstraps it). */
  sessionId: string | null;
  name: string;
  /** Face for the current signal: waiting when it needs the member, else at rest. */
  art: WidgetArt;
  sprouty: boolean;
  /** The row's one signal (the drawer's rule). */
  badge: 'needs_you' | 'unread' | null;
  /** needs_you → pending cards; unread → Bot replies; null → a dot (unread count unknown — older server). */
  count: number | null;
  /** The pending card to scroll to (oldest first), when it is known. */
  requestId: string | null;
  /** The last message, one line: "You: …" or the Bot's words. */
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
  /** Who "New Chat" starts with; null = unknown (the widget falls back to Sprouty's bundled art). */
  defaultAgent: WidgetAgent | null;
  /** null = Bots unavailable (feature off, not an internal account, Android) → `sessions` instead. */
  bots: WidgetBot[] | null;
  /** Recent conversations — only filled when `bots` is null. */
  sessions: WidgetSession[];
}

/** A face the app still has to render: `svg` → `<key>.png`. */
export interface ArtJob {
  key: string;
  svg: string;
}

// ─── Rules ───────────────────────────────────────────────

export type WidgetBotsSource = Pick<BotsData, 'bots' | 'byId' | 'botsLoaded' | 'conversations' | 'pendingRequests'>;

export interface WidgetBotPick {
  bot: BotView;
  /** Its DM row; null for Sprouty before its DM is listed. */
  row: BotConversationSummary | null;
}

const waiting = (pick: WidgetBotPick) => (pick.row?.pending_requests ?? 0) > 0;

/**
 * The Bots the widget shows, in order: Sprouty (never moves), then each Bot
 * whose DM someone can still reply in, newest activity first — never re-sorted
 * by attention, so a face stays where the member last saw it. A Bot waiting on
 * the member that didn't make the cut replaces the last slot that isn't
 * waiting. Empty until the Bot list has answered (names unknown).
 */
export function widgetBotPicks(s: WidgetBotsSource, slots = WIDGET_BOT_SLOTS): WidgetBotPick[] {
  if (!s.botsLoaded) return [];
  const { pinned, recent } = drawerRows(s, { query: '', expanded: true });
  const active = new Map(s.bots.map((bot) => [bot.id, bot]));
  const sprouty = sproutyBot(s);
  const picks: WidgetBotPick[] = sprouty ? [{ bot: sprouty, row: pinned }] : [];
  for (const row of recent) {
    const bot = row.owner_bot_id ? active.get(row.owner_bot_id) : undefined;
    if (row.kind !== 'direct' || !bot || isSproutyBot(bot)) continue;
    picks.push({ bot, row });
  }
  const shown = picks.slice(0, slots);
  const floor = sprouty ? 1 : 0;
  for (const pick of picks.slice(slots).filter(waiting)) {
    let i = shown.length - 1;
    while (i >= floor && waiting(shown[i])) i -= 1;
    if (i < floor) break;
    shown[i] = pick;
  }
  return shown;
}

/** A row's one signal and its number: pending cards beat unread replies. */
export function widgetBadge(row: BotConversationSummary | null): Pick<WidgetBot, 'badge' | 'count'> {
  if (!row) return { badge: null, count: null };
  if (row.pending_requests > 0) return { badge: 'needs_you', count: row.pending_requests };
  if (row.attention === 'unread') {
    const n = row.unread_count ?? 0;
    return { badge: 'unread', count: n > 0 ? n : null };
  }
  return { badge: null, count: null };
}

/** The oldest pending card of a conversation — the one the thread scrolls to. */
export function firstPendingRequest(requests: readonly BotRequestView[], sessionId: string): string | null {
  let first: BotRequestView | null = null;
  for (const request of requests) {
    if (request.session_id !== sessionId || request.status !== 'pending') continue;
    if (!first || request.created_at < first.created_at) first = request;
  }
  return first?.id ?? null;
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

export type AvatarSource = Pick<BotView, 'id' | 'avatar' | 'template_key'>;

/** Both schemes of one face, queued in `jobs` (deduped by key). */
function art(source: AvatarSource | null, state: PlantState, jobs: Map<string, string>): WidgetArt {
  // No identity (the Bot list hasn't answered): Sprouty's plant, the same default the chat hero shows.
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
  /** The Bots store, or null when Bots are unavailable. */
  bots: WidgetBotsSource | null;
  /** The default agent: its name and, when it is a Bot we know, the Bot (null → Sprouty's plant). */
  defaultAgent: { name: string; avatar: AvatarSource | null } | null;
  sessions: WidgetSession[];
  copy: RowCopy;
  /** Hermes-safe timestamp parsing (src/lib/format.ts `parseMs`). */
  parseMs: (iso: string) => number;
}

/** The snapshot to publish and the faces it needs rendered. */
export function buildWidgetSnapshot(input: WidgetInput): { snapshot: WidgetSnapshot; jobs: ArtJob[] } {
  const jobs = new Map<string, string>();
  const ms = (iso: string | null | undefined) => {
    const t = iso ? input.parseMs(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  let bots: WidgetBot[] | null = null;
  if (input.bots) {
    const source = input.bots;
    const dir: RowDirectory = { byId: source.byId, botsLoaded: source.botsLoaded };
    bots = widgetBotPicks(source).map(({ bot, row }) => {
      const signal = widgetBadge(row);
      const sessionId = row?.session_id ?? bot.dm_session_id ?? null;
      return {
        id: bot.id,
        sessionId,
        name: bot.name,
        art: art(bot, signal.badge === 'needs_you' ? 'waiting' : 'idle', jobs),
        sprouty: isSproutyBot(bot),
        ...signal,
        requestId:
          signal.badge === 'needs_you' && sessionId ? firstPendingRequest(source.pendingRequests, sessionId) : null,
        preview: row ? oneLine(rowPreview(row, dir, input.copy)) : '',
        lastAt: row ? ms(row.last_message?.created_at ?? row.last_activity_at) : null,
      };
    });
  }
  const agent = input.defaultAgent;
  const snapshot: WidgetSnapshot = {
    v: SNAPSHOT_VERSION,
    updatedAt: input.now,
    nickname: input.nickname,
    lang: input.lang,
    defaultAgent: agent
      ? { name: agent.name, art: art(agent.avatar, 'idle', jobs), sleep: art(agent.avatar, 'sleep', jobs) }
      : null,
    bots,
    sessions: bots ? [] : input.sessions,
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
