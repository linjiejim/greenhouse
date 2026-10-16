/** Static lists use the unchanged SVG builder. Living plants run V2 entirely on the UI thread. */
import React, { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, AppState, View } from 'react-native';
import Animated, {
  runOnUI,
  useAnimatedProps,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, G, Path, SvgXml } from 'react-native-svg';
import { useTheme } from '../../theme';
import { forSvgXml } from './plant-avatar-native';
import { buildPlantAvatarSvg, FIT_TARGET, lodFor, plantPalette, poseFor } from './plant-avatar-svg';
import { PLANT_LOD_CODES, PLANT_PRESETS, type PlantLayer } from './plant-catalogue';
import { PLANT_FIT } from './plant-fit.generated';
import { DEFAULT_PLANT, isPlantId, type PlantId, type PlantStateInput } from './plant-ids';
import {
  advanceMotion,
  createMotion,
  sampleMotion,
  setMotionReduced,
  setMotionState,
  spring,
  type Pose,
  type State,
} from './plant-motion';
import { facePaths, layerGoal, layerMatrix, MOTION_ORGANS, poseMatrix, type MotionLayer } from './plant-motion-shapes';

const AnimatedG = Animated.createAnimatedComponent(G<{ matrix?: number[] }>);
const AnimatedPath = Animated.createAnimatedComponent(Path);
export interface PlantAvatarProps {
  plant?: PlantId;
  state?: PlantStateInput;
  size?: number;
  tint?: string;
  disc?: boolean;
  /** Lists pass false; live states, greetings and hero sizes otherwise animate. */
  animate?: boolean;
  seed?: string;
  label?: string;
}
export function PlantAvatar({
  plant: input,
  state = 'idle',
  size = 32,
  tint,
  disc = true,
  animate,
  seed,
  label,
}: PlantAvatarProps) {
  const plant = isPlantId(input) ? input : DEFAULT_PLANT;
  const { isDark } = useTheme();
  const theme = isDark ? 'dark' : 'light';
  const canonical = poseFor(state).state;
  const moving =
    animate ?? (['thinking', 'speaking', 'waiting', 'done', 'error', 'hello'].includes(canonical) || size >= 80);
  const xml = useMemo(
    () => (moving ? '' : forSvgXml(buildPlantAvatarSvg({ plant, state, size, theme, tint, disc }))),
    [plant, state, size, theme, tint, disc, moving],
  );
  const a11y = label
    ? ({ accessible: true, role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);
  return (
    <View style={{ width: size, height: size }} {...a11y}>
      {moving ? (
        <LivingPlant
          key={`${plant}:${size}:${seed ?? ''}`}
          plant={plant}
          state={canonical}
          size={size}
          tint={tint}
          disc={disc}
          theme={theme}
          seed={seed}
        />
      ) : (
        <SvgXml xml={xml} width={size} height={size} />
      )}
    </View>
  );
}
function LivingPlant({
  plant,
  state,
  size,
  tint,
  disc,
  theme,
  seed,
}: {
  plant: PlantId;
  state: State;
  size: number;
  tint?: string;
  disc: boolean;
  theme: 'light' | 'dark';
  seed?: string;
}) {
  const initialReduced = useReducedMotion();
  const [reduced, setReduced] = useState(initialReduced);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (value) => setForeground(value === 'active'));
    const accessibility = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    return () => {
      mounted = false;
      subscription.remove();
      accessibility.remove();
    };
  }, []);
  const preset = PLANT_PRESETS[plant],
    lod = lodFor(size),
    palette = plantPalette(plant, state, tint)[theme];
  const layers = useMemo(
    () =>
      preset.layers
        .map((layer, index) => ({ layer, index }))
        .filter(({ layer }) => layer.lods.includes(PLANT_LOD_CODES[lod])),
    [preset, lod],
  );
  const [initial] = useState(() => createMotion(plant, { state, seed }));
  const model = useSharedValue(initial);
  const pose = useSharedValue(sampleMotion(initial));
  const angles = useSharedValue(layers.map(() => [0, 0] as [number, number]));
  const descriptors = useMemo(
    () =>
      layers.map(({ layer, index }) => ({
        index,
        tone: layer.tone,
        part: layer.part,
        at: layer.part ? preset.parts?.[layer.part].at : undefined,
        organ: MOTION_ORGANS[plant]?.[index] ?? undefined,
      })),
    [layers, plant, preset],
  );
  useEffect(() => {
    runOnUI(() => {
      'worklet';
      model.modify((m) => {
        setMotionReduced(m, reduced);
        setMotionState(m, state);
        if (state === 'hello' && m.time === 0) m.age = 0;
        return m;
      });
      pose.value = sampleMotion(model.value);
      if (reduced) angles.value = layers.map(() => [0, 0]);
    })();
  }, [model, pose, angles, state, reduced, layers]);
  const frame = useFrameCallback((info) => {
    'worklet';
    const dt = info.timeSincePreviousFrame === null ? 0 : Math.min(info.timeSincePreviousFrame / 1000, 0.05);
    model.modify((m) => {
      pose.value = advanceMotion(m, dt);
      return m;
    });
    const c = pose.value;
    angles.modify((values) => {
      for (let i = 0; i < values.length; i++) {
        const goal = layerGoal(plant, descriptors[i]!, c, model.value.state);
        values[i] = spring(...values[i]!, goal.angle, goal.frequency, dt);
      }
      return values;
    });
  }, false);
  useEffect(() => {
    frame.setActive(foreground && !reduced);
    return () => frame.setActive(false);
  }, [frame, foreground, reduced]);
  const body = useAnimatedProps(() => ({ matrix: poseMatrix(pose.value, preset.pivot) }));
  const face = useAnimatedProps(() => ({ matrix: [1, 0, 0, 1, pose.value.gazeX, pose.value.gazeY] }));
  const [radius, dx, dy] = PLANT_FIT[plant][lod],
    scale = Math.min(1.3, FIT_TARGET[lod] / radius);
  // Match the static builder's fit rounding exactly.
  const fit = `translate(50 50) scale(${Math.round(scale * 1000) / 1000}) translate(${Math.round((dx - 50) * 10) / 10} ${Math.round((dy - 50) * 10) / 10})`;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {disc && <Circle cx={50} cy={50} r={50} fill={palette.disc} />}
      <G transform={fit}>
        <AnimatedG animatedProps={body}>
          {layers.map(({ layer, index }, i) => (
            <MovingLayer
              key={index}
              plant={plant}
              layer={layer}
              descriptor={descriptors[i]!}
              index={i}
              pose={pose}
              angles={angles}
              state={state}
              ink={palette[layer.tone]}
              reduced={reduced}
              glyph={lod === 'glyph'}
            />
          ))}
          <AnimatedG animatedProps={face}>
            <FacePath kind="eye" index={0} pose={pose} plant={plant} size={size} ink={palette.ink} />
            <FacePath kind="eye" index={1} pose={pose} plant={plant} size={size} ink={palette.ink} />
            {lod === 'portrait' &&
              [0, 1].map((index) => (
                <FacePath
                  key={index}
                  kind="brow"
                  index={index}
                  pose={pose}
                  plant={plant}
                  size={size}
                  ink={palette.ink}
                />
              ))}
            {lod !== 'glyph' && (
              <FacePath kind="mouth" index={0} pose={pose} plant={plant} size={size} ink={palette.ink} />
            )}
          </AnimatedG>
        </AnimatedG>
      </G>
    </Svg>
  );
}
function MovingLayer({
  plant,
  layer,
  descriptor,
  index,
  pose,
  angles,
  state,
  ink,
  reduced,
  glyph,
}: {
  plant: PlantId;
  layer: PlantLayer;
  descriptor: MotionLayer;
  index: number;
  pose: SharedValue<Pose>;
  angles: SharedValue<[number, number][]>;
  state: State;
  ink: string;
  reduced: boolean;
  glyph: boolean;
}) {
  const props = useAnimatedProps(() => {
    const goal = layerGoal(plant, descriptor, pose.value, state);
    return { matrix: layerMatrix(goal.pivot, angles.value[index]![0], reduced ? 1 : goal.scale) };
  });
  return (
    <AnimatedG animatedProps={props}>
      <Path
        d={layer.d}
        fill={layer.stroke ? 'none' : ink}
        stroke={layer.stroke ? ink : undefined}
        strokeWidth={layer.stroke ? (glyph ? layer.stroke * 1.15 : layer.stroke) : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={layer.op}
      />
    </AnimatedG>
  );
}
function FacePath({
  kind,
  index,
  pose,
  plant,
  size,
  ink,
}: {
  kind: 'eye' | 'mouth' | 'brow';
  index: number;
  pose: SharedValue<Pose>;
  plant: PlantId;
  size: number;
  ink: string;
}) {
  const metrics = PLANT_PRESETS[plant].face;
  const props = useAnimatedProps(() => {
    const paths = facePaths(pose.value, metrics, size);
    return {
      d: kind === 'mouth' ? paths.mouth : kind === 'eye' ? paths.eyes[index] : paths.brows[index],
      opacity: kind === 'brow' ? pose.value.brow : 1,
    };
  });
  return (
    <AnimatedPath
      animatedProps={props}
      fill={kind === 'brow' ? 'none' : ink}
      stroke={kind === 'brow' ? ink : undefined}
      strokeWidth={1.1}
      strokeLinecap="round"
    />
  );
}
