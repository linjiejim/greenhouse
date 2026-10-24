/**
 * AssistantPresence — the one assistant avatar in a conversation, at the foot of the
 * transcript, following what the turn is doing (spec B10):
 *
 * - streaming with a tool running, or nothing written yet → thinking
 * - streaming text → speaking
 * - the last answer waits on the user (an unanswered ask_user form) → waiting
 * - the turn failed → error
 * - a turn observed finishing → done (one-shot, ~1.4s), then the row goes away
 *
 * Idle renders nothing, so history never shows a stray avatar. Loading a finished
 * conversation never replays `done` (usePlantWorkState only fires on an observed edge).
 */

import { PlantAvatar, usePlantWorkState, type PlantWork } from '@greenhouse/ui/components/plant-avatar';
import type { ProfileAvatar } from '@greenhouse/types';
import { useT } from '../../lib/i18n';

export interface AssistantPresenceProps {
  avatar: ProfileAvatar | null;
  stableId: string;
  work: PlantWork;
  /** Show the "Thinking…" caption — only while the streaming bubble has nothing to show yet. */
  showThinkingLabel?: boolean;
}

export function AssistantPresence({ avatar, stableId, work, showThinkingLabel = false }: AssistantPresenceProps) {
  const t = useT();
  const state = usePlantWorkState(work);
  if (state === 'idle') return null;
  return (
    <div className="flex items-center gap-2 py-1" data-testid="assistant-presence" data-state={state}>
      <PlantAvatar avatar={avatar} stableId={stableId} state={state} size="xs" />
      {showThinkingLabel && state === 'thinking' && (
        <span className="text-xs text-fg-faint animate-pulse">{t('chat.thinking')}</span>
      )}
    </div>
  );
}
