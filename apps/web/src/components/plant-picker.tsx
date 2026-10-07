/**
 * PlantPicker — the species grid + resting mood shared by both avatar editors
 * (Bot AvatarPicker, Agent Appearance; plant-avatar spec §10.7).
 *
 * Fifteen species chips at 32px, static (a picker is a list: nothing moves), each
 * named by its localised plant name; then the four resting moods. Callers own
 * the preview and write the choice back with `withPlant` / `withMood`
 * (lib/plant-avatar), which keep every other stored avatar key.
 */

import { PLANT_IDS, PLANT_MOODS, type PlantId, type PlantMood } from '@greenhouse/types';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import { useT } from '../lib/i18n';

const GROUP_LABEL = 'mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-fg-faint';

/**
 * The selected species is a small bounded control among fourteen identical
 * siblings, so its ring is the state indicator (WCAG 1.4.11, 3:1). Dark's
 * `primary-edge` is a 25% overlay (≈1.35:1 on the dialog), so the ring is the
 * solid brand green, which clears 3:1 on every surface the picker sits on in both
 * themes. The faint edge is a hover cue only.
 */
const SPECIES_SELECTED = 'bg-primary-subtle ring-2 ring-primary-500';

export function PlantPicker({
  plant,
  mood,
  onPlantChange,
  onMoodChange,
}: {
  plant: PlantId;
  mood: PlantMood;
  onPlantChange: (plant: PlantId) => void;
  onMoodChange: (mood: PlantMood) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      <div>
        <span className={GROUP_LABEL}>{t('plantAvatar.plantLabel')}</span>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('plantAvatar.plantLabel')}
          data-testid="plant-picker-species"
        >
          {PLANT_IDS.map((id) => {
            const selected = id === plant;
            const name = t(`plantAvatar.name.${id}`);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                aria-label={name}
                title={name}
                data-plant={id}
                onClick={() => onPlantChange(id)}
                className={`rounded-full p-0.5 transition-colors ${
                  selected ? SPECIES_SELECTED : 'hover:bg-surface-muted hover:ring-1 hover:ring-primary-edge'
                }`}
              >
                <PlantAvatar plant={id} stableId={id} size="sm" animate={false} />
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <span className={GROUP_LABEL}>{t('plantAvatar.moodLabel')}</span>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('plantAvatar.moodLabel')}
          data-testid="plant-picker-mood"
        >
          {PLANT_MOODS.map((id) => {
            const selected = id === mood;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                data-mood={id}
                onClick={() => onMoodChange(id)}
                className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                  selected
                    ? 'border-primary-edge bg-primary-subtle font-medium text-primary-fg-strong'
                    : 'border-edge text-fg-muted hover:bg-surface-muted hover:text-fg-secondary'
                }`}
              >
                {t(`plantAvatar.mood.${id}`)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
