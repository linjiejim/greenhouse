import React, { useEffect, useRef, useState } from 'react';
import { createSession } from '../api/assistant';
import { sendMessage } from '../chat/send';
import { applyEvent, EMPTY_REPLY } from '../data/chat-stream';
import { captureIdentity } from '../data/identity';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { useT } from '../lib/i18n';
import { useTheme, typo } from '../theme';
import { invoke, reportNativeError } from './native';

/** The same sessions, send transport and stream reducer as the full conversation. */
export function QuickAsk() {
  const user = useAuth((s) => s.user),
    station = useStations((s) => s.activeId);
  const t = useT(),
    { hex: c } = useTheme();
  const [draft, setDraft] = useState(''),
    [reply, setReply] = useState(''),
    [session, setSession] = useState(''),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    abort = useRef<AbortController | null>(null);
  useEffect(() => {
    setReply('');
    setSession('');
    setError('');
    setDraft('');
    setBusy(false);
    pending.current = false;
    return () => abort.current?.abort();
  }, [station, user?.id]);
  const send = async () => {
    if (!draft.trim() || !user || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setReply('');
    setSession('');
    const current = captureIdentity(),
      content = draft.trim();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const created = await createSession();
      if (!current() || controller.signal.aborted) return;
      if (!created.ok) {
        setError(created.message || created.code);
        return;
      }
      setSession(created.data.id);
      setDraft('');
      let live = EMPTY_REPLY;
      const result = await sendMessage(
        created.data.id,
        content,
        (event) => {
          if (!current() || controller.signal.aborted) return;
          live = applyEvent(live, event);
          setReply(live.text);
          if (live.error) setError(live.error);
        },
        controller.signal,
      );
      if (current() && !controller.signal.aborted && !result.ok) {
        setError(result.message || result.code);
        setDraft(content);
      }
    } finally {
      if (current() && !controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section
      style={{
        color: c.label,
        background: c.background,
        height: '100%',
        padding: 20,
        boxSizing: 'border-box',
        ...typo.body,
      }}
    >
      <div data-tauri-drag-region style={{ height: 20, cursor: 'move' }}>
        {t('desktop.quickAsk')}
      </div>
      {!user ? (
        <button onClick={() => void invoke('open_main', { route: '/login' }).catch(reportNativeError)}>
          {t('desktop.signIn')}
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send().catch((e: unknown) => {
              setError(String(e));
              setBusy(false);
              pending.current = false;
            });
          }}
        >
          <textarea
            autoFocus
            aria-label={t('desktop.quickAsk')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            style={{
              width: '100%',
              resize: 'none',
              padding: 12,
              boxSizing: 'border-box',
              borderRadius: 16,
              border: `1px solid ${c.separator}`,
              background: c.secondaryGroupedBackground,
              color: c.label,
              ...typo.body,
            }}
          />
          <button disabled={busy || !draft.trim()} type="submit">
            {busy ? t('common.loading') : t('desktop.send')}
          </button>
        </form>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {reply ? (
        <p
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'pre-wrap',
          }}
        >
          {reply}
        </p>
      ) : null}
      {session ? (
        <button
          onClick={() =>
            void invoke('open_main', { route: `/chat?session=${encodeURIComponent(session)}` }).catch(reportNativeError)
          }
        >
          {t('desktop.openMain')}
        </button>
      ) : null}
    </section>
  );
}
