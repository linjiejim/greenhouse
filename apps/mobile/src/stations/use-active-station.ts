/**
 * Active station record (reactive) — for the rows that show which server the
 * app is on (login server row, settings, the drawer's account row).
 */

import { useStations, type StationRecord } from '../store/stations';

export function useActiveStation(): StationRecord | null {
  const stations = useStations((s) => s.stations);
  const activeId = useStations((s) => s.activeId);
  return stations.find((s) => s.id === activeId) ?? null;
}
