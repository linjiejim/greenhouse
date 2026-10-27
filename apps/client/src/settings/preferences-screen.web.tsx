import React from 'react';
import { Stack } from 'expo-router';
import { useSettings } from './use-settings';
import { usePrefs, type ThemePref, type LangPref } from '../store/prefs';
import { useT } from '../lib/i18n';
import { chooseTextSize } from './text-size';
import { TEXT_STEP_NAMES, TEXT_STEPS, type TextStep } from '../theme/type-scale';
import { HOME_RECENT_CHOICES, type HomeRecent } from '../data/home';
export default function PreferencesScreen() {
  const t = useT(),
    s = useSettings(),
    step = usePrefs((s) => s.textStep),
    recent = usePrefs((s) => s.homeRecent);
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <div className="gh-settings-content">
        <h1>{t('places.settings')}</h1>
        <h3>{t('places.appearance')}</h3>
        <section>
          <div className="gh-settings-row">
            <strong>{t('settings.theme')}</strong>
            <div className="gh-segmented">
              {(['system', 'light', 'dark'] as ThemePref[]).map((theme) => (
                <button key={theme} aria-pressed={s.theme === theme} onClick={() => s.setTheme(theme)}>
                  {t(
                    theme === 'system'
                      ? 'settings.themeSystem'
                      : theme === 'light'
                        ? 'settings.themeLight'
                        : 'settings.themeDark',
                  )}
                </button>
              ))}
            </div>
          </div>
          <label className="gh-settings-row">
            <strong>{t('settings.language')}</strong>
            <select
              aria-label={t('settings.language')}
              value={s.lang}
              onChange={(e) => void s.setLanguage(e.target.value as LangPref)}
            >
              <option value="zh">{t('settings.langZh')}</option>
              <option value="en">{t('settings.langEn')}</option>
            </select>
          </label>
          <label className="gh-settings-row">
            <strong>{t('me.textSize')}</strong>
            <select
              aria-label={t('me.textSize')}
              value={step}
              onChange={(e) => chooseTextSize(Number(e.target.value) as TextStep)}
            >
              {TEXT_STEPS.map((_, i) => (
                <option key={i} value={i}>
                  {t(`me.textStep.${TEXT_STEP_NAMES[i as TextStep]}`)}
                </option>
              ))}
            </select>
          </label>
        </section>
        <h3>{t('places.conversation')}</h3>
        <section>
          <label className="gh-settings-row">
            <strong>{t('settings.homeRecent')}</strong>
            <select
              aria-label={t('settings.homeRecent')}
              value={recent}
              onChange={(e) => usePrefs.getState().setHomeRecent(Number(e.target.value) as HomeRecent)}
            >
              {HOME_RECENT_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t('settings.homeRecentNone') : n}
                </option>
              ))}
            </select>
          </label>
        </section>
      </div>
    </>
  );
}
