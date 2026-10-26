import React from 'react';
import { Toggle, useT, type CrudFieldRenderProps } from '@greenhouse/web/extension-kit';

export function NotificationPreference({ value, onChange, disabled }: CrudFieldRenderProps) {
  const t = useT();

  return (
    <div>
      <label className="flex items-center gap-2">
        <Toggle checked={value === true} disabled={disabled} onChange={onChange} />
        <span>{t('ext.email.automations.notifyEmail')}</span>
      </label>
      <p className="text-xs text-fg-muted mt-1">{t('ext.email.automations.notifyEmailHint')}</p>
    </div>
  );
}
