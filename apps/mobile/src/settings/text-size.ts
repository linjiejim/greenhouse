/**
 * The in-app text size follows the account where the station keeps it
 * (`GET / PATCH /api/me/preferences` `{ fontScale }`, the multiplier 0.9–1.35). Until a station
 * has that endpoint (404) the size stays on this phone only; nothing is reported. Run by the root
 * layout: when the signed-in member loads, the account's size (if any) replaces the phone's.
 */

import { useEffect } from 'react';
import { get, patch } from '../api/client';
import { captureIdentity } from '../data/identity';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useStations } from '../store/stations';
import { TEXT_STEPS, textStepOf, type TextStep } from '../theme/type-scale';

interface Preferences {
  fontScale?: number | null;
}

/** Stations known to lack the endpoint, so a change is not sent again and again. */
const unsupported = new Set<string>();

export function useAccountTextSize(): void {
  const member = useAuth((s) => s.user?.id);
  const station = useStations((s) => s.activeId);
  const hydrated = usePrefs((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated || !member || !station || unsupported.has(station)) return;
    const current = captureIdentity();
    void get<Preferences>('/api/me/preferences').then((result) => {
      if (!current()) return;
      if (!result.ok) {
        if (result.status === 404) unsupported.add(station);
        return;
      }
      if (typeof result.data.fontScale === 'number') usePrefs.getState().setTextStep(textStepOf(result.data.fontScale));
    });
  }, [hydrated, member, station]);
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** Change the size now, then save it to the account (the last choice within a moment wins). */
export function chooseTextSize(step: TextStep): void {
  usePrefs.getState().setTextStep(step);
  const station = useStations.getState().activeId;
  if (!station || !useAuth.getState().user || unsupported.has(station)) return;
  if (pending) clearTimeout(pending);
  const current = captureIdentity();
  pending = setTimeout(() => {
    pending = null;
    if (!current()) return;
    void patch<Preferences>('/api/me/preferences', { fontScale: TEXT_STEPS[step] }).then((result) => {
      if (!result.ok && result.status === 404) unsupported.add(station);
    });
  }, 600);
}
