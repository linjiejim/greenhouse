/**
 * The in-app text size follows the account where the station keeps it
 * (`GET / PATCH /api/me/preferences` `{ fontScale }`, the multiplier 0.8–1.35). Until a station
 * has that endpoint (404) the size stays on this phone only; nothing is reported. Run by the root
 * layout: when the signed-in member loads, the account's size (if any) replaces the phone's —
 * unless the member picked a size while that read was on its way (the pick wins).
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

/** Bumped by every choice on this phone: an account read that started before one is stale. */
let edits = 0;

/** Read the account's size and apply it, unless the member picked one while it was on its way. */
export async function loadAccountTextSize(station: string): Promise<void> {
  if (unsupported.has(station)) return;
  const current = captureIdentity();
  const asked = edits;
  const result = await get<Preferences>('/api/me/preferences');
  if (!current()) return;
  if (!result.ok) {
    if (result.status === 404) unsupported.add(station);
    return;
  }
  if (asked !== edits) return;
  if (typeof result.data.fontScale === 'number') usePrefs.getState().setTextStep(textStepOf(result.data.fontScale));
}

export function useAccountTextSize(): void {
  const member = useAuth((s) => s.user?.id);
  const station = useStations((s) => s.activeId);
  const hydrated = usePrefs((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated || !member || !station) return;
    void loadAccountTextSize(station);
  }, [hydrated, member, station]);
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** Change the size now, then save it to the account (the last choice within a moment wins). */
export function chooseTextSize(step: TextStep): void {
  edits += 1;
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
