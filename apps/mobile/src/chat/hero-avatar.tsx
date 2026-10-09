/**
 * The new-chat hero's plant (app/(drawer)/(main)/index.tsx) — it answers a
 * touch: a tap waves hello (a hop, a light tick), three quick taps make it
 * glad (a perk, a success tap); then it settles back to its idle float. Each
 * tap restarts the one-shot. A small delight, so it stays out of VoiceOver's
 * way (the greeting under it says who is there). Reduced motion keeps the
 * faces and drops the movement (PlantAvatar's veto).
 *
 * The member's Sprouty when we know it (its plant and colour), otherwise the
 * default sprout.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable } from 'react-native';
import { BotAvatar, type AvatarSource } from '../bots/ui/bot-avatar';
import { notifySuccess, selectionTick } from '../ui/haptics';
import { PlantAvatar, type PlantState } from '../ui/plant-avatar';

/** Taps this close together count towards "glad". */
const TAP_WINDOW_MS = 1200;
const GLAD_TAPS = 3;
/** How long a reaction shows before the plant settles. */
const REACTION_MS = 1500;

export function HeroAvatar({ bot, size, animate }: { bot: AvatarSource | null; size: number; animate: boolean }) {
  const [reaction, setReaction] = useState<{ state: PlantState; n: number } | null>(null);
  const taps = useRef<number[]>([]);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  const react = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((at) => now - at < TAP_WINDOW_MS), now];
    const glad = taps.current.length >= GLAD_TAPS;
    if (glad) {
      taps.current = [];
      notifySuccess();
    } else {
      selectionTick();
    }
    setReaction((current) => ({ state: glad ? 'done' : 'hello', n: (current?.n ?? 0) + 1 }));
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => setReaction(null), REACTION_MS);
  };

  const state = reaction?.state;
  return (
    <Pressable onPress={react} hitSlop={12} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* keyed on the tap: every tap replays the one-shot from its start */}
      {bot ? (
        <BotAvatar key={reaction?.n ?? 0} bot={bot} size={size} state={state} animate={animate} />
      ) : (
        <PlantAvatar key={reaction?.n ?? 0} size={size} state={state} animate={animate} />
      )}
    </Pressable>
  );
}
