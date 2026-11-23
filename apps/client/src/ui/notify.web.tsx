/**
 * Browser notices (DESIGN.md States and feedback): one stack, newest first, at most three. Wide
 * windows put it top right (the desktop app below its 52 title bar, clear of the bar's buttons);
 * phones put it at the top, full width, below the safe area. success/info fade after 4 s, warning
 * 6 s, undo 8 s with its action, and info with an action 8 s too (「已更新到 4.5.0 · 查看更新内容」);
 * an error stays until dismissed and may offer Retry and Details.
 * Every notice has ✕ in its top-right corner, on its first line, so one covering a header's actions
 * clears with a click. Hover pauses the timers. Copy is one sentence naming the object ("已归档 3 个
 * 项目"), never "操作成功"; a copy to the clipboard is never a notice (the button answers, ./use-copy).
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Icon, type IconName } from './core.web';
import { showErrorDetails } from './dialogs.web';
import { recordError } from '../feedback/last-error';
import { translate } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import type { NotifyApi, NotifyKind, NotifyOptions } from './notify-types';

interface Notice extends NotifyOptions {
  id: number;
  kind: NotifyKind;
  text: string;
}

export const NOTICE_MS: Record<NotifyKind, number | null> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  undo: 8000,
  error: null,
};

let sequence = 0;
const useNotices = create<{ list: Notice[] }>(() => ({ list: [] }));

function show(kind: NotifyKind, text: string, options: NotifyOptions = {}): () => void {
  const id = ++sequence;
  if (kind === 'error') recordError(text, options.body ?? options.detail);
  const next = [{ id, kind, text, ...options }, ...useNotices.getState().list];
  useNotices.setState({ list: next.slice(0, 3) });
  // a notice pushed off the stack ends like a dismissed one
  for (const evicted of next.slice(3)) evicted.onDismiss?.();
  return () => dismiss(id);
}

function dismiss(id: number) {
  const gone = useNotices.getState().list.find((n) => n.id === id);
  useNotices.setState((s) => ({ list: s.list.filter((n) => n.id !== id) }));
  gone?.onDismiss?.();
}

export const notify: NotifyApi = Object.assign(
  (text: string, options?: NotifyOptions) => show('success', text, options),
  {
    success: (text: string, options?: NotifyOptions) => show('success', text, options),
    info: (text: string, options?: NotifyOptions) => show('info', text, options),
    warning: (text: string, options?: NotifyOptions) => show('warning', text, options),
    undo: (text: string, onUndo: () => void, options?: NotifyOptions) =>
      show('undo', text, { ...options, action: { label: tr('common.undo'), onPress: onUndo } }),
    error: (text: string, options?: NotifyOptions) => show('error', text, options),
  },
);

function tr(key: 'common.undo' | 'common.close' | 'common.details') {
  return translate(usePrefs.getState().lang, key);
}

const ICON: Record<NotifyKind, IconName> = {
  success: 'checkCircle',
  info: 'alertCircle',
  warning: 'alert',
  undo: 'checkCircle',
  error: 'alertCircle',
};

/** Info with an action stays as long as Undo, so the action can be reached (jim-uiux 1.7.0). */
const INFO_ACTION_MS = 8000;

function NoticeRow({ notice, paused }: { notice: Notice; paused: boolean }) {
  const ms = notice.kind === 'info' && notice.action ? INFO_ACTION_MS : NOTICE_MS[notice.kind];
  const left = useRef(ms ?? 0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (ms === null || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(notice.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(800, left.current - (Date.now() - started));
      tick((n) => n + 1);
    };
  }, [ms, paused, notice.id]);
  return (
    <div className="gh-notice" data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span className="gh-notice-icon" data-kind={notice.kind}>
        <Icon name={ICON[notice.kind]} size={16} />
      </span>
      <span className="gh-notice-text">
        {notice.text}
        {notice.body ? <span className="gh-notice-body">{notice.body}</span> : null}
      </span>
      {notice.action ? (
        <button
          type="button"
          className="gh-link-button"
          onClick={() => {
            useNotices.setState((s) => ({ list: s.list.filter((n) => n.id !== notice.id) }));
            notice.action?.onPress();
          }}
        >
          {notice.action.label}
        </button>
      ) : null}
      {notice.detail ? (
        <button type="button" className="gh-link-button" onClick={() => showErrorDetails(notice.detail ?? '')}>
          {tr('common.details')}
        </button>
      ) : null}
      <button
        type="button"
        className="gh-icon-button gh-notice-close"
        aria-label={tr('common.close')}
        onClick={() => dismiss(notice.id)}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

export function NotifyHost() {
  const list = useNotices((s) => s.list);
  const [paused, setPaused] = useState(false);
  // the last hovered notice can leave without a mouseleave: the next ones must still time out
  useEffect(() => {
    if (!list.length) setPaused(false);
  }, [list.length]);
  if (typeof document === 'undefined' || !list.length) return null;
  return createPortal(
    <div
      className="gh-notices"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {list.map((notice) => (
        <NoticeRow key={notice.id} notice={notice} paused={paused && list.length > 0} />
      ))}
    </div>,
    document.body,
  );
}
