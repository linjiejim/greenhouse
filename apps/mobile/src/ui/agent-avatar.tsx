/**
 * Faces: an Agent's plant, a person's picture or initial.
 *
 * `AgentAvatar` resolves the stored avatar to a plant exactly as the web does
 * (`resolvePlantAvatar(avatar, { templateKey, stableId: id })`), so an Agent shows the same
 * species and colour everywhere. Its face follows `state`; live work and greetings move
 * (AGNT-04), while directory and list callers explicitly pass animate=false. `agent` null = not loaded yet → a neutral disc. Decorative: the name is always
 * printed next to it.
 *
 * `MemberAvatar`: the member's picture (a signed URL resolved against the station), else the
 * first letter of their name.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { fileUrl } from '../api/files';
import type { Agent } from '../shared/contract';
import { useTheme } from '../theme';
import { useStream } from '../data/use-stream';
import { usePlantWorkState } from './plant-avatar/use-plant-work';
import { InitialAvatar } from './avatar';
import { PlantAvatar } from './plant-avatar/plant-avatar';
import { resolvePlantAvatar, type PlantStateInput } from './plant-avatar/plant-ids';

export type AgentFace = Pick<Agent, 'id' | 'avatar' | 'template_key'>;

export function AgentAvatar({
  agent,
  size,
  state,
  animate,
}: {
  agent: AgentFace | null | undefined;
  size: number;
  /** thinking (answering) | waiting (needs you) | sleep (archived) … */
  state?: PlantStateInput;
  /** Play the state's V2 motion; list callers pass false. */
  animate?: boolean;
}) {
  const { colors: c } = useTheme();
  const avatar = agent?.avatar;
  const templateKey = agent?.template_key;
  const id = agent?.id;
  const resolved = useMemo(
    () => (id === undefined ? null : resolvePlantAvatar(avatar, { templateKey, stableId: id })),
    [avatar, templateKey, id],
  );
  if (!resolved) {
    return (
      <View
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.tertiaryFill }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    );
  }
  return (
    <PlantAvatar
      plant={resolved.plant}
      tint={resolved.tint}
      state={state}
      size={size}
      animate={animate ?? (size >= 80 || (state !== undefined && state !== 'idle'))}
      seed={id}
    />
  );
}

export function MemberAvatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  if (!url) return <InitialAvatar name={name} size={size} />;
  return (
    <Image
      source={{ uri: fileUrl(url) }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      contentFit="cover"
      accessibilityIgnoresInvertColors
      accessible={false}
    />
  );
}

export function WorkingAgentAvatar({
  agent,
  size,
  working,
  waiting,
  reply,
  sleeping,
  greeting = true,
}: {
  agent: AgentFace | null;
  size: number;
  working?: boolean;
  waiting?: boolean;
  reply?: { id: string; content: string; status: string };
  sleeping?: boolean;
  greeting?: boolean;
}) {
  const stream = useStream(reply?.id ?? '');
  const state = usePlantWorkState({
    working,
    streaming: reply?.status === 'streaming',
    hasText: !!(stream?.text || reply?.content),
    toolRunning: stream?.steps.some((step) => step.status === 'running'),
    waiting,
    failed: reply?.status === 'failed',
    sleeping,
    greeting,
  });
  return <AgentAvatar agent={agent} size={size} state={state} animate={sleeping ? false : undefined} />;
}
