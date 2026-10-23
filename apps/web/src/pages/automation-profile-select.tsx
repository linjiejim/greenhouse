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
  const [ownerRunProfiles, setOwnerRunProfiles] = useState<Profile[] | null>(null);

  useEffect(() => {
    if (!forOther || !ownerId) return;
    let alive = true;
    setOwnerRunProfiles(null);
    fetchRunProfilesUsableBy(ownerId)
      .then((items) => alive && setOwnerRunProfiles(items))
      // On failure offer none rather than the editor's own: the server would refuse those.
      .catch(() => alive && setOwnerRunProfiles([]));
    return () => {
      alive = false;
    };
  }, [forOther, ownerId]);

  const runProfiles = forOther ? (ownerRunProfiles ?? []) : own.runProfiles;
  // A stored pin (`custom:<id>@<v>`) keeps showing; picking the profile again re-pins it.
  const pinned = pinnedProfileVersion(value) !== null && !runProfiles.some((p) => p.id === value);

  return (
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
  );
}
