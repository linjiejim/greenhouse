/**
 * Home — what a new conversation shows (3.0: Home IS the new conversation), the
 * same screen the iOS app opens on. Top to bottom:
 *
 *   1. the assistant's plant (the selected Agent's, else Sprouty's);
 *   2. a greeting for the hour, with the member's name (`lib/home.ts`);
 *   3. "N waiting for you" — only while unread runtime_attention notifications
 *      exist; it opens the bell;
 *   4. the composer, centred (passed in: the pane owns it);
 *   5. recent conversations, one line each, with "All". They fade while the
 *      composer is focused or holds text, like the phone. How many is a
 *      per-device choice (Settings → Preferences), 0 hides the list.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import { profileAvatarProps } from '../chat/profile-selector';
import { DEFAULT_AGENT_ID } from '../../lib/agent-constants';
import { greetingFor, greetingName, readHomeRecent } from '../../lib/home';
import { relativeTime } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import { Bell, Pin } from '../../lib/icons';
import * as api from '../../lib/api';
import { useAuthStore, useUIStore, useWsStore } from '../../stores';
import { FullHistoryModal } from '../history-modal';

/** Pinned first (in their pinned order), then the newest — the phone's order. */
export function orderRecentConversations(sessions: readonly api.Session[]): api.Session[] {
  const time = (s: api.Session) => {
    const ms = Date.parse(s.updated_at);
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...sessions].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned && (a.pin_sort ?? 0) !== (b.pin_sort ?? 0)) return (a.pin_sort ?? 0) - (b.pin_sort ?? 0);
    return time(b) - time(a);
  });
}

/** Unread notifications that are waiting on this member (a run needs their input / approval). */
function useNeedsYouCount(): number {
  const notificationCount = useWsStore((s) => s.notificationCount);
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (notificationCount === 0) {
      setCount(0);
      return;
    }
    api
      .fetchNotifications({ unreadOnly: true, limit: 100 })
      .then((page) => {
        if (!cancelled) setCount(page.notifications.filter((n) => n.kind === 'runtime_attention').length);
      })
      .catch(() => {
        /* the line simply stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [notificationCount]);
  return count;
}

export function HomeEmptyState({
  profile,
  composer,
  hasText = false,
  showRecent = true,
}: {
  profile?: api.Profile;
  /** The centred composer; omitted on surfaces that keep it at the bottom. */
  composer?: ReactNode;
  hasText?: boolean;
  /** Surfaces with their own suggestions do not list recent conversations. */
  showRecent?: boolean;
}) {
  const t = useT();
  const currentUser = useAuthStore((s) => s.currentUser);
  const openInbox = useUIStore((s) => s.openInbox);
  const sessionListVersion = useUIStore((s) => s.sessionListVersion);
  const needsYou = useNeedsYouCount();
  const [recentCount] = useState(readHomeRecent);
  const [sessions, setSessions] = useState<api.Session[] | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRecent = showRecent && recentCount > 0;

  useEffect(() => {
    if (!listRecent) return;
    let cancelled = false;
    api
      .listSessions('active', false, 50, 'mine')
      .then((rows) => {
        if (!cancelled) setSessions(orderRecentConversations(rows).slice(0, recentCount));
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [listRecent, recentCount, sessionListVersion]);

  const openSession = useCallback((sessionId: string) => {
    window.location.hash = `#/chat?session=${sessionId}`;
  }, []);

  const name = greetingName(currentUser);
  const greeting = t(`home.greeting.${greetingFor(new Date().getHours())}`, { name });
  const quiet = composerFocused || hasText;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-2 py-8 text-center" data-testid="home">
      <PlantAvatar
        {...(profile ? profileAvatarProps(profile) : { avatar: null, stableId: DEFAULT_AGENT_ID })}
        size="xl"
        intro
      />
      <h1 className="text-xl font-semibold text-fg md:text-2xl">{greeting}</h1>
      {needsYou > 0 && (
        <button
          type="button"
          onClick={() => openInbox('notifications')}
          className="inline-flex items-center gap-1.5 rounded-full bg-warning-subtle px-3 py-1 text-xs font-medium text-warning transition-colors hover:opacity-80"
          data-testid="home-needs-you"
        >
          <Bell size={12} aria-hidden="true" />
          {t('home.needsYou', { n: needsYou })}
        </button>
      )}

      {composer && (
        <div
          className="w-full text-left"
          onFocusCapture={() => setComposerFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposerFocused(false);
          }}
        >
          {composer}
        </div>
      )}

      {listRecent && (
        <section
          aria-label={t('home.recent')}
          className={`w-full max-w-2xl px-1 text-left transition-opacity duration-(--gh-duration-base) ${
            quiet ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
          aria-hidden={quiet || undefined}
          data-testid="home-recent"
        >
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-caption font-semibold uppercase tracking-wider text-fg-faint">
              {t('home.recent')}
            </span>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="text-xs text-fg-muted hover:text-fg"
              tabIndex={quiet ? -1 : undefined}
            >
              {t('home.all')}
            </button>
          </div>
          {sessions !== null && sessions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-fg-faint">{t('home.noConversations')}</p>
          ) : (
            <ul className="divide-y divide-edge">
              {(sessions ?? []).map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => openSession(session.id)}
                    tabIndex={quiet ? -1 : undefined}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition-colors hover:bg-surface-muted"
                  >
                    {session.pinned && <Pin size={11} className="flex-shrink-0 text-fg-faint" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate text-sm text-fg-secondary">
                      {session.title || t('common.untitled')}
                    </span>
                    <span className="flex-shrink-0 text-caption tabular-nums text-fg-faint">
                      {relativeTime(session.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <FullHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelectSession={(id) => {
          setHistoryOpen(false);
          openSession(id);
        }}
      />
    </div>
  );
}
