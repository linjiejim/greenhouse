/**
 * The Admin place's small browser pieces, on top of the shared place and overlay kit: a section
 * page (place bar, optional toolbar or tabs, scrolling body), fixed-size dialogs, badges, a
 * switch, labelled fields, cards and meters. Styles live in ./admin.css.
 */
import './admin.css';
import React, { useId } from 'react';
import { Place, PlaceEmpty } from '../ui/place.web';
import { DialogBody, Overlay, type DialogSize } from '../ui/overlay.web';
import { Icon, type IconName } from '../ui/core';
import { useT } from '../lib/i18n';
import { usedFraction } from './format';
import type { WorkspaceFlagState } from './types';

export function AdminPage({
  title,
  actions,
  toolbar,
  tabs,
  testID,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  tabs?: React.ReactNode;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <Place title={title} actions={actions}>
      {tabs}
      {toolbar ? <div className="gh-admin-toolbar">{toolbar}</div> : null}
      <div className="gh-place-scroll" data-testid={testID}>
        <div className="gh-admin-body">{children}</div>
      </div>
    </Place>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  items: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="gh-admin-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          role="tab"
          aria-selected={item.value === value}
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const index = items.findIndex((i) => i.value === value);
            const next = items[(index + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]!;
            onChange(next.value);
            (e.currentTarget.parentElement?.children[items.indexOf(next)] as HTMLElement | undefined)?.focus();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
export function Badge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="gh-admin-badge" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="gh-admin-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/** A labelled control; the label names the control for assistive tech. */
export function Field({
  label,
  help,
  error,
  required,
  children,
}: {
  label: string;
  help?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="gh-admin-field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden> *</span> : null}
      </label>
      {children(id)}
      {error ? (
        <small role="alert" data-error>
          {error}
        </small>
      ) : help ? (
        <small>{help}</small>
      ) : null}
    </div>
  );
}

/** A titled card in a section body. */
export function Card({
  title,
  icon,
  hint,
  actions,
  flush,
  testID,
  children,
}: {
  title?: string;
  icon?: IconName;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
  /** The body has no padding (a table fills it). */
  flush?: boolean;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="gh-admin-card" data-testid={testID}>
      {title ? (
        <header>
          {icon ? <Icon name={icon} size={16} /> : null}
          <strong>{title}</strong>
          <span className="gh-admin-card-actions">{actions}</span>
        </header>
      ) : null}
      {hint ? <p className="gh-admin-hint gh-admin-card-hint">{hint}</p> : null}
      <div className={flush ? 'gh-admin-card-flush' : 'gh-admin-card-body'}>{children}</div>
    </section>
  );
}

export function Kpis({ items }: { items: { label: string; value: string; hint?: string; tone?: Tone }[] }) {
  return (
    <div className="gh-admin-kpis">
      {items.map((item) => (
        <div key={item.label} className="gh-admin-kpi" title={item.hint}>
          <small>{item.label}</small>
          <strong data-tone={item.tone}>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

/** Spent (solid) and reserved (light) against a limit. */
export function Meter({
  spent,
  reserved = 0,
  limit,
  label,
}: {
  spent: number;
  reserved?: number;
  limit: number;
  label?: string;
}) {
  const used = usedFraction(spent, limit);
  const held = usedFraction(spent + reserved, limit);
  return (
    <span
      className="gh-admin-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(used, 1) * 100)}
      data-level={used >= 1 ? 'over' : used >= 0.8 ? 'warn' : undefined}
    >
      <span className="gh-admin-meter-held" style={{ width: `${Math.min(held, 1) * 100}%` }} />
      <span className="gh-admin-meter-used" style={{ width: `${Math.min(used, 1) * 100}%` }} />
    </span>
  );
}

/** A relative bar for one row among others (distribution columns). */
export function Bar({ value, max }: { value: number; max: number }) {
  return (
    <span className="gh-admin-meter" aria-hidden>
      <span className="gh-admin-meter-used" style={{ width: `${max > 0 ? Math.max((value / max) * 100, 2) : 0}%` }} />
    </span>
  );
}

/**
 * A centered fixed-size dialog: header with ✕, scrolling body, footer. Put a form's submit
 * button in the footer with `form={formId}`.
 */
export function AdminDialog({
  title,
  size = 'md',
  onClose,
  footer,
  actions,
  testID,
  children,
}: {
  title: string;
  size?: DialogSize;
  onClose: () => void;
  footer?: React.ReactNode;
  actions?: React.ReactNode;
  testID?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Overlay
      label={title}
      size={size}
      onClose={onClose}
      testID={testID}
      panelStyle={size === 'sm' ? { padding: 0 } : undefined}
    >
      <div className="gh-admin-modal">
        <DialogBody
          title={title}
          footer={footer}
          actions={
            <>
              {actions}
              <button type="button" className="gh-icon-button" aria-label={t('common.close')} onClick={onClose}>
                <Icon name="x" size={18} />
              </button>
            </>
          }
        >
          {children}
        </DialogBody>
      </div>
    </Overlay>
  );
}

/** A tinted note (warning by default) with an optional action at its end. */
export function Callout({
  tone = 'warning',
  icon = 'alert',
  action,
  testID,
  children,
}: {
  tone?: 'warning' | 'info' | 'danger';
  icon?: IconName;
  action?: React.ReactNode;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="gh-admin-callout" data-tone={tone} role="status" data-testid={testID}>
      <Icon name={icon} size={16} color={`var(--gh-${tone})`} />
      <div className="gh-admin-callout-text">{children}</div>
      {action}
    </div>
  );
}

/**
 * A boolean workspace switch (`gateway.enabled`, a plugin's on/off setting): the value in effect
 * and where it comes from; true/false stores an override, "drop the override" sends null.
 */
export function FlagSwitch({
  state,
  env,
  label,
  help,
  busy,
  disabled,
  onChange,
  testID,
}: {
  state: WorkspaceFlagState | null;
  env: string;
  label: string;
  help?: string;
  busy?: boolean;
  disabled?: boolean;
  onChange: (next: boolean | null) => void;
  testID?: string;
}) {
  const t = useT();
  return (
    <div className="gh-admin-flag" data-testid={testID}>
      <Switch
        checked={state?.effective === true}
        disabled={!state || busy || disabled}
        label={label}
        onChange={(next) => onChange(next)}
      />
      <div>
        <strong>
          {state?.effective ? t('admin.on') : t('admin.off')}
          {state ? <small>{t(`admin.flag.${state.source}`, { env })}</small> : null}
        </strong>
        {help ? <p className="gh-admin-hint">{help}</p> : null}
      </div>
      {state && state.override !== null ? (
        <button type="button" className="gh-admin-button" disabled={busy} onClick={() => onChange(null)}>
          <Icon name="rotate" size={14} />
          {t('admin.flag.reset', { value: state.fallback ? t('admin.on') : t('admin.off') })}
        </button>
      ) : null}
    </div>
  );
}

/** Loading / failure / empty states inside a section (PlaceEmpty with the section's icon). */
export function SectionState({
  loading,
  error,
  retry,
  icon,
  title,
  message,
  action,
}: {
  loading?: boolean;
  error?: { status: number; message: string } | null;
  retry?: () => void;
  icon?: IconName;
  title?: string;
  message?: string;
  action?: React.ReactNode;
}) {
  const t = useT();
  if (error && !loading)
    return (
      <PlaceEmpty
        error={error.status === 403 ? t('admin.forbidden') : error.message || t('admin.loadFailed')}
        retry={error.status === 403 ? undefined : retry}
      />
    );
  return (
    <PlaceEmpty loading={loading} icon={icon} title={loading ? undefined : title} message={message} action={action} />
  );
}
