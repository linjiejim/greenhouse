/**
 * PlantAvatar for React Native — the agent face (spec docs/specs/assets/avatar-proto/final/spec.md
 * §10.8): one flat geometric plant + a small ink face on a tinted disc, rendered from the vendored static
 * builder through SvgXml. The face follows the state, never a setting: thinking looks up to one
 * side, speaking focuses, waiting leans in with expectant eyes, done smiles, error droops and looks
 * down, asleep closes its eyes. `tint` is the Bot's colour (its body and disc turned to a hue).
 *
 * Static (lists, reduced motion): one SvgXml string — a state change is just a new string.
 *
 * Moving (`motionFor`, ./plant-avatar-native.ts): the avatar is drawn in layers — the disc as the
 * wrapper's background, the plant body, and the face on its own on top (the builder's `layer`
 * option), all inside one Reanimated layer that carries the body's motion:
 *   - idle: a slow rise-and-settle every few seconds, then a rest in which nothing runs;
 *   - thinking: circumnutation (a slow elliptical nod) while the state lasts;
 *   - speaking: the three-beat stretch from the base, and a mouth that opens and closes;
 *   - waiting: three lean-ins, then it holds the pose;
 *   - done / error / hello: one perk / one droop (then a slow shake of the head) / one hop.
 * The face lives on its own: open-eyed states blink every few seconds (now and then twice), and at
 * rest or thinking the head turns aside for a moment (the face slides, the plant leans after it).
 * Blinks and mouth beats are frame swaps (an eyes-shut / mouth-shut copy of the face shown for a
 * beat), so between them nothing animates. Asleep holds still. Reduced motion → static, always.
 */

import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { SvgXml } from 'react-native-svg';
import { useTheme } from '../../theme';
import {
  BLINK_MS,
  FLOAT_RISE_MS,
  FLOAT_SETTLE_MS,
  LOD_AMP,
  blinksIn,
  faceShift,
  floatDelay,
  floatLift,
  floatRest,
  forSvgXml,
  glancesIn,
  lifeRandom,
  motionFor,
  motionSeed,
  mouthBeat,
  nextBlink,
  nextGlance,
  pivotOrigin,
  type PlantMotion,
} from './plant-avatar-native';
import { buildPlantAvatarSvg, lodFor, plantPalette, type PlantAvatarSvgOptions } from './plant-avatar-svg';
import { DEFAULT_PLANT, isPlantId, type PlantId, type PlantStateInput } from './plant-ids';

export interface PlantAvatarProps {
  /** Species; default the built-in Sprouty's 'sprout'. */
  plant?: PlantId;
  /** idle|thinking|speaking|done|error|waiting|sleep or a product alias; default idle. */
  state?: PlantStateInput;
  /** Render size in px (drives level of detail). Default 32. */
  size?: number;
  /** The Bot's colour (PLANT_TINTS; default / unknown = the species' own). */
  tint?: string;
  /** Tinted backing disc (default true). */
  disc?: boolean;
  /** Play the state's motion. Default: thinking, or idle at hero size (≥ 80px). Lists pass false. */
  animate?: boolean;
  /** A stable id (the Bot's) — offsets the idle float and the face's rhythm so a roster never moves in step. */
  seed?: string;
  /** Full localised accessible name; omit when adjacent text already says it (decorative). */
  label?: string;
}

/** Breath curve: cubic-bezier(.37,0,.63,1) — the float's rise and settle, the waiting lean. */
const BREATH = Easing.bezier(0.37, 0, 0.63, 1);
/** A gentle overshoot (spec §5: done's perk, the morph). */
const OVERSHOOT = Easing.bezier(0.3, 1.5, 0.6, 1);
/** Speaking: an irregular three-beat stretch over 1.6s, the last beat with a small lean. */
const TALK_MS = 1600;
const TALK_AT = [0, 0.12, 0.25, 0.42, 0.55, 0.72, 0.86, 1];
const TALK_K = [0, 1, 0, 0.55, 0, 1.25, 0, 0];
const TALK_LEAN = [0, 0, 0, 0, 0, -1, 0, 0];
/** Error's static pose leans 7°: the droop starts upright and falls into it. */
const DROOP_DEG = 7;
/** How far the plant leans after its face in a glance (degrees × the LOD amplitude). */
const TURN_DEG = 1.4;

export function PlantAvatar({
  plant: plantProp,
  state = 'idle',
  size = 32,
  tint,
  disc = true,
  animate,
  seed,
  label,
}: PlantAvatarProps) {
  const plant: PlantId = isPlantId(plantProp) ? plantProp : DEFAULT_PLANT;
  const { isDark } = useTheme();
  const theme = isDark ? 'dark' : 'light';
  const reduceMotion = useReducedMotion();
  const motion = reduceMotion ? null : motionFor(state, size, animate);
  const xml = useMemo(
    () => (motion ? '' : forSvgXml(buildPlantAvatarSvg({ plant, state, size, theme, tint, disc }))),
    [motion, plant, state, size, theme, tint, disc],
  );
  // RN's cross-platform ARIA props (iOS / Android / react-native-web alike).
  const a11y = label
    ? ({ accessible: true, role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);
  const box = { width: size, height: size, borderRadius: size / 2 };

  if (!motion) {
    return (
      <View style={box} {...a11y}>
        <SvgXml xml={xml} width={size} height={size} />
      </View>
    );
  }
  // Moving: the disc is the wrapper's background so only the plant moves.
  const discColor = disc ? plantPalette(plant, state, tint)[theme].disc : undefined;
  return (
    <View style={[box, { backgroundColor: discColor }]} {...a11y}>
      <LivingPlant
        key={motion}
        motion={motion}
        options={{ plant, state, size, theme, tint }}
        origin={pivotOrigin(plant, size)}
        seed={seed}
      />
    </View>
  );
}

/** The layered, moving avatar: body + face (+ an eyes-shut and a mouth-shut copy of the face for its beats). */
function LivingPlant({
  motion,
  options,
  origin,
  seed: seedId,
}: {
  motion: PlantMotion;
  options: Required<Pick<PlantAvatarSvgOptions, 'plant' | 'state' | 'size' | 'theme'>> & { tint?: string };
  origin: [number, number, number];
  seed?: string;
}) {
  const { plant, state, size, theme, tint } = options;
  const layers = useMemo(() => {
    const base = { plant, state, size, theme, tint, disc: false } as const;
    const build = (extra: Partial<PlantAvatarSvgOptions>) => forSvgXml(buildPlantAvatarSvg({ ...base, ...extra }));
    return {
      body: build({ layer: 'body' }),
      face: build({ layer: 'face' }),
      shut: blinksIn(motion) ? build({ layer: 'face', blink: true }) : null,
      closed: motion === 'talk' ? build({ layer: 'face', mouth: 'small' }) : null,
    };
  }, [plant, state, size, theme, tint, motion]);

  /** The body's motion phase: the float's rise (0–1), the nod's angle, the stretch's beat, a one-shot's progress. */
  const t = useSharedValue(motion === 'droop' ? 1 : 0); // the droop starts upright (keyed per motion)
  /** Which way this float bout leans (alternates). */
  const side = useSharedValue(1);
  /** The head turned aside (−1…1): the face slides, the plant leans after it. */
  const turn = useSharedValue(0);
  /** Eyes shut (a blink frame) and mouth shut (between talking beats): 0 / 1 swaps. */
  const shut = useSharedValue(0);
  const closed = useSharedValue(0);
  const amp = LOD_AMP[lodFor(size)];
  const unit = size / 100; // viewBox unit → px
  const lift = floatLift(size);
  const shift = faceShift(size);

  useEffect(() => {
    const seed = motionSeed(seedId);
    const rand = lifeRandom(seed);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, fn: () => void) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    // ── the body
    // One float bout, then a JS-timed rest: between bouts no animation runs at all.
    const float = (n: number) => {
      side.value = n % 2 === 0 ? 1 : -1;
      t.value = withSequence(
        withTiming(1, { duration: FLOAT_RISE_MS, easing: BREATH }),
        withTiming(0, { duration: FLOAT_SETTLE_MS, easing: BREATH }),
      );
      later(FLOAT_RISE_MS + FLOAT_SETTLE_MS + floatRest(seed, n), () => float(n + 1));
    };
    switch (motion) {
      case 'float':
        later(floatDelay(seed), () => float(0));
        break;
      case 'hop':
        t.value = withSequence(
          withTiming(1, { duration: 260, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 460, easing: OVERSHOOT }),
        );
        break;
      case 'nod':
        // one 3s ellipse = the web's two 1.5s alternating nods a quarter-phase apart
        t.value = withRepeat(withTiming(2 * Math.PI, { duration: 3000, easing: Easing.linear }), -1);
        break;
      case 'talk':
        t.value = withRepeat(withTiming(1, { duration: TALK_MS, easing: Easing.linear }), -1);
        break;
      case 'lean':
        t.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 1100, easing: BREATH }),
            withTiming(0, { duration: 1500, easing: BREATH }),
          ),
          3,
        );
        break;
      case 'perk':
        t.value = withSequence(
          withTiming(-1, { duration: 160, easing: Easing.out(Easing.quad) }),
          withTiming(1, { duration: 340, easing: OVERSHOOT }),
          withTiming(0, { duration: 300, easing: BREATH }),
        );
        break;
      case 'droop':
        t.value = withTiming(0, { duration: 1000, easing: Easing.bezier(0.35, 0.6, 0.4, 1) });
        // then a slow shake of the head: "that didn't work"
        later(1150, () => {
          turn.value = withSequence(
            withTiming(0.8, { duration: 220, easing: BREATH }),
            withTiming(-0.8, { duration: 380, easing: BREATH }),
            withTiming(0.45, { duration: 340, easing: BREATH }),
            withTiming(0, { duration: 300, easing: BREATH }),
          );
        });
        break;
    }

    // ── the face
    if (blinksIn(motion)) {
      const blink = () => {
        const { wait, double } = nextBlink(rand);
        later(wait, () => {
          shut.value = 1;
          later(BLINK_MS, () => {
            shut.value = 0;
            if (double)
              later(140, () => {
                shut.value = 1;
                later(BLINK_MS, () => (shut.value = 0));
              });
            blink();
          });
        });
      };
      blink();
    }
    if (glancesIn(motion)) {
      const glance = () => {
        const g = nextGlance(rand);
        later(g.wait, () => {
          turn.value = withTiming(g.side, { duration: 260, easing: BREATH });
          later(260 + g.hold, () => {
            turn.value = withTiming(0, { duration: 320, easing: BREATH });
            glance();
          });
        });
      };
      glance();
    }
    if (motion === 'talk') {
      const beat = () => {
        const b = mouthBeat(rand);
        later(b.open, () => {
          closed.value = 1;
          later(b.closed, () => {
            closed.value = 0;
            beat();
          });
        });
      };
      beat();
    }

    return () => {
      timers.forEach(clearTimeout);
      cancelAnimation(t);
      cancelAnimation(turn);
      shut.value = 0;
      closed.value = 0;
    };
  }, [motion, seedId, t, side, turn, shut, closed]);

  const bodyStyle = useAnimatedStyle(() => {
    const p = t.value;
    switch (motion) {
      case 'nod':
        return {
          transform: [
            { translateX: 1.3 * amp * unit * Math.sin(p) },
            { translateY: (-0.15 - 0.75 * Math.cos(p)) * amp * unit },
            { rotate: `${amp * Math.sin(p) + TURN_DEG * amp * turn.value}deg` },
          ],
        };
      case 'talk':
        return {
          transform: [
            { rotate: `${1.2 * amp * interpolate(p, TALK_AT, TALK_LEAN)}deg` },
            { scaleY: 1 + 0.03 * amp * interpolate(p, TALK_AT, TALK_K) },
          ],
        };
      case 'lean':
        return { transform: [{ rotate: `${-1.6 * amp * p}deg` }, { scaleY: 1 + 0.025 * p }] };
      case 'perk':
        return { transform: [{ scaleX: 1 - 0.015 * p }, { scaleY: 1 + 0.045 * p }] };
      case 'droop':
        return { transform: [{ rotate: `${-DROOP_DEG * p + TURN_DEG * amp * turn.value}deg` }] };
      case 'hop':
        return { transform: [{ translateY: -2.2 * lift * p }] };
      default:
        // float: rise, lean a little to one side, stretch a hair — and lean after a glance
        return {
          transform: [
            { translateY: -lift * p },
            { rotate: `${side.value * 1.1 * amp * p + TURN_DEG * amp * turn.value}deg` },
            { scaleY: 1 + 0.012 * p },
          ],
        };
    }
  });
  const faceStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shift * turn.value }] }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: origin }, bodyStyle]}>
      <SvgXml xml={layers.body} width={size} height={size} />
      <Animated.View style={[StyleSheet.absoluteFill, faceStyle]}>
        <FaceFrame xml={layers.face} size={size} shut={shut} closed={closed} frame="open" />
        {layers.shut ? <FaceFrame xml={layers.shut} size={size} shut={shut} closed={closed} frame="shut" /> : null}
        {layers.closed ? <FaceFrame xml={layers.closed} size={size} shut={shut} closed={closed} frame="closed" /> : null}
      </Animated.View>
    </Animated.View>
  );
}

/** One copy of the face, shown when it is the frame of the moment (open / eyes shut / mouth shut). */
function FaceFrame({
  xml,
  size,
  shut,
  closed,
  frame,
}: {
  xml: string;
  size: number;
  shut: SharedValue<number>;
  closed: SharedValue<number>;
  frame: 'open' | 'shut' | 'closed';
}) {
  const style = useAnimatedStyle(() => {
    const s = shut.value > 0.5;
    const c = closed.value > 0.5;
    const on = frame === 'shut' ? s : frame === 'closed' ? c && !s : !s && !c;
    return { opacity: on ? 1 : 0 };
  });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <SvgXml xml={xml} width={size} height={size} />
    </Animated.View>
  );
}
