/**
 * Avatar picker on the Sprouty DSL (`AvatarConfig`): color, up to two
 * accessories, and a resting mood — the three choices that make Bots tell
 * apart at 24px in a conversation list. Leaf/eye/palette stay with the full
 * Agent avatar designer; a Bot should take ten seconds to dress, not ten
 * minutes.
 */

import type { AvatarConfig, SproutyFaceStyleId } from '@greenhouse/types/profile-manifest';
import { COLOR_PRESETS, ACCESSORIES } from '../sprouty';
import { useT, type TranslationKey } from '../../lib/i18n';
import { BotAvatar } from './bot-avatar';

const MAX_ACCESSORIES = 2;
/**
 * Mirrors SPROUTY_FACE_STYLE_IDS. Typed against it (a rename fails to compile)
 * but not imported: that module carries zod, which the web bundle doesn't ship.
 */
const FACE_STYLES: readonly SproutyFaceStyleId[] = ['default', 'happy', 'sparkle', 'sleepy'];

export function AvatarPicker({ value, onChange }: { value: AvatarConfig; onChange: (next: AvatarConfig) => void }) {
  const t = useT();
  const accessories = value.accessories ?? [];
  const toggleAccessory = (id: string) => {
    const selected = accessories.includes(id);
    const next = selected ? accessories.filter((item) => item !== id) : [...accessories, id].slice(-MAX_ACCESSORIES);
    onChange({ ...value, accessories: next });
  };

  return (
    <div className="flex gap-4">
      <div className="flex w-20 flex-shrink-0 flex-col items-center gap-1 pt-1">
        <BotAvatar avatar={value} size="lg" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-fg-faint">
            {t('bots.form.color')}
          </span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('bots.form.color')}>
            {Object.entries(COLOR_PRESETS).map(([key, colors]) => {
              const selected = (value.color ?? 'forest') === key;
              const label = t(`profileEditor.colorName.${key}` as TranslationKey);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={selected}
                  aria-label={label}
                  title={label}
                  onClick={() => onChange({ ...value, color: key })}
                  className={`h-7 w-7 rounded-full border-2 transition-transform ${
                    selected ? 'scale-110 border-fg-secondary' : 'border-transparent hover:scale-105'
                  }`}
                  // Swatches show the mascot's own body color — the one place
                  // these hexes live (sprouty-constants), not theme tokens.
                  style={{ backgroundColor: colors.body }}
                />
              );
            })}
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-fg-faint">
            {t('bots.form.accessories')}
          </span>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('bots.form.accessories')}>
            {ACCESSORIES.map((accessory) => {
              const selected = accessories.includes(accessory.id);
              return (
                <button
                  key={accessory.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleAccessory(accessory.id)}
                  className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                    selected
                      ? 'border-primary-edge bg-primary-subtle font-medium text-primary-fg-strong'
                      : 'border-edge text-fg-muted hover:bg-surface-muted hover:text-fg-secondary'
                  }`}
                >
                  {t(`profileEditor.accessoryName.${accessory.id}` as TranslationKey)}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-fg-faint">
            {t('bots.form.face')}
          </span>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('bots.form.face')}>
            {FACE_STYLES.map((face) => {
              const selected = (value.faceStyle ?? 'default') === face;
              return (
                <button
                  key={face}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChange({ ...value, faceStyle: face })}
                  className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                    selected
                      ? 'border-primary-edge bg-primary-subtle font-medium text-primary-fg-strong'
                      : 'border-edge text-fg-muted hover:bg-surface-muted hover:text-fg-secondary'
                  }`}
                >
                  {t(`bots.form.faceName.${face}` as TranslationKey)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
