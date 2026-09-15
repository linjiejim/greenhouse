/**
 * Headless desktop-only syncer for the native tray dropdown.
 *
 * Renders nothing; it composes the tray content model (localized labels, the
 * Agent list, recent sessions with running state) from state the main window
 * already tracks — the profile store and the SessionManager's streaming sets —
 * and pushes it to the shell whenever the composed model actually changes.
 * Mounted inside SessionManagerProvider, only in the desktop app.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@greenhouse/types/api';
import { listSessions } from '../../lib/api/sessions';
import { invokeDesktop } from '../../lib/desktop/bridge';
import { buildTrayMenuModel, pushTrayMenu } from '../../lib/desktop/tray-menu';
import type { TrayMenuModel } from '../../lib/desktop/types';
import { useLocalized, useT } from '../../lib/i18n';
import { getLastProfile } from '../../lib/profile-preferences';
import { useSessionManager } from '../../lib/session-manager';
import { useAuthStore, useProfileStore } from '../../stores';

/** A little above the menu's cap so running sessions still surface after sorting. */
const SESSION_FETCH_LIMIT = 20;
/** Relative times in the menu go stale silently; refresh them on a minute tick. */
const CLOCK_TICK_MS = 60_000;

export function DesktopTrayMenuSync() {
  const t = useT();
  const localized = useLocalized();
  const currentUser = useAuthStore((state) => state.currentUser);
  const profiles = useProfileStore((state) => state.profiles);
  const fetchProfiles = useProfileStore((state) => state.fetchProfiles);
  const { activeSessions, remoteStreamingSessions } = useSessionManager();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [openAccelerator, setOpenAccelerator] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const lastPushedRef = useRef<string | null>(null);
  const labelsRef = useRef<TrayMenuModel['labels'] | null>(null);

  const runningIds = useMemo(() => {
    const ids = new Set(remoteStreamingSessions);
    for (const [sessionId, managed] of activeSessions) {
      if (managed.status === 'streaming') ids.add(sessionId);
    }
    return ids;
  }, [activeSessions, remoteStreamingSessions]);
  // Membership key: run start/end should refetch the list, message churn should not.
  const runningKey = useMemo(() => [...runningIds].sort().join(','), [runningIds]);

  useEffect(() => {
    void fetchProfiles();
  }, [fetchProfiles]);

  useEffect(() => {
    let disposed = false;
    const load = () => {
      void listSessions('active', false, SESSION_FETCH_LIMIT).then((next) => {
        if (!disposed) setSessions(next);
      });
      // Re-read on the same beat as the sessions: rebinding the shortcut in
      // Preferences emits no event, and coming back to the window is exactly
      // when a stale accelerator would be noticed.
      void invokeDesktop('desktop_get_settings')
        .then((settings) => {
          if (!disposed) setOpenAccelerator(settings.shortcuts.focus_main ?? null);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener('focus', load);
    const tick = window.setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => {
      disposed = true;
      window.removeEventListener('focus', load);
      window.clearInterval(tick);
    };
  }, [runningKey]);

  useEffect(() => {
    const labels: TrayMenuModel['labels'] = {
      open: t('desktopTray.open'),
      newChat: t('desktopTray.newChat'),
      profiles: t('desktopTray.profiles'),
      sessions: t('desktopTray.sessions'),
      settings: t('desktopTray.settings'),
      quit: t('desktopTray.quit'),
    };
    labelsRef.current = labels;

    const model = buildTrayMenuModel({
      labels,
      openAccelerator,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        label: localized(profile.name_i18n, profile.name),
      })),
      preferredProfileId: getLastProfile(currentUser?.id) ?? getLastProfile(),
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updated_at,
        running: runningIds.has(session.id),
      })),
      now: clock,
      nowLabel: t('desktopTray.now'),
    });

    const serialized = JSON.stringify(model);
    if (serialized === lastPushedRef.current) return;
    lastPushedRef.current = serialized;
    void pushTrayMenu(model);
  }, [clock, currentUser?.id, localized, openAccelerator, profiles, runningIds, sessions, t]);

  // Unmount = logout (the provider tree goes away): clear the data lists so the
  // menu stops advertising this user's sessions. Labels keep their last locale.
  useEffect(
    () => () => {
      const labels = labelsRef.current;
      if (labels) void pushTrayMenu({ labels, openAccelerator: null, profiles: [], sessions: [] });
    },
    [],
  );

  return null;
}
