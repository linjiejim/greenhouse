import { getApiBase } from '../store/stations';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useAuth } from '../store/auth';
import { useSessions } from '../store/sessions';
import { useNotifications } from '../store/notifications';
import { usePrefs } from '../store/prefs';
import { useStationManifest } from '../plugins/store';
import { builtinVisible, hasPlugin, pluginNavigation } from '../plugins/manifest';
import { localize } from '../shared/plugins';
import { hasTables } from './modules';
import { wideLayout, RAIL_WIDTH, SECONDARY_WIDTH } from './wide-model';
import { useT } from '../lib/i18n';
import { shortAgeNow } from '../lib/time-words';
import { parseMs } from '../data/time';
import { GreenhouseMark } from '../ui/logo';
import { Icon, type IconName } from '../ui/core';
import { NativeMenu } from '../ui/menu';
import { Avatar } from '../ui/avatar';
import { Segmented } from '../ui/segmented';
import { useShortcut } from '../ui/use-shortcut';
import { space, typo, useTheme } from '../theme';
const ShellContext = createContext({ toggleSecondary: () => {} });
export const useWideShell = () => useContext(ShellContext);
export function WideShell({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const layout = wideLayout(width);
  const { hex: c, isDark } = useTheme();
  const t = useT();
  const router = useRouter();
  const path = usePathname();
  const params = useGlobalSearchParams<{ view?: string }>();
  const [secondary, setSecondary] = useState(!layout.collapseSecondary);
  const user = useAuth((s) => s.user);
  const manifest = useStationManifest((s) => s.data);
  const lang = usePrefs((s) => s.lang);
  const unread = Math.max(
    0,
    useNotifications((s) => s.unread),
  );
  useEffect(() => setSecondary(!layout.collapseSecondary), [layout.collapseSecondary]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--gh-focus', c.accent);
    root.style.setProperty('--gh-hover', c.tertiaryFill);
    root.style.colorScheme = isDark ? 'dark' : 'light';
    root.dataset.theme = isDark ? 'dark' : 'light';
  }, [c, isDark]);
  const context = useMemo(() => ({ toggleSecondary: () => setSecondary((v) => !v) }), []);
  useShortcut('mod+\\', context.toggleSecondary, !!user && layout.wide);
  useShortcut('mod+n', () => router.navigate('/'), !!user);
  useShortcut('mod+k', () => router.push('/search'), !!user);
  useShortcut('mod+,', () => router.push('/me'), !!user);
  useShortcut(
    'mod+r',
    () => {
      void useSessions.getState().refresh();
      void useNotifications.getState().refresh();
    },
    !!user,
  );
  const places = [
    { id: 'chat', label: t('client.conversations'), icon: 'msg' as IconName, href: '/' },
    ...(hasPlugin(manifest, 'knowledge')
      ? [{ id: 'knowledge', label: t('nav.knowledge'), icon: 'book' as IconName, href: '/knowledge' }]
      : []),
    { id: 'drive', label: t('nav.files'), icon: 'folder' as IconName, href: '/drive' },
    ...(builtinVisible(manifest, 'tables', hasTables(user))
      ? [{ id: 'tables', label: t('nav.tables'), icon: 'table' as IconName, href: '/drive?view=tables' }]
      : []),
    ...(hasPlugin(manifest, 'projects')
      ? [{ id: 'projects', label: t('nav.projects'), icon: 'checklist' as IconName, href: '/projects' }]
      : []),
    { id: 'automations', label: t('nav.automations'), icon: 'clock' as IconName, href: '/automations' },
  ];
  const active = path.startsWith('/knowledge')
    ? 'knowledge'
    : path.startsWith('/drive')
      ? params.view === 'tables'
        ? 'tables'
        : 'drive'
      : path.startsWith('/projects')
        ? 'projects'
        : path.startsWith('/automations')
          ? 'automations'
          : 'chat';
  const more = pluginNavigation(manifest, 'more');
  const primary = pluginNavigation(manifest, 'primary').filter(
    (n) => !['knowledge', 'tables', 'projects'].includes(n.plugin.id),
  );
  const go = (href: string) => router.navigate(href as never);
  const rail = (id: string, label: string, icon: IconName, onPress: () => void, selected = false) => (
    <Pressable
      key={id}
      testID={`rail-${id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        minHeight: 52,
        marginHorizontal: 8,
        borderRadius: 12,
        backgroundColor: selected ? c.sidebarSelection : pressed ? c.fill : 'transparent',
      })}
    >
      <Icon name={icon} size={22} color={selected ? c.accentText : c.secondaryLabel} />
      <Text style={{ ...typo.caption1, color: selected ? c.accentText : c.secondaryLabel, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
  if (!user || !layout.wide) return <ShellContext.Provider value={context}>{children}</ShellContext.Provider>;
  return (
    <ShellContext.Provider value={context}>
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: c.background }}>
        <View
          testID="client-rail"
          style={{
            width: RAIL_WIDTH,
            backgroundColor: c.sidebarBackground,
            borderRightWidth: 1,
            borderRightColor: c.separator,
            paddingTop: 52,
            paddingBottom: space.md,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Greenhouse"
            onPress={() => go('/')}
            style={{ alignItems: 'center', marginBottom: space.lg }}
          >
            <GreenhouseMark size={28} />
          </Pressable>
          <ScrollView>
            {places.map((place, index) => (
              <RailShortcut key={`shortcut:${place.id}`} href={place.href} index={index} />
            ))}
            {places.map((p) => rail(p.id, p.label, p.icon, () => go(p.href), p.id === active))}
            {primary.map((n) =>
              rail(n.nav.id, localize(n.nav.label, lang), 'open', () => go(`/p/${n.plugin.id}/${n.page.id}`)),
            )}
            {more.length ? (
              <NativeMenu
                title={t('client.more')}
                items={more.map((n) => ({
                  id: `${n.plugin.id}/${n.page.id}`,
                  title: localize(n.nav.label, lang),
                  icon: 'open',
                }))}
                onSelect={(id) => go(`/p/${id}`)}
              >
                {rail('more', t('client.more'), 'more', () => {})}
              </NativeMenu>
            ) : null}
          </ScrollView>
          <View style={{ gap: space.sm }}>
            {user.role === 'super'
              ? rail('admin', t('client.admin'), 'shieldCheck', () => {
                  window.location.assign(`${getApiBase()}/classic/#/administration/users`);
                })
              : null}
            <View>
              {rail('notifications', t('notifications.title'), 'bell', () => router.push('/notifications'))}
              {unread ? (
                <Text
                  style={{
                    position: 'absolute',
                    right: 14,
                    top: 0,
                    ...typo.caption1,
                    color: c.onTint,
                    backgroundColor: c.red,
                    borderRadius: 12,
                    paddingHorizontal: 4,
                  }}
                >
                  {unread > 99 ? '99+' : unread}
                </Text>
              ) : null}
            </View>
            <NativeMenu
              title={`${user.nickname} · ${user.email}`}
              items={[
                { id: 'settings', title: t('nav.settings'), icon: 'gear', shortcut: '⌘ ,' },
                { id: 'logout', title: t('settings.logout'), icon: 'logout', destructive: true },
              ]}
              onSelect={(id) => (id === 'logout' ? useAuth.getState().logout() : router.push('/me'))}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={user.nickname}
                style={{ alignItems: 'center', padding: 8 }}
              >
                <Avatar name={user.nickname} size={28} />
              </Pressable>
            </NativeMenu>
          </View>
        </View>
        {secondary ? (
          <View
            testID="client-secondary"
            style={{
              width: SECONDARY_WIDTH,
              backgroundColor: c.groupedBackground,
              borderRightWidth: 1,
              borderRightColor: c.separator,
            }}
          >
            <Secondary active={active} title={places.find((p) => p.id === active)?.label ?? ''} />
          </View>
        ) : null}
        <View testID="client-main" style={{ flex: 1, minWidth: 0 }}>
          {children}
        </View>
      </View>
    </ShellContext.Provider>
  );
}
function Secondary({ active, title }: { active: string; title: string }) {
  const t = useT();
  const router = useRouter();
  const { hex: c } = useTheme();
  const items = useSessions((s) => s.items);
  const status = useSessions((s) => s.status);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('mine');
  const path = usePathname();
  const params = useGlobalSearchParams<{ session?: string }>();
  useEffect(() => {
    void useSessions.getState().refresh();
  }, []);
  const groups = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const today = now.getTime();
    const grouped = new Map<string, typeof items>();
    for (const item of items) {
      if (query && !item.title?.toLowerCase().includes(query.toLowerCase())) continue;
      const when = parseMs(item.updated_at);
      const group = item.pinned
        ? 'home.pinned'
        : when >= today
          ? 'client.today'
          : when >= today - 86400000
            ? 'client.yesterday'
            : 'client.earlier';
      grouped.set(group, [...(grouped.get(group) ?? []), item]);
    }
    return grouped;
  }, [items, query]);
  return (
    <View style={{ flex: 1, padding: space.sm }}>
      <View
        style={{
          height: 36,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: space.sm,
        }}
      >
        <Text style={{ ...typo.title2, color: c.label }}>{title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('conversation.newChat')}
          onPress={() => router.navigate('/')}
          style={{ padding: 4 }}
        >
          <Icon name="compose" size={18} color={c.accent} />
        </Pressable>
      </View>
      <input
        aria-label={t('common.search')}
        placeholder={`${t('common.search')}                         ⌘K`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          font: 'inherit',
          color: c.label,
          background: c.tertiaryFill,
          border: 0,
          borderRadius: 8,
          padding: 8,
          marginBlock: 8,
          minWidth: 0,
        }}
      />
      {active === 'chat' ? (
        <>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'mine', label: t('client.mine') },
              { value: 'shared', label: t('client.shared') },
              { value: 'scheduled', label: t('client.scheduled') },
            ]}
          />
          <ScrollView style={{ marginTop: space.md }}>
            {tab === 'mine' ? (
              Array.from(groups, ([group, rows]) => (
                <View key={group} style={{ marginBottom: space.lg }}>
                  <Text style={{ ...typo.footnote, fontWeight: '600', color: c.tertiaryLabel, padding: space.sm }}>
                    {t(group as never)}
                  </Text>
                  {rows.map((item) => (
                    <button
                      key={item.id}
                      className="gh-secondary-row"
                      aria-current={path === '/chat' && params.session === item.id ? 'page' : undefined}
                      onClick={() => router.push({ pathname: '/chat', params: { session: item.id } })}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          e.preventDefault();
                          const buttons = Array.from(
                            e.currentTarget
                              .closest('[role="navigation"]')
                              ?.querySelectorAll<HTMLButtonElement>('.gh-secondary-row') ??
                              document.querySelectorAll<HTMLButtonElement>('.gh-secondary-row'),
                          );
                          buttons[
                            (buttons.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                              buttons.length
                          ]?.focus();
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        width: '100%',
                        height: 32,
                        gap: space.sm,
                        padding: '0 8px',
                        border: 0,
                        borderRadius: 8,
                        background: params.session === item.id ? c.sidebarSelection : 'transparent',
                        color: c.secondaryLabel,
                        font: 'inherit',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          textAlign: 'left',
                        }}
                      >
                        {item.title || t('assistant.untitled')}
                      </span>
                      <span style={{ fontSize: typo.caption1.fontSize, color: c.tertiaryLabel }}>
                        {shortAgeNow(item.updated_at)}
                      </span>
                    </button>
                  ))}
                </View>
              ))
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(tab === 'shared' ? '/conversations' : '/automations')}
                style={{ padding: space.md }}
              >
                <Text style={{ ...typo.body, color: c.accentText }}>
                  {t(tab === 'shared' ? 'home.all' : 'nav.automations')} ›
                </Text>
              </Pressable>
            )}
            {status === 'error' ? (
              <Pressable accessibilityRole="button" onPress={() => void useSessions.getState().refresh()}>
                <Text>{t('common.retry')}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            router.navigate(active === 'tables' ? ('/drive?view=tables' as never) : (`/${active}` as never))
          }
          style={{ padding: space.md }}
        >
          <Text style={{ ...typo.body, color: c.accentText }}>{title}</Text>
        </Pressable>
      )}
    </View>
  );
}

function RailShortcut({ href, index }: { href: string; index: number }) {
  const router = useRouter();
  useShortcut(`mod+${index + 1}`, () => router.navigate(href as never));
  return null;
}
