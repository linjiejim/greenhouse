/**
 * Which attachment fields of a form are still uploading (`FieldEditor`'s
 * `onBusyChange`). A host disables its submit while any is: a record saved
 * mid-upload lands without the file, and the late id is written into drafts
 * that were already sent (or reset).
 */

import { useCallback, useState } from 'react';

export function usePendingUploads() {
  const [pending, setPending] = useState<ReadonlySet<number>>(() => new Set());

  /** `FieldEditor`'s `onBusyChange` for one field. */
  const busyChange = useCallback(
    (fieldId: number) => (busy: boolean) =>
      setPending((current) => {
        if (busy === current.has(fieldId)) return current;
        const next = new Set(current);
        if (busy) next.add(fieldId);
        else next.delete(fieldId);
        return next;
      }),
    [],
  );

  return { uploading: pending.size > 0, busyChange };
}
