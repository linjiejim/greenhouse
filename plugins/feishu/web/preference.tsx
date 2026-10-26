import React, { useEffect, useState } from 'react';
import { Toggle, useT, type CrudFieldRenderProps } from '@greenhouse/web/extension-kit';
import { fetchFeishuBinding } from './api';
export function NotificationPreference({ value, onChange, disabled }: CrudFieldRenderProps) {
  const t = useT();
  const [state, setState] = useState({ available: false, bound: false });
  useEffect(() => {
    void fetchFeishuBinding().then((s) => setState({ available: s.available, bound: s.binding !== null }));
  }, []);
  if (!state.available) return null;
  return (
    <div>
      <label className="flex items-center gap-2">
        <Toggle checked={value === true && state.bound} disabled={disabled || !state.bound} onChange={onChange} />
        <span>{t('ext.feishu.automations.notifyFeishu')}</span>
      </label>
      <p className="text-xs text-fg-muted mt-1">
        {state.bound ? t('ext.feishu.automations.notifyFeishuHint') : t('ext.feishu.automations.notifyFeishuUnbound')}
      </p>
    </div>
  );
}
