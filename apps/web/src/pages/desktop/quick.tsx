/** Compact, keyboard-first launcher behind Cmd/Ctrl+Shift+Space. */

import type { Profile } from '@greenhouse/types/api';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronRight, Plus, Search } from '../../lib/icons';
import { fetchProfilesStrict } from '../../lib/api/profiles';
import { getStoredUser } from '../../lib/auth';
import { invokeDesktop } from '../../lib/desktop/bridge';
import { handOffToMain } from '../../lib/desktop/handoff';
import { requestKnowledgeSearch } from '../../lib/desktop/surface-actions';
import {
  getDesktopSurfacePreferences,
  resolveSurfaceProfiles,
  subscribeDesktopSurfacePreferences,
} from '../../lib/desktop/surface-preferences';
import { getLastProfile } from '../../lib/profile-preferences';
import { useLocalized, useT } from '../../lib/i18n';

interface LauncherAction {
  key: string;
  label: string;
  kind: 'newChat' | 'knowledge' | 'profile';
  profileId?: string;
}

export function DesktopQuickPage() {
  const localized = useLocalized();
  const t = useT();
  const userId = getStoredUser()?.id;
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [quickProfileIds, setQuickProfileIds] = useState(() => getDesktopSurfacePreferences(userId).quickProfileIds);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetchProfilesStrict()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    return subscribeDesktopSurfacePreferences(userId, (next) => setQuickProfileIds(next.quickProfileIds));
  }, [userId]);

  const configuredProfiles = useMemo(
    () => resolveSurfaceProfiles(profiles, quickProfileIds, getLastProfile(userId)),
    [profiles, quickProfileIds, userId],
  );

  const actions = useMemo<LauncherAction[]>(
    () => [
      { key: 'new-chat', label: t('desktop.launcherNewChat'), kind: 'newChat' },
      { key: 'knowledge', label: t('desktop.launcherSearchKnowledge'), kind: 'knowledge' },
      ...configuredProfiles
        .filter((profile) => quickProfileIds.includes(profile.id))
        .map((profile) => ({
          key: `profile:${profile.id}`,
          label: localized(profile.name_i18n, profile.name),
          kind: 'profile' as const,
          profileId: profile.id,
        })),
    ],
    [configuredProfiles, localized, quickProfileIds, t],
  );

  const pullPendingSelection = useCallback(() => {
    void invokeDesktop('desktop_take_pending_selection')
      .then((selection) => {
        if (!selection?.text) return;
        setDraft(selection.text);
        setSource(selection.source === 'clipboard' ? t('desktop.fromClipboard') : t('desktop.fromSelection'));
      })
      .catch(() => {});
    inputRef.current?.focus();
  }, [t]);

  useEffect(() => {
    pullPendingSelection();
    window.addEventListener('focus', pullPendingSelection);
    return () => window.removeEventListener('focus', pullPendingSelection);
  }, [pullPendingSelection]);

  const close = useCallback(() => {
    setDraft('');
    setSource(null);
    setActive(0);
    void invokeDesktop('desktop_hide_quick_window');
  }, []);

  const runAction = useCallback(
    async (action: LauncherAction | undefined) => {
      if (!action || busy) return;
      setBusy(true);
      try {
        const text = draft.trim();
        if (action.kind === 'knowledge') {
          await requestKnowledgeSearch(text);
          await invokeDesktop('desktop_focus_main_window');
        } else {
          await handOffToMain({
            target: 'chat',
            draft: text || undefined,
            autoSend: Boolean(text),
            newConversation: true,
            ...(action.profileId ? { profileId: action.profileId } : {}),
          });
        }
        close();
      } finally {
        setBusy(false);
      }
    },
    [busy, close, draft],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActive((current) => (current + delta + actions.length) % actions.length);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void runAction(actions[active]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, active, close, runAction]);

  return (
    <div className="h-screen w-screen p-1.5">
      <div
        className="flex h-full flex-col overflow-hidden rounded-2xl bg-surface-raised/74 shadow-[0_16px_48px_rgb(0_0_0/0.2)] backdrop-blur-2xl"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-2.5" data-tauri-drag-region>
          <Search size={16} className="shrink-0 text-fg-faint" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('desktop.launcherPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
            autoFocus
          />
          {source && (
            <span className="shrink-0 rounded-md bg-surface-muted px-1.5 py-0.5 text-[10px] text-fg-faint">
              {source}
            </span>
          )}
          <kbd className="shrink-0 text-[10px] text-fg-faint">ESC</kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {actions.map((action, index) => {
            const Icon = action.kind === 'newChat' ? Plus : action.kind === 'knowledge' ? Search : Bot;
            return (
              <button
                key={action.key}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => void runAction(action)}
                disabled={busy}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  active === index
                    ? 'bg-primary-subtle text-primary-fg-strong'
                    : 'text-fg-secondary hover:bg-surface-muted'
                }`}
              >
                <Icon size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                <ChevronRight size={14} className="shrink-0 text-fg-faint" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
