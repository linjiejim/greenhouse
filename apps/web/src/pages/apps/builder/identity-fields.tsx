/**
 * How an app (or one of its pages) looks: an icon from the fixed `APP_ICONS`
 * list and, for the app, an accent from `APP_ACCENTS` — drawn with the same
 * `AppBadge` / `appIcon` the center, the sidebar and the runtime use, so the
 * choice looks here exactly as it will everywhere.
 */

import { APP_ACCENTS, APP_ICONS, type AppAccent, type AppIconName } from '@greenhouse/types/apps';
import { AppBadge } from '../../../components/apps';
import { useT } from '../../../lib/i18n';
import { appIcon, Ban } from '../../../lib/icons';

const CHOICE =
  'inline-flex h-11 w-11 items-center justify-center rounded-lg border transition-colors focus:outline-none sm:h-9 sm:w-9';
const CHOSEN = 'border-primary-edge bg-primary-subtle text-primary-fg-strong';
const UNCHOSEN = 'border-edge text-fg-muted hover:bg-surface-muted hover:text-fg';

export function AppIconPicker({
  label,
  value,
  onChange,
  allowNone = false,
  disabled = false,
}: {
  label: string;
  value: AppIconName | undefined;
  onChange: (next: AppIconName | undefined) => void;
  /** A page may have no icon; an app always has one. */
  allowNone?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {allowNone && (
        <button
          type="button"
          aria-pressed={value === undefined}
          aria-label={t('apps.builder.identity.noIcon')}
          title={t('apps.builder.identity.noIcon')}
          disabled={disabled}
          onClick={() => onChange(undefined)}
          className={`${CHOICE} ${value === undefined ? CHOSEN : UNCHOSEN}`}
        >
          <Ban size={14} />
        </button>
      )}
      {APP_ICONS.map((name) => {
        const Icon = appIcon(name);
        const chosen = value === name;
        return (
          <button
            key={name}
            type="button"
            aria-pressed={chosen}
            aria-label={t(`apps.builder.identity.icons.${name}`)}
            title={t(`apps.builder.identity.icons.${name}`)}
            disabled={disabled}
            onClick={() => onChange(name)}
            className={`${CHOICE} ${chosen ? CHOSEN : UNCHOSEN}`}
          >
            <Icon size={16} />
          </button>
        );
      })}
    </div>
  );
}

export function AppAccentPicker({
  label,
  value,
  icon,
  onChange,
  disabled = false,
}: {
  label: string;
  value: AppAccent;
  /** Drawn on each swatch, so the choice previews the app's tile. */
  icon: AppIconName;
  onChange: (next: AppAccent) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {APP_ACCENTS.map((accent) => {
        const chosen = value === accent;
        return (
          <button
            key={accent}
            type="button"
            aria-pressed={chosen}
            aria-label={t(`apps.builder.identity.accents.${accent}`)}
            title={t(`apps.builder.identity.accents.${accent}`)}
            disabled={disabled}
            onClick={() => onChange(accent)}
            className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border p-0.5 transition-colors focus:outline-none sm:h-10 sm:w-10 ${
              chosen ? 'border-primary-edge' : 'border-transparent hover:border-edge'
            }`}
          >
            <AppBadge icon={icon} accent={accent} size="md" />
          </button>
        );
      })}
    </div>
  );
}
