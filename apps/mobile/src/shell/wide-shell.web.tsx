import { SHORTCUTS } from '../desktop/shortcuts';
import { shellChrome, railChrome, secondaryChrome, syncNativePlaces, openSettings } from '../desktop/chrome';
import { usePlaces } from './use-places';
import { PlaceSecondaryContext } from './place-secondary.web';
import { AccountMenu, NotificationsPopover, SearchPalette } from './desktop-tools.web';
import { getApiBase } from '../store/stations';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useAuth } from '../store/auth';
import { useSessions } from '../store/sessions';
import { useNotifications } from '../store/notifications';
import { usePrefs } from '../store/prefs';
import { wideLayout, RAIL_WIDTH, SECONDARY_WIDTH } from './wide-model';
import { useT } from '../lib/i18n';
import { ConversationRow } from '../chat/conversation-row.web';
import { webColors } from '../theme/web-colors.generated';
import { promptText } from '../ui/dialogs';
import { listShares, markShareRead, type SharedConversation } from '../api/shares';
import { listAutomationRuns } from '../api/assistant';
import { listProfiles, profileName, type AgentProfile } from '../api/profiles';
import { captureIdentity } from '../data/identity';
import type { ChatSession } from '../shared/greenhouse-types';
import { conversationAgent } from '../data/home';
import { parseMs } from '../data/time';
import { GreenhouseMark } from '../ui/logo';
import { RailItem } from '../ui/rail-item.web';
import { Icon, type IconName } from '../ui/core';

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
  const params = useGlobalSearchParams<{ view?: string; session?: string }>();
  const [selectedSession, setSelectedSession] = useState<string | null>(params.session ?? null);
  useEffect(() => {
    if (path === '/chat') setSelectedSession(params.session ?? null);
    else if (path === '/') setSelectedSession(null);
  }, [path, params.session]);
  const [secondaryPrefs, setSecondaryPrefs] = useState<Record<string, boolean>>({});
  const regime = layout.collapseSecondary ? 'compact' : 'wide';
  const secondary = secondaryPrefs[regime] ?? !layout.collapseSecondary;
  const user = useAuth((s) => s.user);
  const [secondaryHost, setSecondaryHost] = useState<HTMLDivElement | null>(null);
  const [search, setSearch] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const unread = Math.max(
    0,
    useNotifications((s) => s.unread),
  );
  useEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(webColors[isDark ? 'dark' : 'light'])) {
      root.style.setProperty(`--gh-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
    }
    root.style.setProperty('--gh-focus', c.accent);
    root.style.setProperty('--gh-hover', webColors[isDark ? 'dark' : 'light'].fill);
    root.style.setProperty('--gh-card', c.secondaryGroupedBackground);
    root.style.setProperty('--gh-line', c.separator);
    root.style.setProperty('--gh-secondary', c.secondaryLabel);
    root.style.setProperty('--gh-on-accent', c.onAccent);
    root.style.setProperty('--gh-sidebar-selection', c.sidebarSelection);
    root.style.colorScheme = isDark ? 'dark' : 'light';
    root.dataset.theme = isDark ? 'dark' : 'light';
  }, [c, isDark]);
  const context = useMemo(
    () => ({
      toggleSecondary: () => {
        // Resize and keydown can precede RN's dimensions render. Read the browser
        // width in the key handler so that first shortcut changes the new regime.
        if (window.innerWidth < 760) return;
        const compact = window.innerWidth < 1100;
        const key = compact ? 'compact' : 'wide';
        setSecondaryPrefs((v) => ({ ...v, [key]: !(v[key] ?? !compact) }));
      },
    }),
    [],
  );
  useShortcut(SHORTCUTS.secondary, context.toggleSecondary, !!user);
  useShortcut(SHORTCUTS.new, () => router.navigate('/'), !!user);
  useShortcut(
    SHORTCUTS.search,
    () => {
      if (layout.wide) setSearch((v) => !v);
      else router.push('/search');
    },
    !!user,
  );
  useShortcut(SHORTCUTS.settings, () => openSettings(() => router.push('/me')), !!user);
  useShortcut(
    SHORTCUTS.refresh,
    () => {
      window.dispatchEvent(new CustomEvent('greenhouse:refresh'));
      void useSessions.getState().refresh();
      void useNotifications.getState().refresh();
    },
    !!user,
  );
  const { places, apps } = usePlaces();
  const directPlace = path.startsWith('/p/')
    ? 'plugin'
    : path.startsWith('/knowledge')
      ? 'knowledge'
      : path.startsWith('/drive')
        ? params.view === 'tables'
          ? 'tables'
          : 'drive'
        : path.startsWith('/projects')
          ? 'projects'
          : path.startsWith('/automations')
            ? 'automations'
            : path === '/' || path === '/chat' || path === '/search'
              ? 'chat'
              : undefined;
  const [lastPlace, setLastPlace] = useState(directPlace ?? 'chat');
  useEffect(() => {
    if (directPlace) setLastPlace(directPlace);
  }, [directPlace]);
  const active = directPlace ?? lastPlace;
  const appSelected = (href: string) => {
    const target = href.split('?')[0];
    return path === target || path.startsWith(`${target}/`);
  };
  const nativePlaces = JSON.stringify(
    user ? [...places, ...apps.map(({ id, label, href }) => ({ id, label, href }))] : [],
  );
  useEffect(() => {
    const entries: { id: string; label: string; href: string }[] = JSON.parse(nativePlaces);
    syncNativePlaces(entries);
    const go = (event: Event) => {
      const place = entries.find((p) => p.id === (event as CustomEvent<string>).detail);
      if (place) router.navigate(place.href as never);
    };
    window.addEventListener('greenhouse:place', go);
    return () => window.removeEventListener('greenhouse:place', go);
  }, [nativePlaces, router]);
  const go = (href: string) => router.navigate(href as never);
  const rail = (id: string, label: string, icon: IconName, onPress: () => void, selected = false) => (
    <RailItem key={id} id={id} label={label} icon={icon} selected={selected} width={RAIL_WIDTH} onPress={onPress} />
  );
  const chrome = !!user && layout.wide;
  return (
    <ShellContext.Provider value={context}>
      <PlaceSecondaryContext.Provider value={secondaryHost}>
        <View style={{ flex: 1, flexDirection: 'row', backgroundColor: c.background, ...shellChrome }}>
          {chrome ? (
            <View
              key="rail"
              testID="client-rail"
              style={{
                width: RAIL_WIDTH,
                backgroundColor: c.sidebarBackground,
                borderRightWidth: 1,
                borderRightColor: c.separator,
                ...railChrome,
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
              <ScrollView showsVerticalScrollIndicator={false}>
                {places.map((place, index) => (
                  <RailShortcut key={`shortcut:${place.id}`} href={place.href} index={index} />
                ))}
                {places.map((p) =>
                  rail(p.id, p.rail ?? p.label, p.icon, () => go(p.href), p.id === active && !apps.some((a) => appSelected(a.href))),
                )}
                {apps.length ? (
                  <View
                    testID="rail-apps-divider"
                    accessibilityRole="none"
                    style={{ height: 1, marginHorizontal: 18, marginVertical: space.sm, backgroundColor: c.separator }}
                  />
                ) : null}
                {apps.map((a) => rail(a.navId, a.label, a.icon, () => go(a.href), appSelected(a.href)))}
              </ScrollView>
              <View style={{ gap: 2, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: c.separator, marginHorizontal: 0 }}>
                {user.role === 'super'
                  ? rail('admin', t('client.railAdmin'), 'shieldCheck', () => {
                      window.open(`${getApiBase()}/classic/#/administration`, '_blank', 'noopener,noreferrer');
                    })
                  : null}
                <View>
                  {rail('notifications', t('client.railActivity'), 'bell', () => {
                    setSearch(false);
                    setNotifications((v) => !v);
                  })}
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
                <AccountMenu />
              </View>
            </View>
          ) : null}
          {chrome && secondary ? (
            <View
              key="secondary"
              testID="client-secondary"
              style={{
                width: SECONDARY_WIDTH,
                backgroundColor: c.groupedBackground,
                ...secondaryChrome,
                borderRightWidth: 1,
                borderRightColor: c.separator,
              }}
            >
              {active === 'chat' ? (
                <Secondary
                  selectedSession={selectedSession}
                  active={active}
                  title={places.find((p) => p.id === active)?.label ?? ''}
                />
              ) : (
                // a place that portals nothing here (a one-page app) gets no secondary column (client.css)
                <div ref={setSecondaryHost} className="gh-secondary-host" style={{ height: '100%', overflow: 'auto' }} />
              )}
            </View>
          ) : null}
          <View key="main" testID="client-main" style={{ flex: 1, minWidth: 0 }}>
            {children}
          </View>
        </View>
        {chrome && search ? <SearchPalette close={() => setSearch(false)} /> : null}
        {chrome && notifications ? <NotificationsPopover close={() => setNotifications(false)} /> : null}
      </PlaceSecondaryContext.Provider>
    </ShellContext.Provider>
  );
}
function Secondary({
  active,
  title,
  selectedSession,
}: {
  active: string;
  title: string;
  selectedSession: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const { hex: c } = useTheme();
  const items = useSessions((s) => s.items);
  const status = useSessions((s) => s.status);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('mine');
  const member = useAuth((s) => s.user?.id);
  const lang = usePrefs((s) => s.lang);
  const [shares, setShares] = useState<SharedConversation[]>([]);
  const [scheduled, setScheduled] = useState<ChatSession[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [tabStatus, setTabStatus] = useState('ready');
  useEffect(() => {
    const current = captureIdentity();
    let alive = true;
    void listProfiles().then((r) => {
      if (alive && current()) setProfiles(r.ok ? r.data : []);
    });
    return () => {
      alive = false;
    };
  }, [member]);
  useEffect(() => {
    if (tab === 'mine') return;
    const current = captureIdentity();
    let alive = true;
    setTabStatus('loading');
    if (tab === 'shared')
      void listShares().then((r) => {
        if (!alive || !current()) return;
        setShares(r.ok ? r.data : []);
        setTabStatus(r.ok ? 'ready' : 'error');
      });
    else
      void listAutomationRuns().then((r) => {
        if (!alive || !current()) return;
        setScheduled(r.ok ? r.data.sessions : []);
        setTabStatus(r.ok ? 'ready' : 'error');
      });
    return () => {
      alive = false;
    };
  }, [tab, member]);
  const rename = async (item: ChatSession) => {
    const next = await promptText({ title: t('home.rename'), defaultValue: item.title ?? '' });
    if (next) void useSessions.getState().rename(item.id, next.slice(0, 200));
  };

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
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: c.tertiaryFill,
          borderRadius: 8,
          paddingHorizontal: 8,
          marginVertical: 8,
        }}
      >
        <Icon name="search" size={16} color={c.secondaryLabel} />
        <input
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            font: 'inherit',
            color: c.label,
            background: 'transparent',
            border: 0,
            padding: '8px 0',
          }}
        />
        <span style={{ color: c.tertiaryLabel, fontSize: typo.caption1.fontSize }}>⌘K</span>
      </View>
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
            <div data-conversation-list>
              {tab === 'mine' && status !== 'error' && status !== 'empty' && !groups.size ? (
                <Text style={{ color: c.secondaryLabel, padding: 8 }}>
                  {t(query ? 'common.noMatches' : 'home.noConversations')}
                </Text>
              ) : null}
              {tab === 'mine' ? (
                ['home.pinned', 'client.today', 'client.yesterday', 'client.earlier']
                  .filter((g) => groups.has(g))
                  .map((group) => {
                    const rows = groups.get(group)!;
                    return (
                      <View key={group} style={{ marginBottom: space.lg }}>
                        <Text
                          style={{ ...typo.footnote, fontWeight: '600', color: c.tertiaryLabel, padding: space.sm }}
                        >
                          {t(group as never)}
                        </Text>
                        {rows.map((item) => (
                          <ConversationRow
                            key={item.id}
                            session={item}
                            position="only"
                            secondary
                            selected={selectedSession === item.id}
                            onOpen={() => router.push({ pathname: '/chat', params: { session: item.id } })}
                            onPin={(pinned) => void useSessions.getState().pin(item.id, pinned)}
                            onRename={() => void rename(item)}
                          />
                        ))}
                      </View>
                    );
                  })
              ) : (
                <View>
                  {tabStatus === 'loading' ? (
                    <Text>{t('common.loading')}</Text>
                  ) : tabStatus === 'error' ? (
                    <Text>{t('assistant.loadFailed')}</Text>
                  ) : null}
                  {tab === 'shared'
                    ? shares
                        .filter((s) => !query || s.session_title.toLowerCase().includes(query.toLowerCase()))
                        .map((share) => (
                          <button
                            className="gh-secondary-row"
                            key={share.id}
                            onClick={() => {
                              void markShareRead(share.id);
                              router.push({ pathname: '/chat', params: { session: share.session_id } });
                            }}
                            style={{
                              border: 0,
                              width: '100%',
                              textAlign: 'left',
                              padding: 8,
                              color: c.label,
                              background: 'transparent',
                            }}
                          >
                            {share.session_title}
                          </button>
                        ))
                    : scheduled.map((item) => (
                        <ConversationRow
                          key={item.id}
                          session={item}
                          position="only"
                          secondary
                          selected={selectedSession === item.id}
                          onOpen={() => router.push({ pathname: '/chat', params: { session: item.id } })}
                          onPin={(pinned) => void useSessions.getState().pin(item.id, pinned)}
                          onRename={() => void rename(item)}
                        />
                      ))}
                  {tabStatus === 'ready' && !(tab === 'shared' ? shares : scheduled).length ? (
                    <Text style={{ color: c.secondaryLabel, padding: 8 }}>{t('home.noConversations')}</Text>
                  ) : null}
                </View>
              )}
              {tab === 'mine' && profiles.some((p) => conversationAgent(p.id)) ? (
                <View style={{ marginTop: space.md }}>
                  <Text style={{ ...typo.footnote, color: c.tertiaryLabel, padding: 8 }}>{t('client.bots')}</Text>
                  {profiles
                    .filter((p) => conversationAgent(p.id))
                    .map((profile) => (
                      <button
                        className="gh-secondary-row"
                        key={profile.id}
                        onClick={() => {
                          const existing = items.find((s) => s.profile_id?.replace(/@\d+$/, '') === profile.id);
                          router.push({
                            pathname: '/chat',
                            params: existing ? { session: existing.id } : { agent: profile.id },
                          });
                        }}
                        style={{
                          border: 0,
                          width: '100%',
                          display: 'flex',
                          gap: 8,
                          alignItems: 'center',
                          padding: 8,
                          color: c.label,
                          background: 'transparent',
                        }}
                      >
                        <Icon name="sparkle" size={16} color={c.accentText} />
                        {profileName(profile, lang)}
                      </button>
                    ))}
                </View>
              ) : null}

              {status === 'error' ? (
                <Pressable accessibilityRole="button" onPress={() => void useSessions.getState().refresh()}>
                  <Text>{t('common.retry')}</Text>
                </Pressable>
              ) : null}
            </div>
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
  useShortcut(SHORTCUTS[`place-${index + 1}`], () => router.navigate(href as never));
  return null;
}
