import { useCallback, useEffect, useState } from 'react';
import { getRuntimeSummary } from '../lib/api/runtime';
import { onRuntimeInvalidated } from '../lib/runtime-invalidation';

/** Global navigation badge; only counts Interrupts assigned to the current user. */
export function useRuntimeAttentionCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    if (!enabled) {
      setCount(0);
      return;
    }
    try {
      const summary = await getRuntimeSummary({ scope: 'own' });
      setCount(summary.pending_interrupts);
    } catch {
      // Navigation stays usable while the read model is disabled or reconciling.
    }
  }, [enabled]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => onRuntimeInvalidated(() => void load()), [load]);
  return count;
}
