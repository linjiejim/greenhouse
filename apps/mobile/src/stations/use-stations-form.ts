/**
 * The behaviour behind the stations screen on both platforms
 * (./stations-form.tsx — SwiftUI, ./stations-form.android.tsx — Material):
 * the saved stations, which one is active, and the three changes —
 *
 *  - `select` — tap a station: the active one just closes (`onDone`); any
 *    other is probed before dismissal; a failed probe keeps the current station,
 *  - `remove` — confirmed with a destructive alert; the station first stops
 *    pushing to this phone (src/push/register.ts, best effort),
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { IS_SINGLE_STATION } from '../config';
import { normalizeBaseUrl, probeStation, useStations, type StationRecord } from '../store/stations';
import { AFTER_DISMISS_MS, useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import { unregisterActive, unregisterStation } from '../push/register';

export function useStationsForm({ onDone, onLeave }: { onDone: () => void; onLeave: () => void }) {
  const t = useT();
  const stations = useStations((s) => s.stations);
  const activeId = useStations((s) => s.activeId);
  const locked = IS_SINGLE_STATION;
  const active = stations.find((s) => s.id === activeId) ?? null;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setPending = useCallback((value: boolean) => {
    pending.current = value;
    setBusy(value);
  }, []);

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
    async (station: StationRecord) => {
      if (pending.current) return;
      if (station.id === activeId) {
        onDone();
        return;
      }
      setPending(true);
      const probe = await probeStation(station.baseUrl);
      if (!mounted.current) return;
      if (!probe.ok || probe.authEnabled === false) {
        setPending(false);
        alertError(
          t('station.switchFailed'),
          t(probe.authEnabled === false ? 'station.authDisabled' : 'station.unreachable'),
        );
        return;
      }
      leaveThen(() => useStations.getState().switchTo(station.id));
    },
    [activeId, onDone, leaveThen, setPending, t],
  );

  const remove = useCallback(
    async (station: StationRecord) => {
      if (pending.current) return;
      setPending(true);
      const ok = await confirmAction({
        title: t('station.deleteTitle'),
        message: t('station.deleteHint', { name: station.name }),
        confirmLabel: t('station.delete'),
        destructive: true,
      });
      if (!ok) {
        setPending(false);
        return;
      }
      // Removing the active station changes where the app points — leave first. Either
      // way the station stops pushing to this phone first (best effort, its own session).
      if (station.id === activeId) {
        const unregistered = unregisterActive();
        leaveThen(() => unregistered.then(() => useStations.getState().remove(station.id)));
      } else {
        try {
          await unregisterStation(station).catch(() => undefined);
          await useStations.getState().remove(station.id);
        } catch {
          alertError(t('common.error'));
        } finally {
          setPending(false);
        }
      }
    },
    [activeId, leaveThen, setPending, t],
  );

  /** Validate, probe and save a typed address (+ optional name) as the active station. */
  const add = useCallback(
    async (rawUrl: string, rawName: string) => {
      if (pending.current) return;
      const baseUrl = normalizeBaseUrl(rawUrl);
      if (!baseUrl) {
        alertError(t('station.addFailed'), t('station.invalidUrl'));
        return;
      }
      setPending(true);
      const probe = await probeStation(baseUrl);
      if (!mounted.current) return;
      if (!probe.ok) {
        setPending(false);
        alertError(t('station.addFailed'), t('station.unreachable'));
        return;
      }
      if (probe.authEnabled === false) {
        setPending(false);
        alertError(t('station.addFailed'), t('station.authDisabled'));
        return;
      }
      // A duplicate origin just switches to the saved entry (store rule).
      const label = rawName.trim() || probe.productName;
      leaveThen(() => useStations.getState().add(baseUrl, label || undefined));
    },
    [t, leaveThen, setPending],
  );

  return { stations, activeId, active, locked, busy, select, remove, add };
}
