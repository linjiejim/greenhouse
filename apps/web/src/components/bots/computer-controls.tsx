/**
 * Controls under the live screen.
 *
 * - `ComputerWatchBar` — view-only: one clear way in ("Take over").
 * - `ComputerControlBar` — the member holds the lease: elapsed time, the
 *   typing helpers and one big "Done, hand back" (with an optional note the
 *   waiting Bot reads when it resumes).
 * - Both carry "Back to the browser": a minimised or closed browser window
 *   comes back on screen (it needs no lease — the server restores it).
 * - `ComputerTypePanel` — the IME-safe keyboard: text goes to the server, which
 *   inserts it into the focused field over CDP. Raw VNC key events cannot carry
 *   Chinese input or a pasted password, and a phone has no keyboard for the
 *   canvas at all. The value is never echoed, stored or logged; the field is
 *   cleared as soon as it is sent.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Input, Spinner } from '../ui';
import { AppWindow, Check, CheckCircle2, ClipboardList, Eye, EyeOff, LogIn, Type } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import type { RfbHelperKey } from '../../lib/novnc/types';

/** "4:05" under an hour, "1:02:03" after. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function useElapsed(since: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const start = since ? Date.parse(since) : NaN;
  return formatElapsed(Number.isNaN(start) ? 0 : now - start);
}

/** Bring the browser window back on screen (restores a minimised one, or opens a new one). */
export function RestoreWindowButton({ busy, onRestore }: { busy: boolean; onRestore: () => void }) {
  const t = useT();
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onRestore}
      disabled={busy}
      title={t('botsComputer.restoreWindowHint')}
      data-testid="computer-restore-window"
    >
      {busy ? <Spinner className="mr-1" /> : <AppWindow size={14} className="mr-1" aria-hidden="true" />}
      {t('botsComputer.restoreWindow')}
    </Button>
  );
}

interface RestoreProps {
  restoring: boolean;
  onRestoreWindow: () => void;
}

export function ComputerWatchBar({
  busy,
  onTakeOver,
  restoring,
  onRestoreWindow,
}: { busy: boolean; onTakeOver: () => void } & RestoreProps) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={t('botsComputer.watching')}>
        {t('botsComputer.watching')}
      </span>
      <RestoreWindowButton busy={restoring} onRestore={onRestoreWindow} />
      <Button size="sm" onClick={onTakeOver} disabled={busy} data-testid="computer-take-over">
        {busy ? <Spinner className="mr-1" /> : <LogIn size={14} className="mr-1" aria-hidden="true" />}
        {t('botsComputer.takeOver')}
      </Button>
    </div>
  );
}

interface ControlBarProps extends RestoreProps {
  since: string | null;
  busy: boolean;
  typeOpen: boolean;
  pasting: boolean;
  onToggleType: () => void;
  onPaste: () => void;
  onHandBack: (note: string) => void;
  /** Rendered between the toolbar row and the note (the typing panel). */
  children?: React.ReactNode;
}

export function ComputerControlBar({
  since,
  busy,
  typeOpen,
  pasting,
  onToggleType,
  onPaste,
  onHandBack,
  restoring,
  onRestoreWindow,
  children,
}: ControlBarProps) {
  const t = useT();
  const elapsed = useElapsed(since);
  const [note, setNote] = useState('');

  return (
    <div className="space-y-2.5" data-testid="computer-control-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs font-medium text-primary-fg-strong" aria-live="off">
          {t('botsComputer.inControlFor', { time: elapsed })}
        </span>
        <Button size="sm" variant={typeOpen ? 'secondary' : 'outline'} onClick={onToggleType} aria-pressed={typeOpen}>
          <Type size={14} className="mr-1" aria-hidden="true" />
          {t('botsComputer.typeText')}
        </Button>
        <Button size="sm" variant="outline" onClick={onPaste} disabled={pasting}>
          {pasting ? <Spinner className="mr-1" /> : <ClipboardList size={14} className="mr-1" aria-hidden="true" />}
          {t('botsComputer.paste')}
        </Button>
        <RestoreWindowButton busy={restoring} onRestore={onRestoreWindow} />
      </div>
      {children}
      <Input
        size="sm"
        value={note}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t('botsComputer.handBackNotePlaceholder')}
        aria-label={t('botsComputer.handBackNote')}
      />
      <Button
        size="lg"
        className="w-full"
        onClick={() => onHandBack(note)}
        disabled={busy}
        data-testid="computer-hand-back"
      >
        {busy ? <Spinner className="mr-2" /> : <CheckCircle2 size={18} className="mr-2" aria-hidden="true" />}
        {t('botsComputer.handBack')}
      </Button>
    </div>
  );
}

const HELPER_KEYS: Array<{ key: RfbHelperKey; label: TranslationKey }> = [
  { key: 'enter', label: 'botsComputer.key_enter' },
  { key: 'tab', label: 'botsComputer.key_tab' },
  { key: 'backspace', label: 'botsComputer.key_backspace' },
  { key: 'escape', label: 'botsComputer.key_escape' },
];

interface TypePanelProps {
  /** Start masked (paste fallback, where the content is likely a password). */
  initiallyMasked: boolean;
  /** Explain that the clipboard could not be read and the member should paste here. */
  pasteFallback: boolean;
  /** Resolves true when the text reached the computer (the field is then cleared). */
  onSubmit: (text: string) => Promise<boolean>;
  onKey: (key: RfbHelperKey) => void;
}

export function ComputerTypePanel({ initiallyMasked, pasteFallback, onSubmit, onKey }: TypePanelProps) {
  const t = useT();
  // ui.tsx Input takes no ref; the form wrapper finds its one input.
  const formRef = useRef<HTMLFormElement>(null);
  const focusInput = () => formRef.current?.querySelector('input')?.focus();
  const [value, setValue] = useState('');
  const [masked, setMasked] = useState(initiallyMasked);
  const [sending, setSending] = useState(false);
  // A quiet "typed" tick instead of a toast per line — the screen shows the result anyway.
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setSent(false), 2000);
    return () => window.clearTimeout(timer);
  }, [sent]);

  useEffect(() => {
    setMasked(initiallyMasked);
    formRef.current?.querySelector('input')?.focus();
  }, [initiallyMasked, pasteFallback]);

  const submit = async () => {
    if (!value || sending) return;
    setSending(true);
    const ok = await onSubmit(value);
    setSending(false);
    if (ok) {
      setValue('');
      setSent(true);
    }
    focusInput();
  };

  return (
    <div className="space-y-2 rounded-lg border border-edge bg-surface-card p-2.5" data-testid="computer-type-panel">
      <form
        ref={formRef}
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          size="sm"
          type={masked ? 'password' : 'text'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter that confirms an IME composition (Chinese candidates) must
            // not submit half-composed text.
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          placeholder={t('botsComputer.typePlaceholder')}
          aria-label={t('botsComputer.typePlaceholder')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          // Keep password managers from offering to save what is typed here.
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          className="flex-1"
        />
        <IconButton
          label={masked ? t('botsComputer.showText') : t('botsComputer.hideText')}
          size="compact"
          onClick={() => setMasked((m) => !m)}
          aria-pressed={!masked}
        >
          {masked ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <Button size="sm" type="submit" disabled={!value || sending} data-testid="computer-type-send">
          {sending && <Spinner className="mr-1" />}
          {t('botsComputer.typeSend')}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-fg-faint">{t('botsComputer.keysLabel')}</span>
        {HELPER_KEYS.map(({ key, label }) => (
          <Button key={key} size="sm" variant="ghost" className="border border-edge" onClick={() => onKey(key)}>
            {t(label)}
          </Button>
        ))}
        {sent && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-success" role="status">
            <Check size={12} aria-hidden="true" />
            {t('botsComputer.typeSentShort')}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-4 text-fg-faint">
        {pasteFallback ? t('botsComputer.pasteFallback') : t('botsComputer.typeHelp')}
      </p>
    </div>
  );
}
