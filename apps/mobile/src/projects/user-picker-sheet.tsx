/**
 * UserPickerSheet — choose an internal user (assignee / owner / new member).
 * Local search over the /api/projects/meta/users list; optional "unassigned"
 * row for clearing.
 */

import React, { useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { AssignableUser } from '../api/projects';
import { useT } from '../lib/i18n';
import { Field, Icon, Sheet, Touchable, UserAvatar } from '../ui';
import { font, makeStyles, useTheme, weight } from '../theme';

export function UserPickerSheet({
  visible,
  onClose,
  users,
  selectedId,
  onPick,
  allowClear = false,
  excludeIds,
}: {
  visible: boolean;
  onClose: () => void;
  users: AssignableUser[];
  selectedId?: string | null;
  onPick: (userId: string | null) => void;
  /** Adds an "unassigned" row that picks null. */
  allowClear?: boolean;
  /** Hide these users (e.g. existing members when adding). */
  excludeIds?: string[];
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const excluded = new Set(excludeIds ?? []);
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => !excluded.has(u.id))
      .filter((u) => !q || u.nickname.toLowerCase().includes(q) || u.id.toLowerCase().includes(q));
  }, [users, query, excludeIds]);

  const pick = (id: string | null) => {
    onPick(id);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('projects.pickUser')} heightPct={70} nativeScroll>
      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
        <Field icon="search" placeholder={t('projects.searchUsers')} value={query} onChangeText={setQuery} autoCapitalize="none" />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(u) => u.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          allowClear ? (
            <Touchable haptic="selection" onPress={() => pick(null)} style={styles.row}>
              <View style={styles.clearIcon}>
                <Icon name="x" size={15} color={c.fgMuted} />
              </View>
              <Text style={styles.name}>{t('projects.unassigned')}</Text>
              {!selectedId ? <Icon name="check" size={17} color={c.accent} /> : null}
            </Touchable>
          ) : null
        }
        renderItem={({ item }) => (
          <Touchable haptic="selection" onPress={() => pick(item.id)} style={styles.row}>
            <UserAvatar size={30} label={item.nickname.slice(0, 1) || '?'} />
            <Text style={styles.name} numberOfLines={1}>
              {item.nickname}
            </Text>
            {selectedId === item.id ? <Icon name="check" size={17} color={c.accent} /> : null}
          </Touchable>
        )}
      />
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  clearIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { flex: 1, fontSize: font.body, color: c.fg, fontWeight: weight.medium },
}));
