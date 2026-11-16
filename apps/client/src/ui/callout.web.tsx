/**
 * A note that stays until its cause is gone (DESIGN.md Components, `.gh-callout`): a value shown only
 * once, a missing setup, and (`danger`) why the action in this dialog failed. The tint and the icon
 * both say the level, the text keeps the body colour; at most one action at its end. A danger note
 * is announced as it appears.
 */
import React from 'react';
import { Icon, type IconName } from './core';

export type CalloutTone = 'warning' | 'info' | 'danger' | 'neutral';

const ICON: Record<CalloutTone, IconName> = {
  warning: 'alert',
  info: 'info',
  danger: 'alertCircle',
  neutral: 'info',
};

const ICON_COLOR: Record<CalloutTone, string> = {
  warning: 'var(--gh-warning)',
  info: 'var(--gh-info)',
  danger: 'var(--gh-danger)',
  neutral: 'var(--gh-secondary)',
};

export function Callout({
  tone = 'warning',
  icon,
  action,
  testID,
  children,
}: {
  tone?: CalloutTone;
  /** Replaces the tone's icon. */
  icon?: IconName;
  action?: React.ReactNode;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="gh-callout" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'} data-testid={testID}>
      <Icon name={icon ?? ICON[tone]} size={16} color={ICON_COLOR[tone]} />
      <div className="gh-callout-text">{children}</div>
      {action}
    </div>
  );
}
