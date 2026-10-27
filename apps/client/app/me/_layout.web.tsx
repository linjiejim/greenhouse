import { closeSettings } from '../../src/desktop/chrome';
import React from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '../../src/theme';
import { pageScreen, stackDefaults } from '../../src/ui/nav';
import { useAuth } from '../../src/store/auth';
import { useT } from '../../src/lib/i18n';
import { Icon, type IconName } from '../../src/ui/core';
import { SheetFrame } from '../../src/ui/sheet-actions';
import { SettingsWindowContext } from '../../src/ui/settings-frame';
import { WIDE_MIN } from '../../src/shell/wide-model';
export const unstable_settings = { initialRouteName: 'index' };
export default function SettingsLayout() {
  const { colors: c, hex, isDark } = useTheme(),
    t = useT(),
    router = useRouter(),
    path = usePathname(),
    user = useAuth((s) => s.user),
    { width } = useWindowDimensions();
  // Personal settings only: every app (plugin page) has its own place in the rail.
  const items: { label: string; href: string; icon: IconName }[] = [
    { label: t('places.settings'), href: '/me', icon: 'gear' },
    { label: t('client.account'), href: '/me/account', icon: 'person' },
    { label: t('client.agents'), href: '/me/agents', icon: 'sparkle' },
    { label: t('connectors.title'), href: '/me/connectors', icon: 'link' },
    { label: t('client.station'), href: '/me/stations', icon: 'server' },
  ];
  const body = <Stack screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true }) }} />;
  return width < WIDE_MIN ? (
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
          {items.map((item) => (
            <button
              key={item.href}
              aria-current={path === item.href ? 'page' : undefined}
              onClick={() => router.navigate(item.href as never)}
            >
              <Icon name={item.icon} size={18} color={path === item.href ? hex.accentText : hex.secondaryLabel} />
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
          <Icon name="x" size={20} />
        </button>
        {/* the page's footer actions belong to this column, not the whole settings window */}
        <SettingsWindowContext.Provider value={true}>
          <SheetFrame>{body}</SheetFrame>
        </SettingsWindowContext.Provider>
      </div>
    </div>
  );
}
