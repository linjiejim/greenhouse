/**
 * Chat view — header (profile / history / new chat), selection context card,
 * message list, quick actions and the composer.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Select, Spinner, StatusDot } from '@greenhouse/ui/components/ui';
import { History, Plus, Send, CircleStop, FileText, BookOpen, Sun, Moon, ShieldAlert } from '@greenhouse/ui/lib/icons';
import { setThemeMode } from '@greenhouse/ui/lib/theme';
import { useT } from '@greenhouse/ui/lib/i18n';
import { useChat } from './use-chat';
import { Messages } from './messages';
import { SelectionCard } from './selection-card';
import { useAuth } from '../lib/use-auth';
import { readPageContext, readFullPageText, buildContextHint, type PageContext } from '../lib/page-context';
import { listSessions, fetchProfiles, type BrowserSession, type ProfileOption } from '../lib/sessions';

const PROFILE_KEY = 'preferred-profile';

export function ChatView() {
  const t = useT();
  const { auth } = useAuth();
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [profileId, setProfileId] = useState<string>('team');
  const chat = useChat(profileId);
  const [pageCtx, setPageCtx] = useState<PageContext | null>(null);
  const [ctxEnabled, setCtxEnabled] = useState(true);
  const [input, setInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<BrowserSession[] | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refreshCtx = useCallback(() => {
    readPageContext().then(setPageCtx);
  }, []);

  useEffect(() => {
    refreshCtx();
    const onActivated = () => refreshCtx();
    const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.status === 'complete') refreshCtx();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    window.addEventListener('focus', refreshCtx);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      window.removeEventListener('focus', refreshCtx);
    };
  }, [refreshCtx]);

  useEffect(() => {
    fetchProfiles().then((list) => {
      setProfiles(list);
      chrome.storage.local.get(PROFILE_KEY).then((rec) => {
        const stored = rec[PROFILE_KEY] as string | undefined;
        if (stored && list.some((p) => p.id === stored)) setProfileId(stored);
        else if (!list.some((p) => p.id === 'team') && list[0]) setProfileId(list[0].id);
      });
    });
  }, []);

  const changeProfile = (id: string) => {
    setProfileId(id);
    chrome.storage.local.set({ [PROFILE_KEY]: id });
  };

  const { send } = chat;
  const sendWithContext = useCallback(
    async (text: string, opts: { fullPage?: boolean } = {}) => {
      // Re-read right before send so the freshest selection wins.
      const ctx = await readPageContext();
      setPageCtx(ctx);
      let hint: string | undefined;
      if (ctxEnabled) {
        let fullText: string | null = null;
        if (opts.fullPage && ctx.tabId !== null) fullText = await readFullPageText(ctx.tabId);
        hint = buildContextHint(ctx, fullText);
      }
      void send(text, hint);
    },
    [ctxEnabled, send],
  );

  const submit = () => {
    const text = input.trim();
    if (!text || chat.streaming) return;
    setInput('');
    void sendWithContext(text);
  };

  const openHistory = async () => {
    setHistoryOpen((v) => !v);
    if (!historyOpen) setHistory(await listSessions());
  };

  const isEmpty = chat.messages.length === 0 && !chat.streaming;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2 text-sm">
        <StatusDot color="success" size="sm" />
        <span className="min-w-0 flex-1 truncate font-medium">{chat.title ?? auth?.user.nickname ?? ''}</span>
        <Select size="sm" inline value={profileId} onChange={(e) => changeProfile(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {profiles.length === 0 && <option value={profileId}>{profileId}</option>}
        </Select>
        <ThemeToggle />
        <button
          className="rounded p-1 text-fg-secondary hover:bg-surface-muted"
          title={t('panel.history')}
          onClick={openHistory}
        >
          <History size={16} />
        </button>
        <button
          className="rounded p-1 text-fg-secondary hover:bg-surface-muted"
          title={t('panel.newChat')}
          onClick={() => {
            setHistoryOpen(false);
            chat.newConversation();
          }}
        >
          <Plus size={16} />
        </button>
      </header>

      {historyOpen ? (
        <HistoryList
          history={history}
          onPick={(s) => {
            setHistoryOpen(false);
            void chat.loadSession(s);
          }}
        />
      ) : (
        <>
          <SelectionCard ctx={pageCtx} enabled={ctxEnabled} onEnabledChange={setCtxEnabled} onRefresh={refreshCtx} />

          {isEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-sm text-fg-muted">{t('panel.emptyHint')}</p>
              <button
                className="flex items-center gap-2 rounded-full border border-edge-strong px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-muted"
                onClick={() => void sendWithContext(t('panel.summarizePrompt'), { fullPage: true })}
              >
                <FileText size={13} /> {t('panel.summarizePage')}
              </button>
              <button
                className="flex items-center gap-2 rounded-full border border-edge-strong px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-muted"
                onClick={() => void sendWithContext(t('panel.relatedPrompt'))}
              >
                <BookOpen size={13} /> {t('panel.relatedKnowledge')}
              </button>
            </div>
          ) : (
            <Messages
              messages={chat.messages}
              streaming={chat.streaming}
              onAskUserSubmit={(m) => void sendWithContext(m)}
            />
          )}

          {chat.pendingAction && <ActionConfirmCard action={chat.pendingAction} />}

          {chat.error && (
            <p className="mx-3 mb-1 rounded border border-danger bg-danger-subtle px-2 py-1 text-xs text-danger-fg">
              {chat.error}
            </p>
          )}

          <div className="border-t border-edge p-3">
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={input}
                rows={Math.min(5, Math.max(1, input.split('\n').length))}
                placeholder={pageCtx?.selection && ctxEnabled ? t('panel.askSelection') : t('panel.askAnything')}
                className="max-h-32 flex-1 resize-none rounded-lg border border-edge-strong bg-surface px-3 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-primary-500"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              {chat.streaming ? (
                <button
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge-strong text-danger-fg hover:bg-surface-muted"
                  title={t('panel.stop')}
                  onClick={chat.stop}
                >
                  <CircleStop size={16} />
                </button>
              ) : (
                <button
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-40"
                  title={t('panel.send')}
                  disabled={!input.trim()}
                  onClick={submit}
                >
                  <Send size={15} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Per-action approval gate for browser automation writes (click / type). The
 * target element is highlighted on the page while this card is visible; the
 * executor stays paused until the user answers (or the turn ends → deny).
 */
function ActionConfirmCard({ action }: { action: NonNullable<ReturnType<typeof useChat>['pendingAction']> }) {
  const t = useT();
  const target = action.targetText || '…';
  return (
    <div className="mx-3 mb-2 rounded-lg border border-warning bg-warning-subtle p-3 text-sm">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-warning-fg">
        <ShieldAlert size={14} /> {t('panel.actionConfirmTitle')}
      </p>
      <p className="break-words text-fg">
        {action.toolId === 'browser_type'
          ? t('panel.actionType', { target, text: action.inputText ?? '' })
          : t('panel.actionClick', { target })}
      </p>
      {action.pageUrl && <p className="mt-0.5 truncate text-[11px] text-fg-faint">{action.pageUrl}</p>}
      <div className="mt-2 flex gap-2">
        <button
          className="rounded-md bg-primary-600 px-3 py-1 text-xs font-medium text-white hover:bg-primary-700"
          onClick={() => action.resolve(true)}
        >
          {t('panel.actionAllow')}
        </button>
        <button
          className="rounded-md border border-edge-strong px-3 py-1 text-xs text-fg-secondary hover:bg-surface-muted"
          onClick={() => action.resolve(false)}
        >
          {t('panel.actionDeny')}
        </button>
      </div>
    </div>
  );
}

/** Quick light/dark flip; the options page keeps the full light/dark/system select. */
function ThemeToggle() {
  const t = useT();
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark-theme'));
  return (
    <button
      className="rounded p-1 text-fg-secondary hover:bg-surface-muted"
      title={dark ? t('panel.themeLight') : t('panel.themeDark')}
      onClick={() => {
        const next = !dark;
        setDark(next);
        setThemeMode(next ? 'dark' : 'light');
      }}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

function HistoryList({ history, onPick }: { history: BrowserSession[] | null; onPick: (s: BrowserSession) => void }) {
  const t = useT();
  if (!history) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (history.length === 0) {
    return <p className="flex flex-1 items-center justify-center text-sm text-fg-muted">{t('panel.noHistory')}</p>;
  }
  return (
    <div className="flex-1 overflow-y-auto py-1">
      {history.map((s) => (
        <button
          key={s.id}
          className="flex w-full flex-col gap-0.5 px-4 py-2 text-left hover:bg-surface-muted"
          onClick={() => onPick(s)}
        >
          <span className="truncate text-sm text-fg">{s.title ?? t('panel.untitled')}</span>
          <span className="text-[11px] text-fg-faint">{new Date(s.updated_at).toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}
