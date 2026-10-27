import { useCallback, useState } from 'react';
import type { ApiResult } from '../api/client';
import { captureIdentity } from '../data/identity';
import { useT } from '../lib/i18n';
import { alertError } from '../ui/dialogs';

/**
 * One administrative write at a time, bound to the identity that started it: a refusal says so
 * with alertError (the station's words), a late answer after a station/member switch is dropped.
 */
export function useWrite() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T>(call: () => Promise<ApiResult<T>>, failed: string): Promise<T | null> => {
      const current = captureIdentity();
      setBusy(true);
      const result = await call();
      if (!current()) return null;
      setBusy(false);
      if (!result.ok) {
        alertError(failed, result.message || t('admin.tryAgain'));
        return null;
      }
      // a write that answers nothing still succeeded
      return (result.data ?? true) as T;
    },
    [t],
  );
  return { busy, run };
}
