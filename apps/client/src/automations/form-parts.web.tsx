/**
 * The pieces both Automations editors share (./editor.web.tsx, ./agent-editor.web.tsx): a labelled
 * field with its count, hint and inline error; a checkbox or switch row; the dialog frame (a
 * fixed-size `lg` dialog, a full-screen sheet below 760 px) with the unsaved-changes guard on ✕,
 * Escape and the scrim, and ⌘/Ctrl+Enter to save.
 */
import './automations.css';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useT } from '../lib/i18n';
import { Icon } from '../ui/core';
import { confirmDiscard } from '../ui/form-guard';
import { DialogBody, Overlay } from '../ui/overlay.web';

/**
 * Fields whose errors may show before a save: the ones edited and then left. A field left by a
 * click shows its error only once that click has landed, so the line it adds never moves the
 * control under the pointer between press and release.
 */
export function useTouched() {
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(new Set<string>());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      // after the click (or key) that moved focus has been handled
      timer = setTimeout(() => {
        if (!pending.current.size) return;
        const fields = [...pending.current];
        pending.current.clear();
        setTouched((current) => new Set([...current, ...fields]));
      }, 0);
    };
    document.addEventListener('pointerup', flush, true);
    document.addEventListener('keyup', flush, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerup', flush, true);
      document.removeEventListener('keyup', flush, true);
    };
  }, []);
  /** Call on blur; `edited` is whether the field differs from where it started. */
  const touch = useCallback((field: string, edited = true) => {
    if (edited) pending.current.add(field);
  }, []);
  return [touched, touch] as const;
}

export function Field({
  label,
  count,
  over,
  hint,
  error,
  children,
}: {
  label: string;
  /** "12 / 4000" beside the label. */
  count?: string;
  over?: boolean;
  hint?: string;
  error?: string | null;
  /** Receives the ids to wire: the control's id and what describes it. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="gh-field">
      <label htmlFor={id}>
        {label}
        {count ? <small data-over={over ? '' : undefined}>{count}</small> : null}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {error ? (
        <p id={errorId} className="gh-error" role="alert">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="gh-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Check({
  label,
  hint,
  checked,
  onChange,
  asSwitch,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  asSwitch?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="gh-check">
      <input
        type="checkbox"
        role={asSwitch ? 'switch' : undefined}
        className={asSwitch ? 'gh-switch' : undefined}
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

/**
 * An editor's dialog. `dirty` arms the discard question on every way out; `onSave` also runs on
 * ⌘/Ctrl+Enter. Below 760 px it covers the window, as a phone sheet. `focus` is the field that
 * takes focus once the dialog opens.
 */
export function EditorDialog({
  title,
  testID,
  dirty,
  busy,
  saveLabel,
  onClose,
  onSave,
  lead,
  focus,
  children,
}: {
  title: string;
  testID: string;
  dirty: boolean;
  busy: boolean;
  saveLabel: string;
  onClose: () => void;
  onSave: () => void;
  /** The footer's leading side: a switch, the save error. */
  lead?: React.ReactNode;
  focus?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const t = useT();
  const { width } = useWindowDimensions();
  const asking = useRef(false);
  useEffect(() => {
    // after the overlay has focused its first control (its effect runs after ours)
    const frame = requestAnimationFrame(() => focus?.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const requestClose = useCallback(async () => {
    if (busy || asking.current) return;
    if (dirty) {
      asking.current = true;
      const discard = await confirmDiscard(t);
      asking.current = false;
      if (!discard) return;
    }
    onClose();
  }, [busy, dirty, onClose, t]);
  return (
    <Overlay
      label={title}
      size="lg"
      testID={testID}
      onClose={() => void requestClose()}
      panelStyle={
        width < 760
          ? {
              position: 'fixed',
              inset: 0,
              width: 'auto',
              height: 'auto',
              maxWidth: 'none',
              maxHeight: 'none',
              borderRadius: 0,
              border: 0,
            }
          : undefined
      }
    >
      <DialogBody
        title={title}
        actions={
          <button
            type="button"
            className="gh-icon-button"
            aria-label={t('common.close')}
            onClick={() => void requestClose()}
          >
            <Icon name="x" size={18} />
          </button>
        }
        footer={
          <>
            <div className="gh-dialog-footer-lead">{lead}</div>
            <button type="button" className="gh-secondary-button" disabled={busy} onClick={() => void requestClose()}>
              {t('common.cancel')}
            </button>
            <button type="button" className="gh-primary" disabled={busy} onClick={onSave}>
              {saveLabel}
            </button>
          </>
        }
      >
        <div
          className="gh-form"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSave();
            }
          }}
        >
          {children}
        </div>
      </DialogBody>
    </Overlay>
  );
}

/** Move focus to the first field that says what is wrong. */
export function focusFirstInvalid(root: ParentNode | null = typeof document === 'undefined' ? null : document) {
  const target = root?.querySelector<HTMLElement>('[role="dialog"] [aria-invalid="true"]');
  target?.focus();
  target?.scrollIntoView?.({ block: 'center' });
}
