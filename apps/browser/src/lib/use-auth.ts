/** React hook — live view of the stored connection state. */

import { useEffect, useState } from 'react';
import { getAuth, onAuthChange, type StoredAuth } from './storage';

export function useAuth(): { auth: StoredAuth | null; loading: boolean } {
  const [auth, setAuthState] = useState<StoredAuth | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    getAuth().then((a) => {
      if (mounted) {
        setAuthState(a);
        setLoading(false);
      }
    });
    const off = onAuthChange((a) => setAuthState(a));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return { auth, loading };
}
