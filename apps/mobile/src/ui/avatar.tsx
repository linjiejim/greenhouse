/**
 * Faces. People keep their initial in a circle, so a person is never mistaken for an agent;
 * agents are plants (./plant-avatar):
 *
 *  - `Avatar` — a member's initial (accounts, assignees, comment authors).
 *  - `AssistantAvatar` — the assistant's sprout; its face follows the conversation
 *    (`state`: thinking, speaking, waiting, done, error, hello …).
 *  - `AgentAvatar` — an agent the member connected (./plant-avatar/agent-plant.ts).
 *
 * Decorative: the name is always printed next to them.
 */

import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { useTheme, weight } from '../theme';
import { agentPlant } from './plant-avatar/agent-plant';
import { PlantAvatar } from './plant-avatar/plant-avatar';
import type { PlantStateInput } from './plant-avatar/plant-ids';

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const { colors: c } = useTheme();
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: c.accentFill,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* sized with the circle: at large text sizes the letter shrinks to fit its disc */}
      <Text numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: 'Nunito', fontSize: Math.round(size * 0.44), fontWeight: weight.bold, color: c.accentText }}>
        {letter}
      </Text>
    </View>
  );
}

export function AssistantAvatar({
  size,
  state = 'idle',
  animate,
}: {
  size: number;
  state?: PlantStateInput;
  animate?: boolean;
}) {
  return <PlantAvatar plant="sprout" state={state} size={size} animate={animate} seed="assistant" />;
}

export function AgentAvatar({
  kind,
  name,
  avatar,
  size,
  state,
}: {
  kind: string;
  name: string;
  avatar?: { plant?: string; tint?: string } | null;
  size: number;
  state?: PlantStateInput;
}) {
  const resolved = useMemo(() => agentPlant(kind, name, avatar), [kind, name, avatar]);
  return <PlantAvatar plant={resolved.plant} tint={resolved.tint} state={state} size={size} animate={false} seed={resolved.seed} />;
}
