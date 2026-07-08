/**
 * Project-level sheets: MembersSheet (list / add / remove) and ActivitiesSheet
 * (change log). Activity rows render the server's human-readable `detail`
 * string (it is data, not UI copy).
 */

import React, { useEffect, useState } from 'react';
import { Alert, FlatList, Text, View } from 'react-native';
import type { AssignableUser, ProjectActivity, ProjectMember } from '../api/projects';
import { addMember, listActivities, removeMember } from '../api/projects';
import { relativeTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { Icon, Sheet, Skeleton, Touchable, UserAvatar } from '../ui';
import { font, makeStyles, radius, useTheme, weight } from '../theme';
import { UserPickerSheet } from './user-picker-sheet';

// ─── Members ─────────────────────────────────────────────

export function MembersSheet({
  visible,
  onClose,
  projectId,
  members,
  users,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  projectId: number;
  members: ProjectMember[];
  users: AssignableUser[];
  onChanged: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);

  const confirmRemove = (member: ProjectMember) => {
    Alert.alert(t('projects.members'), t('projects.removeMemberConfirm', { name: member.nickname ?? member.user_id }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => void removeMember(projectId, member.user_id).then(onChanged),
      },
    ]);
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t('projects.members')}
      heightPct={70}
      nativeScroll
      headerRight={
        <Touchable haptic="selection" onPress={() => setPickerOpen(true)} style={styles.addBtn} accessibilityLabel={t('projects.addMember')}>
          <Icon name="userPlus" size={16} color={c.accentDeep} />
        </Touchable>
      }
    >
      <FlatList
        data={members}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, paddingBottom: 24 }}
        renderItem={({ item }) => (
          <View style={styles.memberRow}>
            <UserAvatar size={32} label={(item.nickname ?? item.user_id).slice(0, 1)} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={styles.memberName}>
                {item.nickname ?? item.user_id}
              </Text>
              <Text style={styles.memberRole}>{item.role === 'owner' ? t('projects.role_owner') : t('projects.role_member')}</Text>
            </View>
            {item.role !== 'owner' ? (
              <Touchable haptic="none" hitSlop={8} onPress={() => confirmRemove(item)} accessibilityLabel={t('common.delete')}>
                <Icon name="x" size={16} color={c.fgFaint} />
              </Touchable>
            ) : null}
          </View>
        )}
      />
      <UserPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        users={users}
        excludeIds={members.map((m) => m.user_id)}
        onPick={(id) => {
          if (id) void addMember(projectId, id).then(onChanged);
        }}
      />
    </Sheet>
  );
}

// ─── Activities ──────────────────────────────────────────

export function ActivitiesSheet({
  visible,
  onClose,
  projectId,
}: {
  visible: boolean;
  onClose: () => void;
  projectId: number;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [rows, setRows] = useState<ProjectActivity[] | null>(null);

  useEffect(() => {
    if (!visible) return;
    setRows(null);
    void listActivities(projectId, 50).then(setRows);
  }, [visible, projectId]);

  return (
    <Sheet visible={visible} onClose={onClose} title={t('projects.activities')} heightPct={70} nativeScroll>
      {rows === null ? (
        <View style={{ padding: 16, gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} style={{ height: 44, borderRadius: radius.md }} />
          ))}
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(a) => String(a.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, paddingBottom: 24 }}
          ListEmptyComponent={<Text style={styles.activityEmpty}>{t('projects.activitiesEmpty')}</Text>}
          renderItem={({ item }) => (
            <View style={styles.activityRow}>
              <View style={styles.activityDot} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.activityText}>
                  <Text style={{ fontWeight: weight.semibold }}>{item.user_nickname ?? item.user_id}</Text>
                  {'  '}
                  {item.detail ?? item.action}
                </Text>
                <Text style={styles.activityTime}>{relativeTime(item.created_at)}</Text>
              </View>
            </View>
          )}
        />
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  addBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  memberName: { fontSize: font.body, color: c.fg, fontWeight: weight.medium },
  memberRole: { fontSize: font.caption, color: c.fgFaint, marginTop: 1 },

  activityRow: { flexDirection: 'row', gap: 10, paddingVertical: 9 },
  activityDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.accentBorder, marginTop: 6 },
  activityText: { fontSize: font.small, color: c.fgSecondary, lineHeight: 19 },
  activityTime: { fontSize: font.caption, color: c.fgFaint, marginTop: 2 },
  activityEmpty: { fontSize: font.small, color: c.fgFaint, textAlign: 'center', paddingVertical: 30 },
}));
