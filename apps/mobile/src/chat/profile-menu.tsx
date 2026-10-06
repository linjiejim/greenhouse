/**
 * Agent-profile picker — a small glass capsule above the composer of a NEW
 * conversation ("Sprouty ⌃⌄") that opens a native menu of the agents from
 * GET /api/profiles, with a checkmark on the current pick. The pick lives in
 * prefs and binds to the next session created (existing sessions keep theirs).
 *
 * Also the agent catalog's one home for the rest of the app (settings' default
 * agent picker): `useProfiles()` (cached per app run, refreshed in the
 * background whenever a picker mounts), `effectiveProfile()` (which agent a
 * new conversation will actually get) and `profileLabel()` (the localized
 * name, marked when it's a custom agent).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { listProfiles, type Profile } from '../api/sessions';
import { usePrefs, type LangPref } from '../store/prefs';
import { useT } from '../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { Icon } from '../ui/core';
import { Glass } from '../ui/glass';
import { NativeMenu, type MenuItem } from '../ui/menu';

let cache: LocalizedProfile[] | null = null;
let inflight: Promise<LocalizedProfile[]> | null = null;

function fetchProfiles(): Promise<LocalizedProfile[]> {
  inflight ??= listProfiles()
    .then((rows) => {
      cache = rows;
      return rows;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The agent catalog (cached; refetched once per mount). */
export function useProfiles(): LocalizedProfile[] | null {
  const [rows, setRows] = useState<LocalizedProfile[] | null>(cache);
  useEffect(() => {
    let alive = true;
    void fetchProfiles().then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, []);
  return rows;
}

/**
 * GET /api/profiles also carries per-locale names for system agents (custom
 * agents never do) — canonical `Profile.name_i18n` in packages/types.
 */
export type LocalizedProfile = Profile & { name_i18n?: Partial<Record<LangPref, string>> };

/** Server's default agent (legacy ids like `default` / `team` normalize to it). */
const SERVER_DEFAULT_PROFILE = 'sprouty';

/**
 * The agent a new conversation will actually get: the stored pick when it's
 * in the catalog, otherwise the server default (mirrors the API's
 * `normalizeProfileId` — the stored id may be the unset `default` or stale,
 * picked on another station), otherwise the first agent.
 */
export function effectiveProfile<P extends Profile>(rows: P[] | null, profileId: string): P | null {
  if (!rows?.length) return null;
  return rows.find((p) => p.id === profileId) ?? rows.find((p) => p.id === SERVER_DEFAULT_PROFILE) ?? rows[0];
}

/** The agent's display name in `lang`, marked " · 自定义" for a custom agent. */
export function profileLabel(p: LocalizedProfile, lang: LangPref, t: ReturnType<typeof useT>): string {
  const name = p.name_i18n?.[lang] || p.name;
  return p.is_custom ? `${name} · ${t('profile.custom')}` : name;
}

export function ProfileMenu() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const profileId = usePrefs((s) => s.profileId);
  const setProfileId = usePrefs((s) => s.setProfileId);
  const rows = useProfiles();
  const current = effectiveProfile(rows, profileId);
  const name = current ? profileLabel(current, lang, t) : undefined;

  const items = useMemo<MenuItem[]>(
    () =>
      (rows ?? []).map((p) => ({
        id: p.id,
        title: profileLabel(p, lang, t),
        checked: p.id === current?.id,
      })),
    [rows, current, lang, t],
  );

  if (!rows?.length) return null;
  return (
    <NativeMenu title={t('profile.hint')} items={items} onSelect={setProfileId}>
      <View accessible accessibilityRole="button" accessibilityLabel={`${t('profile.title')}: ${name ?? ''}`}>
        <Glass interactive style={styles.chip}>
          <Icon name="sparkle" size={13} weight="semibold" color={c.accent} />
          <Text numberOfLines={1} style={styles.name}>
            {name ?? t('profile.title')}
          </Text>
          <Icon name="chevUpDown" size={11} weight="semibold" color={c.secondaryLabel} />
        </Glass>
      </View>
    </NativeMenu>
  );
}

const useStyles = makeStyles((c) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    height: 32,
    paddingHorizontal: space.md,
    borderRadius: 16,
  },
  name: { ...typo.footnote, fontWeight: weight.semibold, color: c.label, maxWidth: 200 },
}));
