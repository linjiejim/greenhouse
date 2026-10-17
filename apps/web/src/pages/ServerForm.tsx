/**
 * The server address of an unlocked desktop app (CLT-05, SET-09), on sign-in and in
 * 设置 → 桌面端. The address must answer /api/bootstrap with a v2 API before it is saved;
 * saving restarts the app into it.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Field, Input } from '@greenhouse/ui/kit';
import type { MessageKey } from '../i18n/zh';
import { checkServer, parseServerAddress, switchServer } from '../lib/desktop';
import { useT } from '../lib/i18n';

type ServerError = 'invalid' | 'insecure' | 'unreachable' | 'not_greenhouse' | 'too_old';

export const SERVER_ERRORS: Record<ServerError, MessageKey> = {
  invalid: 'server.invalid',
  insecure: 'server.insecure',
  unreachable: 'server.unreachable',
  not_greenhouse: 'server.notGreenhouse',
  too_old: 'server.tooOld',
};

export function ServerForm({
  className,
  header,
  initial,
  initialError,
  description,
  submitLabel,
  size = 'md',
  beforeSwitch,
  onCancel,
}: {
  className: string;
  /** What sits above the field (the sign-in card's mark and title). */
  header?: ReactNode;
  initial: string;
  initialError?: ServerError;
  description: string;
  submitLabel: string;
  size?: 'md' | 'lg';
  /** Runs after the address checked out, before the switch (sign out of the old server). */
  beforeSwitch?: () => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(initialError ? t(SERVER_ERRORS[initialError]) : '');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const address = parseServerAddress(value);
    if (!address.ok) return setError(t(SERVER_ERRORS[address.error]));
    setBusy(true);
    setError('');
    const check = await checkServer(address.origin);
    if (!check.ok) {
      setBusy(false);
      return setError(t(SERVER_ERRORS[check.error]));
    }
    try {
      await beforeSwitch?.();
      await switchServer(address.origin);
    } catch {
      setBusy(false);
      setError(t('common.error'));
    }
  };

  return (
    <form className={className} onSubmit={(event) => void submit(event)} noValidate aria-label={t('server.title')}>
      {header}
      <Field label={t('server.address')} description={description} error={error || undefined}>
        <Input
          size={size}
          type="url"
          name="server"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          placeholder="https://greenhouse.example.com"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
          }}
        />
      </Field>
      {size === 'lg' ? (
        <>
          <Button type="submit" kind="primary" size="lg" loading={busy} disabled={!value.trim()}>
            {submitLabel}
          </Button>
          {onCancel && (
            <Button kind="ghost" size="lg" disabled={busy} onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          )}
        </>
      ) : (
        <div className="app-inline-actions">
          <Button type="submit" kind="primary" loading={busy} disabled={!value.trim()}>
            {submitLabel}
          </Button>
          {onCancel && (
            <Button kind="ghost" disabled={busy} onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
