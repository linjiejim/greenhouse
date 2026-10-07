/**
 * The behaviour behind the stations screen on both platforms
 * (./stations-form.tsx — SwiftUI, ./stations-form.android.tsx — Material):
 * the saved stations, which one is active, and the three changes —
 *
 *  - `select` — tap a station: the active one just closes (`onDone`); any
 *    other becomes active,
 *  - `remove` — confirmed with a destructive alert,
 *  - `add` — validates the address (`normalizeBaseUrl`), probes it (is there a
 *    Greenhouse API? `probeStation`), then saves it as the active station
 *    (with no name typed, the server's own product name beats the bare host);
 *    failures are system alerts.
 *
 * Every change of the active station goes through `auth.switchStation()`
 * (raises `loading` in the same tick as the change, so no screen or Bots
 * request runs against the new station with the old one's session, then
 * rehydrates that station's tokens and revalidates; the root layout then
 * routes home or to /login) — after the host is dismissed (`onLeave`), so the
 * reroute never happens under a presented sheet.
 */

import { useCallback, useState } from 'react';
import { IS_SINGLE_STATION } from '../config';
import { normalizeBaseUrl, probeStation, useStations, type StationRecord } from '../store/stations';
import { AFTER_DISMISS_MS, useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';

export function useStationsForm({ onDone, onLeave }: { onDone: () => void; onLeave: () => void }) {
  const t = useT();
  const stations = useStations((s) => s.stations);
  const activeId = useStations((s) => s.activeId);
  const locked = IS_SINGLE_STATION;
  const active = stations.find((s) => s.id === activeId) ?? null;
  const [busy, setBusy] = useState(false);

  /** Dismiss, then mutate the registry and sign in to the new active station. */
  const leaveThen = useCallback(
    (mutate: () => Promise<unknown>) => {
      onLeave();
      setTimeout(() => {
        void useAuth.getState().switchStation(mutate);
      }, AFTER_DISMISS_MS);
    },
    [onLeave],
  );

  const select = useCallback(
    (station: StationRecord) => {
      if (station.id === activeId) onDone();
      else leaveThen(() => useStations.getState().switchTo(station.id));
    },
    [activeId, onDone, leaveThen],
  );

  const remove = useCallback(
    async (station: StationRecord) => {
      const ok = await confirmAction({
        title: t('station.deleteTitle'),
        message: t('station.deleteHint', { name: station.name }),
        confirmLabel: t('station.delete'),
        destructive: true,
      });
      if (!ok) return;
      // Removing the active station changes where the app points — leave first.
      if (station.id === activeId) leaveThen(() => useStations.getState().remove(station.id));
      else void useStations.getState().remove(station.id);
    },
    [activeId, leaveThen, t],
  );

  /** Validate, probe and save a typed address (+ optional name) as the active station. */
  const add = useCallback(
    async (rawUrl: string, rawName: string) => {
      if (busy) return;
      const baseUrl = normalizeBaseUrl(rawUrl);
      if (!baseUrl) {
        alertError(t('station.addFailed'), t('station.invalidUrl'));
        return;
      }
      setBusy(true);
      const probe = await probeStation(baseUrl);
      setBusy(false);
      if (!probe.ok) {
        alertError(t('station.addFailed'), t('station.unreachable'));
        return;
      }
      if (probe.authEnabled === false) {
        alertError(t('station.addFailed'), t('station.authDisabled'));
        return;
      }
      // A duplicate origin just switches to the saved entry (store rule).
      const label = rawName.trim() || probe.productName;
      leaveThen(() => useStations.getState().add(baseUrl, label || undefined));
    },
    [busy, t, leaveThen],
  );

  return { stations, activeId, active, locked, busy, select, remove, add };
}
