/** React hooks — live views of the station registry / active session. */

import { useEffect, useState } from 'react';
import { getStations, onStationsChange, type Station, type StationsState, type StoredAuth } from './storage';

const EMPTY: StationsState = { stations: [], activeId: null };

/** Full registry — for the options manager and the panel's station menu. */
export function useStations(): { state: StationsState; loading: boolean } {
  const [state, setState] = useState<StationsState>(EMPTY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    getStations().then((s) => {
      if (mounted) {
        setState(s);
        setLoading(false);
      }
    });
    const off = onStationsChange((s) => setState(s));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return { state, loading };
}

/**
 * Active station + its session. `station` without `auth` ⇒ signed out (the
 * panel shows the sign-in-needed state instead of "not connected").
 */
export function useAuth(): { auth: StoredAuth | null; station: Station | null; loading: boolean } {
  const { state, loading } = useStations();
  const station = state.stations.find((s) => s.id === state.activeId) ?? null;
  const auth = station?.auth ? { stationId: station.id, baseUrl: station.baseUrl, ...station.auth } : null;
  return { auth, station, loading };
}
