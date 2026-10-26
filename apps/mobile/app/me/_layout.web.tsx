import { closeSettings } from '../../src/desktop/chrome';
import React from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '../../src/theme';
import { pageScreen, stackDefaults } from '../../src/ui/nav';
import { useAuth } from '../../src/store/auth';
import { useT } from '../../src/lib/i18n';
import { usePrefs } from '../../src/store/prefs';
import { useStationManifest } from '../../src/plugins/store';
import { pluginNavigation } from '../../src/plugins/manifest';
import { localize } from '../../src/shared/plugins';
import { pluginHref } from '../../src/plugins/navigation';
export const unstable_settings = { initialRouteName: 'index' };
export default function SettingsLayout() {
  const { colors: c, hex, isDark } = useTheme(),
    t = useT(),
    router = useRouter(),
    path = usePathname(),
    user = useAuth((s) => s.user),
    lang = usePrefs((s) => s.lang),
    state = useStationManifest((s) => s.data),
    { width } = useWindowDimensions();
  const pluginItems = [...pluginNavigation(state, 'primary'), ...pluginNavigation(state, 'more')].filter(
    (n) => n.page.kind === 'native' && !['knowledge', 'projects', 'tables'].includes(n.page.screen),
  );
  const body = <Stack screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true }) }} />;
  return width < 760 ? (
    body
  ) : (
    <div className="gh-settings" style={{ color: hex.label, background: hex.groupedBackground }}>
      <aside>
        <div className="gh-settings-person">
          <b>{user?.nickname?.slice(0, 1)}</b>
          <div>
            <strong>{user?.nickname}</strong>
            <small>{user?.role === 'super' ? t('settings.roleAdmin') : t('settings.roleMember')}</small>
          </div>
        </div>
        <nav>
          {[
            { label: t('places.settings'), href: '/me' },
            { label: t('client.account'), href: '/me/account' },
            { label: t('client.agents'), href: '/me/agents' },
            { label: t('connectors.title'), href: '/me/connectors' },
            ...pluginItems.map((n) => ({ label: localize(n.nav.label, lang), href: pluginHref(n.plugin.id, n.page) })),
            { label: t('client.station'), href: '/me/stations' },
          ].map((item) => (
            <button
              key={item.href}
              aria-current={path === item.href ? 'page' : undefined}
              onClick={() => router.navigate(item.href as never)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="gh-settings-main">
        <button
          className="gh-settings-close"
          aria-label={t('common.close')}
          onClick={() => closeSettings(() => router.dismiss())}
        >
          ×
        </button>
        {body}
      </div>
    </div>
  );
}
