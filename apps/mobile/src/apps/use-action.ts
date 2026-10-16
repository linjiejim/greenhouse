import { useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { appExecute } from '../api/apps';
import { captureIdentity } from '../data/identity';
import { useT } from '../lib/i18n';
import type { AppAction, AppRuntime, TableRecord } from '../shared/contract';
import { alertError, confirmAction } from '../ui/dialogs';
import { canAct } from './model';

export function useAppAction(runtime: AppRuntime, card: { id: string; table_id: string }, refresh: () => void) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const focused = useIsFocused();
  const active = useRef(focused);
  active.current = focused;
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const pending = useRef(false);
  const execute = async (action: AppAction, record?: TableRecord) => {
    if (pending.current || !canAct(runtime, card.table_id)) return;
    const current = captureIdentity();
    pending.current = true;
    const confirmed = await confirmAction({
      title: action.name,
      message: t('integration.actionConfirm'),
      confirmLabel: action.name,
    });
    if (!confirmed || !current() || !active.current) {
      pending.current = false;
      return;
    }
    setBusy(true);
    const result = await appExecute(runtime.app.id, {
      version: runtime.version,
      card: card.id,
      action: action.id,
      ...(record ? { record_id: record.id, revision: record.revision } : {}),
    });
    pending.current = false;
    if (!current() || !active.current) return;
    setBusy(false);
    if (result.ok) refresh();
    else
      alertError(
        t(
          result.code === 'stale_version'
            ? 'integration.appChanged'
            : result.code === 'stale_revision'
              ? 'work.changed'
              : 'work.saveFailed',
        ),
        undefined,
        result.message,
      );
  };
  return { busy, execute };
}
