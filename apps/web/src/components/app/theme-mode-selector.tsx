/**
 * ThemeModeSelector — light / dark / system three-way toggle.
 * Shared by the Preferences panel and the Preferences dialog.
 */

import React, { useState } from 'react';
import { Sun, Moon, Monitor } from '../../lib/icons';
import type { LucideIcon } from '../../lib/icons';
import { THEME_MODES, getThemeMode, setThemeMode } from '../../lib/theme';
import type { ThemeMode } from '../../lib/theme';
import { useT } from '../../lib/i18n';

const MODE_ICONS: Record<ThemeMode, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

export function ThemeModeSelector() {
  const t = useT();
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  const labels: Record<ThemeMode, string> = {
    light: t('preferences.themeLight'),
    dark: t('preferences.themeDark'),
    system: t('preferences.themeSystem'),
  };

  return (
    <div className="flex gap-2">
      {THEME_MODES.map((m) => {
        const Icon = MODE_ICONS[m];
        const isActive = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => {
              setThemeMode(m);
              setMode(m);
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 transition-all ${
              isActive
                ? 'border-primary-500 bg-primary-subtle/50 text-primary-fg-strong font-medium shadow-sm'
                : 'border-edge text-fg-secondary hover:border-edge-strong hover:bg-surface-sunken'
            }`}
          >
            <Icon size={15} />
            <span className="text-sm">{labels[m]}</span>
          </button>
        );
      })}
    </div>
  );
}
