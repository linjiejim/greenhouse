/**
 * The "Run profile" field of the Automations form.
 *
 * An automation runs as its OWNER, and the server checks the pick against the
 * owner on save (scheduler/task-center.ts). So the choices are the owner's:
 * built-in profiles plus the owner's own and team-shared run profiles. For a
 * member's own automation (and every new one) that is the signed-in member's
 * list; when a super edits someone else's automation, the owner's run profiles
 * are loaded from `GET /api/profiles/usable-by/:userId` (super only) — the
 * super's own private profiles are not offered, the owner's are.
 */

import { useEffect, useState } from 'react';
import type { Profile } from '@greenhouse/types/api';
import { Select } from '../components/ui';
import { fetchRunProfilesUsableBy } from '../lib/api';
import { useT } from '../lib/i18n';
import { automationProfileChoices, pinnedProfileVersion } from '../lib/automation-profiles';

interface AutomationProfileSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Every profile the signed-in member sees (system + their own + shared). */
  profiles: readonly Profile[];
  currentUserId: string | undefined;
  /** The automation's owner; undefined for a new automation (the creator owns it). */
  ownerId: string | undefined;
  /** Display name for a stored id, pinned version included. */
  nameOf: (id: string) => string;
}

export function AutomationProfileSelect({
  value,
  onChange,
  profiles,
  currentUserId,
  ownerId,
  nameOf,
}: AutomationProfileSelectProps) {
  const t = useT();
  const forOther = !!ownerId && ownerId !== currentUserId;
  const own = automationProfileChoices(profiles, currentUserId);
  // null while loading; 'error' when the owner's list could not be loaded.
  const [ownerRunProfiles, setOwnerRunProfiles] = useState<Profile[] | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!forOther || !ownerId) return;
    let alive = true;
    setOwnerRunProfiles(null);
    fetchRunProfilesUsableBy(ownerId)
      .then((items) => alive && setOwnerRunProfiles(items))
      // Never fall back to the editor's own profiles: the server would refuse those.
      .catch(() => alive && setOwnerRunProfiles('error'));
    return () => {
      alive = false;
    };
  }, [forOther, ownerId, attempt]);

  const ownerFailed = forOther && ownerRunProfiles === 'error';
  const ownerLoading = forOther && ownerRunProfiles === null;
  const runProfiles = forOther ? (Array.isArray(ownerRunProfiles) ? ownerRunProfiles : []) : own.runProfiles;
  // A stored pin (`custom:<id>@<v>`) keeps showing; picking the profile again re-pins it.
  const pinned = pinnedProfileVersion(value) !== null && !runProfiles.some((p) => p.id === value);

  return (
    <div className="space-y-1">
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <optgroup label={t('automations.systemProfiles')}>
          {own.system.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
        {(runProfiles.length > 0 || pinned) && (
          <optgroup label={t('automations.tabs.profiles')}>
            {pinned && <option value={value}>{nameOf(value)}</option>}
            {runProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      {ownerLoading && <p className="text-xs text-fg-muted">{t('automations.ownerProfilesLoading')}</p>}
      {ownerFailed && (
        <p role="alert" className="text-xs text-danger">
          {t('automations.ownerProfilesFailed')}{' '}
          <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>
            {t('common.retry')}
          </button>
        </p>
      )}
    </div>
  );
}
