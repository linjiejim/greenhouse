/** Desktop overlays reuse the phone's search adapters and notification center. */
import { IS_SINGLE_STATION } from '../config';
import { openSettings, openStationSettings } from '../desktop/chrome';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { DialogBody, Overlay } from '../ui/overlay.web';
import { Icon, type IconName } from '../ui/core.web';
import { usePlaces } from './use-places';
import { NativeMenu } from '../ui/menu.web';
import { Avatar } from '../ui/avatar';
import { useT } from '../lib/i18n';
import { useTheme } from '../theme';
import { useAuth } from '../store/auth';
import { getApiBase } from '../store/stations';
import { searchAll } from '../api/assistant';
import { searchCabinet } from '../api/drive';
import { stationSections, fileSection, taskSection, type SearchHitView } from '../data/search';
import { parseMyTasks } from '../data/recent-items';
import { readOffline } from '../store/offline';
import { captureIdentity } from '../data/identity';
import { useOpenObject } from './open-object';
import { useNotifications } from '../store/notifications';
import { alertError } from '../ui/dialogs';
import NotificationsCenter from '../notifications/center';

export function AccountMenu() {
  const user = useAuth((s) => s.user);
  const t = useT();
  const router = useRouter();
  if (!user) return null;
  return (
    <NativeMenu
      fill
      title={`${user.nickname} · ${user.email}`}
      items={[
        { id: 'account', title: t('client.account'), icon: 'person' },
        {
          id: 'station',
          title: `${t('client.station')} · ${new URL(getApiBase()).host}`,
          icon: 'server',
          disabled: IS_SINGLE_STATION,
        },
        { id: 'text', title: t('client.textSize'), icon: 'textSize' },
        { id: 'agents', title: t('client.agents'), icon: 'sparkle' },
        { id: 'settings', title: t('nav.settings'), icon: 'gear', shortcut: '⌘ ,' },
        { id: 'logout', title: t('client.signOut'), icon: 'logout', destructive: true },
      ]}
      onSelect={(id) => {
        if (id === 'settings') openSettings(() => router.push('/me'));
        else if (id === 'station') openStationSettings(() => router.push('/me/stations'));
        else if (id === 'logout') void useAuth.getState().logout();
        else router.push(id === 'agents' ? '/me/agents' : ({ pathname: '/me', params: { section: id } } as never));
      }}
    >
      <button
        data-testid="rail-me"
        aria-label={t('me.title')}
        style={{
          border: 0,
          background: 'transparent',
          display: 'flex',
          justifyContent: 'center',
          width: '100%',
          padding: 8,
        }}
      >
        <Avatar name={user.nickname} size={28} />
      </button>
    </NativeMenu>
  );
}

export function NotificationsPopover({ close }: { close: () => void }) {
  const t = useT();
  const { hex: c } = useTheme();
  const unread = useNotifications((s) => s.unread);
  return (
    <Overlay testID="notifications-popover" label={t('notifications.title')} size="md" onClose={close}>
      <DialogBody
        title={t('notifications.title')}
        actions={
          <>
            <button
              disabled={unread === 0}
              style={{ border: 0, background: 'transparent', color: c.accentText }}
              onClick={async () => {
                if (!(await useNotifications.getState().markAllRead())) alertError(t('notifications.markFailed'));
              }}
            >
              {t('notifications.markAllRead')}
            </button>
            <button className="gh-icon-button" aria-label={t('common.close')} onClick={close}>
              <Icon name="x" size={18} />
            </button>
          </>
        }
      >
        <NotificationsCenter chrome={false} onOpen={close} />
      </DialogBody>
    </Overlay>
  );
}

export function SearchPalette({ close }: { close: () => void }) {
  const t = useT();
  const { hex: c } = useTheme();
  const router = useRouter();
  const openObject = useOpenObject();
  const { places, apps } = usePlaces();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState(0);
  const [hits, setHits] = useState<(SearchHitView & { category: number })[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const categories = [
    t('client.all'),
    t('client.conversations'),
    t('client.docs'),
    t('client.files'),
    t('client.tasks'),
    t('client.commands'),
  ];
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    let alive = true;
    const identity = captureIdentity();
    setLoading(true);
    const timer = setTimeout(() => {
      void Promise.all([searchAll(query.trim()), searchCabinet(query.trim()), readOffline('my-tasks')]).then(
        ([station, files, saved]) => {
          if (!alive || !identity()) return;
          const tasks = (parseMyTasks(saved) ?? []).flatMap((group) => group.tasks);
          const sections = [
            ...(station.ok ? stationSections(station.data.groups) : []),
            files.ok ? fileSection(files.data.files, () => '') : null,
            taskSection(tasks, query),
          ].filter((s) => !!s);
          setHits(
            sections.flatMap((s) =>
              s.hits.map((h) => ({
                ...h,
                category: s.kind === 'session' ? 1 : s.kind === 'file' ? 3 : s.kind === 'task' ? 4 : 2,
              })),
            ),
          );
          setLoading(false);
          setFailed(!station.ok && !files.ok);
          setSelected(0);
        },
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  const commands = useMemo(
    () => [
      {
        key: 'new',
        title: t('conversation.newChat'),
        icon: 'compose' as IconName,
        subtitle: undefined as string | undefined,
        shortcut: '⌘ N' as string | undefined,
        run: () => router.navigate('/'),
      },
      {
        key: 'upload',
        title: t('client.upload'),
        icon: 'upload' as IconName,
        subtitle: undefined,
        shortcut: undefined,
        run: () => router.navigate('/drive'),
      },
      {
        key: 'settings',
        title: t('nav.settings'),
        icon: 'gear' as IconName,
        subtitle: undefined,
        shortcut: '⌘ ,',
        run: () => router.push('/me'),
      },
      // every place and app: ⌘1… for the first places, the rest by name
      ...[...places, ...apps].map((place, index) => ({
        key: `go:${place.id}`,
        title: place.label,
        icon: place.icon,
        subtitle: t('client.goTo'),
        shortcut: index < 6 ? `⌘ ${index + 1}` : undefined,
        run: () => router.navigate(place.href as never),
      })),
    ],
    [router, t, places, apps],
  );
  const hitIcon: Record<number, IconName> = { 1: 'msg', 2: 'book', 3: 'fileOther', 4: 'checklist' };
  const rows = [
    ...hits
      .filter((h) => !tab || tab === h.category)
      .map((h) => ({
        ...h,
        icon: (h.ref.kind === 'project' ? 'checklist' : h.ref.kind === 'record' ? 'table' : hitIcon[h.category]) ?? ('file' as IconName),
        shortcut: undefined as string | undefined,
        run: (inspector: boolean) => openObject(h.ref, inspector ? undefined : 'main'),
      })),
    ...(!tab || tab === 5
      ? commands.filter(
          (h) =>
            (!query && !h.key.startsWith('go:')) ||
            (query && `${h.title} ${h.subtitle ?? ''}`.toLowerCase().includes(query.toLowerCase())) ||
            (tab === 5 && !query),
        )
      : []),
  ];
  const choose = (index: number, inspector: boolean) => {
    const row = rows[index];
    if (row) {
      close();
      row.run(inspector);
    }
  };
  return (
    <Overlay
      testID="command-palette"
      label={t('common.search')}
      trapTab={false}
      onClose={close}
      // a fixed size so the box never jumps while results load; top-anchored like every command palette
      panelStyle={{
        position: 'fixed',
        top: 120,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 640,
        height: 480,
        maxHeight: 'calc(100vh - 152px)',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            setTab((tab + (e.shiftKey ? 5 : 1)) % 6);
            setSelected(0);
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % (rows.length || 1));
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            choose(selected, e.metaKey || e.ctrlKey);
          }
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: 16,
            borderBottom: `1px solid ${c.separator}`,
          }}
        >
          <Icon name="search" />
          <input
            autoFocus
            data-testid="command-query"
            aria-label={t('client.searchPlaceholder')}
            placeholder={t('client.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-controls="command-results"
            aria-expanded="true"
            aria-activedescendant={rows[selected] ? `command-${selected}` : undefined}
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', color: c.label }}
          />
          <button onClick={close} style={{ border: 0, color: c.secondaryLabel, background: 'transparent' }}>
            esc
          </button>
        </div>
        <div role="tablist" style={{ display: 'flex', gap: 6, padding: 12 }}>
          {categories.map((label, i) => (
            <button
              key={label}
              role="tab"
              aria-selected={tab === i}
              onClick={() => {
                setTab(i);
                setSelected(0);
              }}
              style={{
                border: 0,
                borderRadius: 20,
                padding: '5px 10px',
                background: tab === i ? c.accentFill : c.tertiaryFill,
                color: tab === i ? c.accentText : c.secondaryLabel,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div id="command-results" role="listbox" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 4 }}>
          {rows.map((row, i) => (
            <button
              id={`command-${i}`}
              key={row.key}
              role="option"
              aria-selected={selected === i}
              onClick={(e) => choose(i, e.metaKey || e.ctrlKey)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                textAlign: 'left',
                border: 0,
                borderRadius: 8,
                padding: '10px 12px',
                gap: 12,
                background: selected === i ? c.sidebarSelection : 'transparent',
                color: c.label,
              }}
            >
              <Icon name={row.icon} size={18} color={c.secondaryLabel} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{row.title}</strong>
                {row.subtitle ? (
                  <small
                    style={{
                      display: 'block',
                      color: c.secondaryLabel,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.subtitle}
                  </small>
                ) : null}
              </span>
              <small>{row.shortcut ?? (i === selected ? 'Enter' : '')}</small>
            </button>
          ))}
          {loading ? (
            <p role="status">{t('common.loading')}</p>
          ) : failed ? (
            <p role="alert">{t('client.searchFailed')}</p>
          ) : !rows.length ? (
            <p>{t('common.noMatches')}</p>
          ) : null}
        </div>
        <footer style={{ padding: 12, borderTop: `1px solid ${c.separator}`, color: c.secondaryLabel }}>
          ↑ ↓ · Enter · ⌘ Enter · Tab
        </footer>
      </div>
    </Overlay>
  );
}
