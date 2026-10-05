/**
 * <PlantAvatar/> and <PlantAvatarStack/> — the React wrapper around the SVG builder.
 *
 * - theme 'auto': one markup string, the injected CSS switches the palette under
 *   `.dark-theme`, so a theme toggle never re-renders;
 * - the string is memoised on identity / size / LOD / animate only; a state change on an
 *   animated avatar morphs the mounted <svg> in place (useLayoutEffect) instead of
 *   re-rendering it, so poses transition and the eyes swap behind a blink;
 * - motion pauses while the avatar is offscreen (IntersectionObserver) or the tab is
 *   hidden (visibilitychange);
 * - accessible name: `label` (the full localised name, supplied by the caller) →
 *   role="img"; without it the avatar is decorative (aria-hidden), for rows that already
 *   print the name.
 *
 * Animation budget (spec §6): lists pass `animate={false}`; by default only live states
 * (thinking / speaking / waiting / done / error), `intro` and hero sizes (≥ 80px) move.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  legacyToMood,
  resolvePlantAvatar,
  type AvatarConfig,
  type PlantId,
  type PlantState,
  type PlantStateInput,
} from '@greenhouse/types';
import type { ProfileAvatar } from '@greenhouse/types/api';
import { buildPlantAvatarSvg, ensurePlantAvatarStyles, poseFor } from './plant-avatar-svg';
import { morphPlantAvatar } from './plant-morph';

export const PLANT_AVATAR_SIZES = Object.freeze({ xs: 24, sm: 32, md: 48, lg: 80, xl: 120 } as const);
export type PlantAvatarSize = keyof typeof PLANT_AVATAR_SIZES | number;

/** States that animate by default (live work + one-shot transitions). */
const LIVE_STATES: ReadonlySet<PlantState> = new Set(['thinking', 'speaking', 'waiting', 'done', 'error']);
/** At and above this size an avatar is a hero and may play its capped ambient idle. */
const HERO_PX = 80;

export const plantAvatarPx = (size: PlantAvatarSize): number =>
  typeof size === 'number' ? size : PLANT_AVATAR_SIZES[size];

export interface PlantAvatarProps {
  /** Explicit species — wins over `avatar`. */
  plant?: PlantId;
  /** Stored avatar JSON (new `plant` or legacy Sprouty keys); resolved with `templateKey` + `stableId`. */
  avatar?: AvatarConfig | ProfileAvatar | null;
  templateKey?: string | null;
  /** Stable id (`bot_…`, `custom:…`, system profile id): legacy fallback + loop phase. */
  stableId?: string;
  state?: PlantStateInput;
  /** Preset (xs 24 / sm 32 / md 48 / lg 80 / xl 120) or px. Default 'sm'. */
  size?: PlantAvatarSize;
  /** Force the glyph LOD at ≤ 24px (stacks, dense rows): bigger eyes, no detail. */
  compact?: boolean;
  /** Default: live states, `intro`, or size ≥ 80px. Lists pass false. */
  animate?: boolean;
  /** Play the one-shot unfurl entrance (a new Bot). */
  intro?: boolean;
  /** Full localised accessible name; omit when the row already prints the name. */
  label?: string;
  className?: string;
}

export function PlantAvatar({
  plant,
  avatar,
  templateKey,
  stableId,
  state = 'idle',
  size = 'sm',
  compact = false,
  animate,
  intro = false,
  label,
  className = '',
}: PlantAvatarProps) {
  const px = plantAvatarPx(size);
  const poseState = poseFor(state).state;
  const animated = animate ?? (LIVE_STATES.has(poseState) || intro || px >= HERO_PX);
  const lod = compact && px <= 24 ? ('glyph' as const) : undefined;

  // Avatar objects are recreated by callers on every render — key on their content.
  const avatarKey = avatar ? JSON.stringify(avatar) : '';
  const resolved = useMemo(
    () =>
      plant
        ? { plant, mood: legacyToMood(avatar), seed: stableId }
        : resolvePlantAvatar(avatar, { templateKey, stableId }),
    [plant, avatarKey, templateKey, stableId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The markup is NOT rebuilt when an animated avatar changes state: the layout effect below
  // morphs the mounted <svg> instead (rebuilding would restart every animation and skip the
  // transition). Static avatars rebuild — that is just a different string.
  const html = useMemo(
    () =>
      buildPlantAvatarSvg({
        plant: resolved.plant,
        mood: resolved.mood,
        seed: resolved.seed,
        state: poseState,
        size: px,
        lod,
        theme: 'auto',
        animate: animated,
        intro,
      }),
    [resolved, px, lod, animated, intro, animated ? null : poseState], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Stable object identity: React 19 re-assigns innerHTML whenever the prop object changes,
  // which would undo an in-place morph on every parent re-render.
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  const hostRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    ensurePlantAvatarStyles();
  }, []);

  useLayoutEffect(() => {
    if (!animated) return;
    const svg = hostRef.current?.firstElementChild;
    if (!svg || svg.getAttribute('data-state') === poseState) return;
    morphPlantAvatar(svg, {
      plant: resolved.plant,
      mood: resolved.mood,
      seed: resolved.seed,
      state: poseState,
      size: px,
      lod,
      theme: 'auto',
      intro,
    });
  }, [poseState, animated, resolved, px, lod, intro]);

  const paused = usePausedWhenUnseen(hostRef, animated);

  return (
    <span
      ref={hostRef}
      className={`pa-root${paused ? ' pa-paused' : ''}${className ? ` ${className}` : ''}`}
      style={{ display: 'inline-block', flex: 'none', width: px, height: px, lineHeight: 0, verticalAlign: 'middle' }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      // Self-generated SVG (no user input reaches the markup: the label is set on this span).
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}

/** True while the element is offscreen or the tab is hidden (only observed when animated). */
function usePausedWhenUnseen(ref: React.RefObject<HTMLElement | null>, active: boolean): boolean {
  const [offscreen, setOffscreen] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOffscreen(!entry.isIntersecting);
      });
      io.observe(el);
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      io?.disconnect();
      setOffscreen(false);
      setHidden(false);
    };
  }, [ref, active]);
  return active && (offscreen || hidden);
}

// ─── stack ──────────────────────────────────────────────────────────────────

export interface PlantAvatarStackItem {
  /** Stable id (`bot_…`): React key, legacy fallback and loop phase. */
  id: string;
  plant?: PlantId;
  avatar?: AvatarConfig | ProfileAvatar | null;
  templateKey?: string | null;
  /** Tooltip (the stack is decorative; the row prints the names). */
  name?: string;
}

export interface PlantAvatarStackProps {
  items: readonly PlantAvatarStackItem[];
  /** Chips shown before the +N chip. Default 3. */
  max?: number;
  /** Default 'xs' (24px). */
  size?: PlantAvatarSize;
  /**
   * The Bot talking right now: moved first (never covered) and the only one that animates.
   * When it stops it keeps the first slot for PLANT_SETTLE_MS while it morphs back to idle.
   */
  speakingId?: string | null;
  className?: string;
  /**
   * Ring colour class separating overlapped chips — match the surface the stack
   * sits on (default `ring-surface-raised`; e.g. an active sidebar row's tint).
   */
  ringClassName?: string;
}

/**
 * Overlapping roster for group rows and headers: −6px overlap at 24px (scaled with size),
 * compact glyph LOD, first chip on top, and a +N chip sized from the avatar size.
 */
/** How long an avatar keeps animating after its live state ends, so it morphs back instead of snapping. */
export const PLANT_SETTLE_MS = 700;

/**
 * True while `active`, and for `ms` after it turns off. Derived during render,
 * not in an effect: the render where the state ends must already keep the
 * avatar animated, or it would rebuild as the static string instead of morphing.
 */
export function usePlantSettling(active: boolean, ms = PLANT_SETTLE_MS): boolean {
  const [previous, setPrevious] = useState(active);
  const [settling, setSettling] = useState(false);
  if (previous !== active) {
    setPrevious(active);
    setSettling(!active);
  }
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), ms);
    return () => clearTimeout(timer);
  }, [settling, ms]);
  return active || settling;
}

/** The id that just stopped being `current`, for `ms` (null otherwise) — same render-time rule as usePlantSettling. */
function useLingeringId(current: string | null | undefined, ms = PLANT_SETTLE_MS): string | null {
  const [previous, setPrevious] = useState(current ?? null);
  const [lingering, setLingering] = useState<string | null>(null);
  if (previous !== (current ?? null)) {
    setLingering(previous);
    setPrevious(current ?? null);
  }
  useEffect(() => {
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(null), ms);
    return () => clearTimeout(timer);
  }, [lingering, ms]);
  return lingering;
}

export function PlantAvatarStack({
  items,
  max = 3,
  size = 'xs',
  speakingId,
  className = '',
  ringClassName = 'ring-surface-raised',
}: PlantAvatarStackProps) {
  const px = plantAvatarPx(size);
  // The Bot that just finished speaking keeps animating briefly, so it morphs
  // back to idle (spec §6.2) instead of snapping to the static string.
  const settlingId = useLingeringId(speakingId);
  const overlap = Math.round(px / 4);
  // The settling Bot keeps the lead slot until it has morphed back: moving its chip would make
  // React re-insert the node mid-transition, and a re-inserted node snaps instead of morphing.
  const leadId = speakingId ?? settlingId;
  const ordered = leadId
    ? [...items.filter((item) => item.id === leadId), ...items.filter((item) => item.id !== leadId)]
    : items;
  const shown = ordered.slice(0, Math.max(1, max));
  const rest = ordered.length - shown.length;
  return (
    <span
      className={`flex flex-shrink-0 items-center${className ? ` ${className}` : ''}`}
      style={{ isolation: 'isolate' }}
      data-testid="plant-avatar-stack"
    >
      {shown.map((item, index) => {
        const speaking = item.id === speakingId;
        return (
          <span
            key={item.id}
            title={item.name}
            className={`relative inline-flex rounded-full bg-surface-raised ring-2 ${ringClassName}`}
            style={{ zIndex: shown.length - index, marginLeft: index > 0 ? -overlap : undefined }}
          >
            <PlantAvatar
              plant={item.plant}
              avatar={item.avatar}
              templateKey={item.templateKey}
              stableId={item.id}
              state={speaking ? 'speaking' : 'idle'}
              size={px}
              compact
              animate={speaking || item.id === settlingId}
            />
          </span>
        );
      })}
      {rest > 0 && (
        <span
          className={`relative inline-flex items-center justify-center rounded-full bg-surface-muted font-semibold text-fg-muted ring-2 ${ringClassName}`}
          style={{
            height: px,
            minWidth: px,
            marginLeft: -overlap,
            paddingInline: Math.round(px / 6),
            fontSize: Math.max(9, Math.round(px * 0.4)),
          }}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}
