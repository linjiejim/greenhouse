import { BrandText as Text } from './brand-text.android';
/**
 * Dialogs as promises — Android: Material 3 dialogs (Jetpack Compose
 * `AlertDialog`: rounded container, sentence-case text buttons, error-colored
 * destructive action), not the app theme's AppCompat alert. Same API and
 * feedback policy as ./dialogs.ts (iOS: UIAlertController), plus a real
 * `promptText` (a dialog with an outlined text field) — Android has no system
 * prompt. Requests queue up and show one at a time in `DialogHost`, mounted
 * once by the root layout.
 */

import React from 'react';
import { create } from 'zustand';
import { AlertDialog, OutlinedTextField, TextButton, useNativeState } from '@expo/ui/jetpack-compose';
import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers';
import { translate } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { M3Host, useM3 } from './m3';

function tr(key: 'common.cancel' | 'common.ok' | 'common.details'): string {
  return translate(usePrefs.getState().lang, key);
}

type Request = { id: number; title: string; message?: string } & (
  | {
      kind: 'confirm';
      confirmLabel: string;
      cancelLabel?: string;
      destructive?: boolean;
      resolve: (ok: boolean) => void;
    }
  | { kind: 'alert'; detail?: string }
  | {
      kind: 'prompt';
      defaultValue?: string;
      placeholder?: string;
      confirmLabel?: string;
      secure?: boolean;
      resolve: (v: string | null) => void;
    }
);

type RequestInput = Request extends infer R ? (R extends Request ? Omit<R, 'id'> : never) : never;

let nextId = 0;
const useDialogs = create<{ queue: Request[] }>(() => ({ queue: [] }));

function push(request: RequestInput): void {
  const id = ++nextId;
  useDialogs.setState((s) => ({ queue: [...s.queue, { ...request, id } as Request] }));
}

function close(id: number): void {
  useDialogs.setState((s) => ({ queue: s.queue.filter((r) => r.id !== id) }));
}

export function confirmAction(opts: {
  title: string;
  message?: string;
  confirmLabel: string;
  /** Override the 取消 label (e.g. 继续编辑 for a discard prompt). */
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => push({ kind: 'confirm', ...opts, resolve }));
}

/** Report a failed action: title + optional message, single OK; `detail` (a raw technical reason) behind 详情. */
export function alertError(title: string, message?: string, detail?: string): void {
  push({ kind: 'alert', title, message: message || undefined, detail: detail || undefined });
}

export function promptText(opts: {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** A secret (an API key): the field masks what is typed. */
  secure?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => push({ kind: 'prompt', ...opts, resolve }));
}

/** Shows the queued dialogs one at a time. Mount once, at the root. */
export function DialogHost() {
  const current = useDialogs((s) => s.queue[0]);
  if (!current) return null;
  // the dialog opens its own window — the host itself takes no space
  return (
    <M3Host matchContents style={{ position: 'absolute' }}>
      <Dialog key={current.id} request={current} />
    </M3Host>
  );
}

function Dialog({ request: r }: { request: Request }) {
  const m = useM3();
  const field = useNativeState(r.kind === 'prompt' ? (r.defaultValue ?? '') : '');

  const cancel = () => {
    close(r.id);
    if (r.kind === 'confirm') r.resolve(false);
    else if (r.kind === 'prompt') r.resolve(null);
  };
  const confirm = () => {
    close(r.id);
    if (r.kind === 'confirm') r.resolve(true);
    else if (r.kind === 'prompt') r.resolve((field.get() ?? '').trim() || null);
  };

  const showDetail = () => {
    close(r.id);
    if (r.kind === 'alert' && r.detail) push({ kind: 'alert', title: tr('common.details'), message: r.detail });
  };

  const confirmLabel = r.kind === 'alert' ? tr('common.ok') : (r.confirmLabel ?? tr('common.ok'));
  const cancelLabel = r.kind === 'confirm' ? (r.cancelLabel ?? tr('common.cancel')) : tr('common.cancel');
  const destructive = r.kind === 'confirm' && r.destructive;

  return (
    <AlertDialog onDismissRequest={cancel}>
      <AlertDialog.Title>
        <Text style={{ typography: 'headlineSmall' }}>{r.title}</Text>
      </AlertDialog.Title>
      {r.message || r.kind === 'prompt' ? (
        <AlertDialog.Text>
          {r.kind === 'prompt' ? (
            <OutlinedTextField
              value={field}
              autoFocus
              singleLine
              keyboardOptions={{ imeAction: 'done', ...(r.secure ? { keyboardType: 'password' as const } : null) }}
              {...(r.secure ? { visualTransformation: 'password' as const } : null)}
              keyboardActions={{ onDone: confirm }}
              modifiers={[fillMaxWidth()]}
            >
              {r.message || r.placeholder ? (
                <OutlinedTextField.Label>
                  <Text>{r.message || r.placeholder || ''}</Text>
                </OutlinedTextField.Label>
              ) : null}
            </OutlinedTextField>
          ) : (
            <Text color={m.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>
              {r.message ?? ''}
            </Text>
          )}
        </AlertDialog.Text>
      ) : null}
      <AlertDialog.ConfirmButton>
        <TextButton onClick={confirm}>
          <Text color={destructive ? m.error : m.primary} style={{ typography: 'labelLarge' }}>
            {confirmLabel}
          </Text>
        </TextButton>
      </AlertDialog.ConfirmButton>
      {r.kind !== 'alert' ? (
        <AlertDialog.DismissButton>
          <TextButton onClick={cancel}>
            <Text color={m.primary} style={{ typography: 'labelLarge' }}>
              {cancelLabel}
            </Text>
          </TextButton>
        </AlertDialog.DismissButton>
      ) : r.detail ? (
        <AlertDialog.DismissButton>
          <TextButton onClick={showDetail}>
            <Text color={m.primary} style={{ typography: 'labelLarge' }}>
              {tr('common.details')}
            </Text>
          </TextButton>
        </AlertDialog.DismissButton>
      ) : null}
    </AlertDialog>
  );
}
