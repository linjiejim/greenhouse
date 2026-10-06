/**
 * Project activity — a sheet (param `id`) with the change log, newest first:
 * a tinted symbol tile per kind (created / updated / comment / member), the
 * server's human-readable `detail` (data, not UI copy), and actor · relative
 * time. Entries about a task open that task (the sheet steps aside first).
 * Pull to refresh; a failed load shows a retry state (never a fake "no
 * activity"), and a refresh failure keeps the rows already shown.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, type ColorValue } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { listActivities, type ProjectActivity } from '../../src/api/projects';
import { relativeTime } from '../../src/lib/format';
import { useT, type TranslationKey } from '../../src/lib/i18n';
import { space, useTheme, type ThemeColors } from '../../src/theme';
import type { IconName } from '../../src/ui/core';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { SheetClose, useLeaveSheetTo } from '../../src/ui/sheet-chrome';

const KINDS: Record<string, { icon: IconName; tint: (c: ThemeColors) => ColorValue; label: TranslationKey }> = {
  project_created: { icon: 'folderPlus', tint: (c) => c.accent, label: 'projects.act_project_created' },
  project_updated: { icon: 'pen', tint: (c) => c.indigo, label: 'projects.act_project_updated' },
  task_created: { icon: 'plusCircle', tint: (c) => c.green, label: 'projects.act_task_created' },
  task_updated: { icon: 'refresh', tint: (c) => c.blue, label: 'projects.act_task_updated' },
  comment_added: { icon: 'comment', tint: (c) => c.orange, label: 'projects.act_comment_added' },
  member_added: { icon: 'userPlus', tint: (c) => c.purple, label: 'projects.act_member_added' },
};
const FALLBACK = { icon: 'activity' as IconName, tint: (c: ThemeColors) => c.gray };
/** Empty / failed states sit in the middle of the sheet. */
const CENTERED = { flexGrow: 1, justifyContent: 'center' } as const;

export default function ActivitySheet() {
  const { colors: c, hex } = useTheme();
  const t = useT();
  const leaveTo = useLeaveSheetTo();
  const params = useLocalSearchParams<{ id: string }>();
  const projectId = Number(params.id);
  const [rows, setRows] = useState<ProjectActivity[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const load = useCallback(async () => {
    const data = await listActivities(projectId, 50);
    if (!alive.current) return;
    if (data) setRows(data);
    else setRows((prev) => prev ?? []);
    setFailed(!data);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <>
      <Stack.Screen options={{ title: t('projects.activities') }} />
      <SheetClose />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: space.sm, paddingBottom: space.xxxl, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={hex.accent} />}
      >
        {rows === null ? (
          <LoadingState />
        ) : failed && rows.length === 0 ? (
          <EmptyState
            icon="alert"
            title={t('projects.loadFailed')}
            message={t('projects.loadFailedHint')}
            onRetry={() => void load()}
            style={CENTERED}
          />
        ) : rows.length === 0 ? (
          <EmptyState icon="activity" title={t('projects.activitiesEmpty')} style={CENTERED} />
        ) : (
          <ListSection>
            {rows.map((a) => {
              const kind = KINDS[a.action];
              const actor = a.user_nickname ?? a.user_id;
              return (
                <ListRow
                  key={a.id}
                  title={a.detail || (kind ? t(kind.label) : a.action)}
                  titleLines={3}
                  subtitle={`${actor} · ${relativeTime(a.created_at)}`}
                  icon={kind?.icon ?? FALLBACK.icon}
                  iconTint={(kind?.tint ?? FALLBACK.tint)(c)}
                  accessory={a.task_id ? 'chevron' : 'none'}
                  onPress={
                    a.task_id
                      ? () =>
                          leaveTo({
                            pathname: '/projects/task/[taskId]',
                            params: { taskId: String(a.task_id), projectId: String(projectId) },
                          })
                      : undefined
                  }
                />
              );
            })}
          </ListSection>
        )}
      </ScrollView>
    </>
  );
}
