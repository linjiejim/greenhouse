/**
 * A Bot's background tasks as Live Activities — the pure rules (spec
 * docs/specs/20261010-mobile-live-activity.md §2.2, §3.1, §3.3). No React, no Expo: the root
 * vitest pins them (./model.test.ts), and ./attributes.parity.test.ts holds the shapes below
 * to the Swift `BotTaskAttributes` (two byte-identical copies, targets/widget and
 * modules/widget-bridge), which decodes exactly this JSON.
 *
 * - `planActivities`: the member's tasks + the activities on the phone → what to start,
 *   update and end. One activity per task; a task the phone has already shown is never
 *   shown again (the member may have swiped it away); another station's or account's
 *   activity, or the switch turned off, ends at once.
 * - Time is whole Unix seconds (never `Date`, never fractions): the timer runs from
 *   `started_at` (else `created_at`) and the view caps it at the task limit; `staleDate` is a
 *   minute past the limit.
 * - An ended activity stays on the lock screen for 15 minutes after the task ended (D5), or goes
 *   at once when that time has passed.
 * - Faces: the Bot's plant, drawn by the app into the App Group at the sizes the activity shows
 *   them (`activityArt`) — an image larger than its presentation can keep it from starting.
 */

import type { BotTaskView } from '../shared/bots';
import { buildPlantAvatarSvg } from '../ui/plant-avatar/plant-avatar-svg';
import { forSvgXml } from '../ui/plant-avatar/plant-avatar-native';
import { resolvePlantAvatar } from '../ui/plant-avatar/plant-ids';
import { artKey, type ArtJob, type AvatarSource } from '../widget/model';

export const LIVE_ACTIVITY_SCHEMA = 1;
/** The task limit (apps/api BOT_TASK_TIMEOUT_MS): the view's timer stops there. */
export const TASK_LIMIT_S = 20 * 60;
/** No news by a minute past the limit: the activity says "may have finished". */
export const STALE_AFTER_S = TASK_LIMIT_S + 60;
/** An ended activity lingers this long after the task ended (D5; the HIG suggests 15–30 min). */
export const ENDED_LINGER_S = 15 * 60;
/** A shown run is remembered this long (no task lives anywhere near it). */
export const SHOWN_KEEP_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 40;
const TITLE_MAX = 40;
/** Face sizes in points: the lock screen / expanded island, and compact / minimal. */
export const ART_LARGE_POINTS = 52;
export const ART_SMALL_POINTS = 36;

// ─── Shapes (Swift: BotTaskAttributes) ───────────────────

/** `BotTaskAttributes.ContentState`. */
export interface TaskActivityState {
  /** BotTaskView.status. */
  status: string;
  /** Whole Unix seconds. */
  startedAt: number;
  /** Terminal states only. */
  endedAt: number | null;
}

/** `BotTaskAttributes`. */
export interface TaskActivityAttributes {
  v: number;
  station: string;
  user: string;
  session: string;
  run: string;
  botName: string;
  sprouty: boolean;
  art: string;
  lang: 'zh' | 'en';
  title: string | null;
}

/** The property names the Swift struct declares, in its order — the parity test reads the Swift. */
export const ATTRIBUTE_KEYS = [
  'v',
  'station',
  'user',
  'session',
  'run',
  'botName',
  'sprouty',
  'art',
  'lang',
  'title',
] as const satisfies ReadonlyArray<keyof TaskActivityAttributes>;
export const STATE_KEYS = ['status', 'startedAt', 'endedAt'] as const satisfies ReadonlyArray<keyof TaskActivityState>;

/** One activity on the phone (`listTaskActivities`, LiveActivities.swift `ActivityInfo`). */
export interface ActivityInfo {
  id: string;
  run: string;
  station: string;
  user: string;
  session: string;
  art: string;
  status: string;
  startedAt: number;
  /** Ended — it may still show on the lock screen until its dismissal time. */
  ended: boolean;
}

/** The native list (JSON) → well-formed entries; anything else reads as none. */
export function parseActivities(json: string): ActivityInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const out: ActivityInfo[] = [];
  for (const item of parsed) {
    const a = (item ?? {}) as Record<string, unknown>;
    const id = text(a.id);
    const run = text(a.run);
    if (!id || !run) continue;
    out.push({
      id,
      run,
      station: text(a.station) ?? '',
      user: text(a.user) ?? '',
      session: text(a.session) ?? '',
      art: text(a.art) ?? '',
      status: text(a.status) ?? '',
      startedAt: typeof a.startedAt === 'number' ? a.startedAt : 0,
      ended: a.ended === true,
    });
  }
  return out;
}

// ─── Rules ───────────────────────────────────────────────

const ACTIVE: ReadonlySet<string> = new Set(['queued', 'running', 'waiting']);

export function isActiveTask(task: Pick<BotTaskView, 'status'>): boolean {
  return ACTIVE.has(task.status);
}

/** ISO → whole Unix seconds (null when it doesn't parse). */
type ParseMs = (iso: string) => number;

function seconds(iso: string | null | undefined, parseMs: ParseMs): number | null {
  if (!iso) return null;
  const ms = parseMs(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** A task's state for its activity. */
export function contentFor(task: BotTaskView, now: number, parseMs: ParseMs): TaskActivityState {
  const nowS = Math.floor(now / 1000);
  const startedAt = seconds(task.started_at, parseMs) ?? seconds(task.created_at, parseMs) ?? nowS;
  return {
    status: task.status,
    startedAt,
    endedAt: isActiveTask(task) ? null : (seconds(task.ended_at, parseMs) ?? nowS),
  };
}

/** When the activity turns stale (no news past the limit). */
export function staleAt(state: TaskActivityState): number {
  return state.startedAt + STALE_AFTER_S;
}

/** When an ended activity leaves the lock screen: 15 min after the task ended, or 0 = at once. */
export function dismissAt(endedAt: number | null, now: number): number {
  const at = (endedAt ?? Math.floor(now / 1000)) + ENDED_LINGER_S;
  return at * 1000 > now ? at : 0;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

export function attributesFor(input: {
  task: BotTaskView;
  /** The conversation (the task's own `conversation_id`, else the one it was started from). */
  session: string;
  station: string;
  user: string;
  bot: { name: string; sprouty: boolean } | null;
  art: string;
  lang: 'zh' | 'en';
  /** The device shows previews (push D3): only then the title. */
  preview: boolean;
}): TaskActivityAttributes {
  const title = input.preview ? clip(input.task.title, TITLE_MAX) : '';
  return {
    v: LIVE_ACTIVITY_SCHEMA,
    station: input.station,
    user: input.user,
    session: input.session,
    run: input.task.run_id,
    botName: clip(input.bot?.name ?? '', NAME_MAX) || 'Bot',
    sprouty: input.bot?.sprouty ?? false,
    art: input.art,
    lang: input.lang,
    title: title || null,
  };
}

export interface PlanContext {
  now: number;
  station: string | null;
  user: string | null;
  /** The member's switch (off: every activity ends at once). */
  switchOn: boolean;
  /** New activities may start: the switch, the OS, a push registration on this station, Bots. */
  canStart: boolean;
  /** `tasks` is the member's whole list (the member-wide endpoint), not only some conversations. */
  complete: boolean;
  /** Runs this phone has already shown. */
  shown: ReadonlySet<string>;
}

export type Action =
  | { kind: 'start'; task: BotTaskView; session: string; state: TaskActivityState; staleAt: number; relevance: number }
  | { kind: 'update'; id: string; state: TaskActivityState; staleAt: number }
  | { kind: 'end'; id: string; state: TaskActivityState | null; dismissAt: number };

/**
 * The member's tasks (`null` = they could not be listed) + the activities on the phone → what
 * to do. Starts never repeat a run the phone has shown; ends name the final state.
 */
export function planActivities(input: {
  tasks: readonly BotTaskView[] | null;
  activities: readonly ActivityInfo[];
  ctx: PlanContext;
  parseMs: ParseMs;
}): Action[] {
  const { tasks, activities, ctx, parseMs } = input;
  const actions: Action[] = [];
  const byRun = new Map((tasks ?? []).map((task) => [task.run_id, task]));
  const onPhone = new Set(activities.map((activity) => activity.run));

  for (const activity of activities) {
    // signed out, another station or account, the switch off: off the lock screen now
    if (!ctx.switchOn || activity.station !== ctx.station || activity.user !== ctx.user) {
      actions.push({ kind: 'end', id: activity.id, state: null, dismissAt: 0 });
      continue;
    }
    if (activity.ended || tasks === null) continue;
    const task = byRun.get(activity.run);
    if (!task) {
      // gone from the whole list: it ended long ago (or was removed) — nothing left to say
      if (ctx.complete) actions.push({ kind: 'end', id: activity.id, state: null, dismissAt: 0 });
      continue;
    }
    const state = contentFor(task, ctx.now, parseMs);
    if (!isActiveTask(task)) {
      actions.push({ kind: 'end', id: activity.id, state, dismissAt: dismissAt(state.endedAt, ctx.now) });
    } else if (state.status !== activity.status || state.startedAt !== activity.startedAt) {
      actions.push({ kind: 'update', id: activity.id, state, staleAt: staleAt(state) });
    }
  }

  if (ctx.canStart && ctx.switchOn && ctx.station && ctx.user && tasks) {
    for (const task of tasks) {
      if (!isActiveTask(task) || onPhone.has(task.run_id) || ctx.shown.has(task.run_id)) continue;
      const session = task.conversation_id;
      if (!session) continue;
      const state = contentFor(task, ctx.now, parseMs);
      actions.push({
        kind: 'start',
        task,
        session,
        state,
        staleAt: staleAt(state),
        // the newest task leads the Dynamic Island
        relevance: state.startedAt,
      });
    }
  }
  return actions;
}

/** Remembered runs (`{run: shown at ms}`) without the ones older than a day. */
export function pruneShown(shown: Record<string, number>, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [run, at] of Object.entries(shown)) {
    if (typeof at === 'number' && now - at < SHOWN_KEEP_MS) out[run] = at;
  }
  return out;
}

// ─── Faces ───────────────────────────────────────────────

/**
 * The faces an activity shows, as App Group files `<art>L` / `<art>D` (52 pt, light / dark)
 * and `<art>M` (36 pt, dark — the island is always black). The resting (`idle`) face only:
 * the end states put an SF Symbol on it, and nothing can be drawn when a push ends one in
 * the background. `art` is the light face's key, so a Bot is drawn once.
 */
export function activityArt(source: AvatarSource | null): { art: string; jobs: ArtJob[] } {
  const { plant, tint } = source
    ? resolvePlantAvatar(source.avatar, { templateKey: source.template_key, stableId: source.id })
    : { plant: 'sprout' as const, tint: undefined };
  const face = (theme: 'light' | 'dark') =>
    forSvgXml(buildPlantAvatarSvg({ plant, tint, state: 'idle', theme, size: 44 }));
  const light = face('light');
  const dark = face('dark');
  const art = artKey(light);
  return {
    art,
    jobs: [
      { key: `${art}L`, svg: light, points: ART_LARGE_POINTS },
      { key: `${art}D`, svg: dark, points: ART_LARGE_POINTS },
      { key: `${art}M`, svg: dark, points: ART_SMALL_POINTS },
    ],
  };
}

// ─── Diagnostics ─────────────────────────────────────────

export interface BackgroundEndTally {
  /** Task pushes the background end saw. */
  total: number;
  /** …that ended an activity (or found it already ended). */
  ended: number;
  /** …that found no activity (dismissed, never started on this phone). */
  notFound: number;
}

/** The background end's log (LiveActivities.swift `ActivityLog`, JSON) → counts for the dogfood. */
export function tallyBackgroundEnds(json: string): BackgroundEndTally {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = [];
  }
  const rows = Array.isArray(parsed) ? (parsed as Array<{ outcome?: unknown }>) : [];
  let ended = 0;
  let notFound = 0;
  for (const row of rows) {
    if (row?.outcome === 'ended' || row?.outcome === 'already_ended') ended += 1;
    else if (row?.outcome === 'not_found') notFound += 1;
  }
  return { total: rows.length, ended, notFound };
}
