/**
 * The in-app text size follows the account (`GET / PATCH /api/me/preferences` `{ fontScale }`,
 * the multiplier 0.8–1.35). Run by the root layout: when the signed-in member loads, the
 * account's size (if any) replaces the phone's — unless the member picked a size while that read
 * was on its way (the pick wins). A failed save keeps the size on this phone; nothing is reported.
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

/** Bumped by every choice on this phone: an account read that started before one is stale. */
let edits = 0;

/** Read the account's size and apply it, unless the member picked one while it was on its way. */
export async function loadAccountTextSize(): Promise<void> {
  const current = captureIdentity();
  const asked = edits;
  const result = await get<Preferences>('/api/me/preferences');
  if (!current() || !result.ok || asked !== edits) return;
  if (typeof result.data.fontScale === 'number') usePrefs.getState().setTextStep(textStepOf(result.data.fontScale));
}

export function useAccountTextSize(): void {
  const member = useAuth((s) => s.user?.id);
  const station = useStations((s) => s.activeId);
  const hydrated = usePrefs((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated || !member || !station) return;
    void loadAccountTextSize();
  }, [hydrated, member, station]);
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** Change the size now, then save it to the account (the last choice within a moment wins). */
export function chooseTextSize(step: TextStep): void {
  edits += 1;
  usePrefs.getState().setTextStep(step);
  if (!useStations.getState().activeId || !useAuth.getState().user) return;
  if (pending) clearTimeout(pending);
  const current = captureIdentity();
  pending = setTimeout(() => {
    pending = null;
    if (!current()) return;
    void patch<Preferences>('/api/me/preferences', { fontScale: TEXT_STEPS[step] });
  }, 600);
}
