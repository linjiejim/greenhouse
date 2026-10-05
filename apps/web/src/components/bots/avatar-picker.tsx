/**
 * Bot look: one of fifteen plants plus a resting mood — the two choices that
 * tell Bots apart at 24px in a conversation list (plant-avatar spec §10.7).
 * A Bot should take ten seconds to dress, not ten minutes.
 *
 * Writes `plant` (+ its nearest legacy colour) and the mood as `faceStyle`
 * through `withPlant` / `withMood`, keeping every other stored key.
 */

import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import { legacyToMood, legacyToPlant, withMood, withPlant } from '@greenhouse/types';
import { useT } from '../../lib/i18n';

import { PlantPicker } from '../plant-picker';

export function AvatarPicker({
  value,
  onChange,
  templateKey,
  stableId,
  animate,
}: {
  value: AvatarConfig;
  onChange: (next: AvatarConfig) => void;
  /** Resolve a legacy avatar exactly as the Bot renders elsewhere (template plant, id-seeded fallback). */
  templateKey?: string | null;
  stableId?: string;
  /**
   * The 80px preview. Default: a hero, so it plays its capped idle. Pass false
   * inside a transcript (the in-chat "new Bot" card), where motion is reserved
   * for the Bot that is speaking.
   */
  animate?: boolean;
}) {
  const t = useT();
  const plant = legacyToPlant(value, templateKey, stableId);
  const mood = legacyToMood(value);

  return (
    <div className="flex gap-4" data-testid="bots-avatar-picker">
      <div className="flex w-20 flex-shrink-0 flex-col items-center gap-1.5 pt-1">
        <PlantAvatar plant={plant} avatar={value} stableId={stableId} size="lg" animate={animate} />
        <span className="w-full truncate text-center text-[10px] text-fg-muted" data-testid="bots-avatar-caption">
          {t(`plantAvatar.name.${plant}`)} · {t(`plantAvatar.mood.${mood}`)}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <PlantPicker
          plant={plant}
          mood={mood}
          onPlantChange={(next) => onChange(withPlant(value, next))}
          onMoodChange={(next) => onChange(withMood(value, next))}
        />
      </div>
    </div>
  );
}
