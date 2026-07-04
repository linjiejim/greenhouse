/**
 * Profile picker — bottom sheet listing GET /api/profiles. The selection is
 * stored in prefs and applied to the NEXT new conversation (the backend binds
 * profile at session creation; existing sessions keep theirs).
 */

import React, { useEffect, useState } from 'react';
import { FlatList, Keyboard, Text, View } from 'react-native';
import { listProfiles, type Profile } from '../api/sessions';
import { usePrefs } from '../store/prefs';
import { useT } from '../lib/i18n';
import { Icon, Sheet, Skeleton, Tile, Touchable } from '../ui';
import { font, makeStyles, radius, useTheme } from '../theme';

export function ProfileSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const profileId = usePrefs((s) => s.profileId);
  const setProfileId = usePrefs((s) => s.setProfileId);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);

  // Opening the picker should get the composer keyboard out of the way — the
  // sheet is a tap-to-select list, not a text field.
  useEffect(() => {
    if (visible) Keyboard.dismiss();
  }, [visible]);

  useEffect(() => {
    if (!visible || profiles !== null) return;
    let alive = true;
    listProfiles().then((rows) => {
      if (alive) setProfiles(rows);
    });
    return () => {
      alive = false;
    };
  }, [visible, profiles]);

  return (
    <Sheet visible={visible} onClose={onClose} title={t('profile.title')} heightPct={62}>
      {profiles === null ? (
        <View style={{ padding: 16, gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} style={{ height: 64, borderRadius: radius.lg }} />
          ))}
        </View>
      ) : (
        <FlatList
          data={profiles}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          ListHeaderComponent={<Text style={styles.hint}>{t('profile.hint')}</Text>}
          ListEmptyComponent={<Text style={styles.hint}>{t('profile.empty')}</Text>}
          renderItem={({ item }) => {
            const active = item.id === profileId;
            return (
              <Touchable
                haptic="selection"
                onPress={() => {
                  setProfileId(item.id);
                  onClose();
                }}
                pressedStyle={{ opacity: 0.7 }}
                style={[styles.row, active && styles.rowActive]}
              >
                <Tile icon="sparkle" tint={active ? 'accent' : 'muted'} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text numberOfLines={1} style={styles.rowTitle}>
                      {item.name}
                    </Text>
                    {item.is_custom ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{t('profile.custom')}</Text>
                      </View>
                    ) : null}
                  </View>
                  {item.description ? (
                    <Text numberOfLines={1} style={styles.rowDesc}>
                      {item.description}
                    </Text>
                  ) : null}
                  {item.model ? <Text style={styles.rowModel}>{item.model.model}</Text> : null}
                </View>
                {active ? <Icon name="check" size={18} color={c.accent} sw={2.4} /> : null}
              </Touchable>
            );
          }}
        />
      )}
    </Sheet>
  );
}

/** Resolve the display name for the currently selected profile (once loaded). */
export function useProfileName(): string | null {
  const profileId = usePrefs((s) => s.profileId);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    listProfiles().then((rows) => {
      if (!alive) return;
      const hit = rows.find((p) => p.id === profileId);
      setName(hit?.name ?? null);
    });
    return () => {
      alive = false;
    };
  }, [profileId]);
  return name;
}

const useStyles = makeStyles((c) => ({
  hint: { fontSize: font.caption, color: c.fgMuted, marginBottom: 10, paddingHorizontal: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 13,
    marginBottom: 10,
  },
  rowActive: { borderColor: c.accentBorder, backgroundColor: c.accentTint },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: c.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: font.body, fontWeight: '600', color: c.fg, flexShrink: 1 },
  rowDesc: { fontSize: font.caption, color: c.fgMuted, marginTop: 3, lineHeight: 17 },
  rowModel: { fontSize: font.caption, color: c.fgFaint, marginTop: 4 },
  badge: {
    backgroundColor: c.surfaceMuted,
    borderRadius: radius.full,
    paddingVertical: 1,
    paddingHorizontal: 7,
  },
  badgeText: { fontSize: font.caption, fontWeight: '600', color: c.fgMuted },
}));
