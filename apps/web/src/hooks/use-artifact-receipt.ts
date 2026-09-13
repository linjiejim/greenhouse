import { useCallback, useEffect, useState } from 'react';
import { getArtifactReceipt, type ArtifactReceipt } from '../lib/api/artifact-actions';

export function useArtifactReceipt(actionId: string | undefined) {
  const [receipt, setReceipt] = useState<ArtifactReceipt | null>(null);
  const [loading, setLoading] = useState(!!actionId);

  const refresh = useCallback(async () => {
    if (!actionId) {
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const next = await getArtifactReceipt(actionId);
      setReceipt(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, [actionId]);

  useEffect(() => {
    void refresh().catch(() => setLoading(false));
  }, [refresh]);

  return { receipt, loading, refresh, setReceipt };
}
