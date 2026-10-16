import { useCallback, useRef } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { schedules, scheduleAction, removeSchedule } from '../../src/api/always-on';
import { scheduleLabel } from '../../src/agents/schedule-copy';
import { plainText } from '../../src/chat/text';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { ListRow, ListSection } from '../../src/ui/list';
import { EmptyState } from '../../src/ui/empty';
import { NativeMenu } from '../../src/ui/menu';
import { toolbarIcon } from '../../src/ui/toolbar-icon';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import type { Schedule } from '../../src/shared/contract';

export default function Schedules() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const router = useRouter();
  const r = useResource(useCallback(() => schedules(id), [id]));
  const busy = useRef(false);
  const action = async (schedule: Schedule, action: string) => {
    if (action === 'edit') {
      router.push({ pathname: '/agents/schedule', params: { id, schedule: schedule.id } });
      return;
    }
    if (busy.current) return;
    const current = r.captureWrite();
    if (
      action === 'remove' &&
      !(await confirmAction({
        title: t('integration.remove'),
        message: schedule.name,
        confirmLabel: t('integration.remove'),
        destructive: true,
      }))
    )
      return;
    if (!current()) return;
    busy.current = true;
    const result =
      action === 'remove'
        ? await removeSchedule(schedule.id)
        : await scheduleAction(schedule.id, action as 'pause' | 'resume' | 'run-now');
    busy.current = false;
    if (!current()) return;
    if (result.ok) void r.refresh();
    else alertError(t('work.saveFailed'), undefined, result.message);
  };
  return (
    <>
      <Stack.Screen options={{ title: t('integration.schedules') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('plus')}
          accessibilityLabel={t('integration.newSchedule')}
          onPress={() => router.push({ pathname: '/agents/schedule', params: { id } })}
        />
      </Stack.Toolbar>
      {!r.data ? (
        <ResourceState error={r.error} loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 40 }}>
          {r.data.items.map((s) => (
            <ListSection key={s.id} footer={`${scheduleLabel(s.cron, t)} · ${s.timezone}`}>
              <NativeMenu
                trigger="longPress"
                items={[
                  { id: 'edit', title: t('agents.edit'), icon: 'pen' },
                  {
                    id: s.status === 'active' ? 'pause' : 'resume',
                    title: t(s.status === 'active' ? 'integration.pause' : 'integration.resume'),
                    icon: 'clock',
                  },
                  { id: 'run-now', title: t('integration.runNow'), icon: 'runs' },
                  { id: 'remove', title: t('integration.remove'), icon: 'trash', destructive: true },
                ]}
                onSelect={(a) => void action(s, a)}
              >
                <ListRow
                  title={s.name}
                  titleLines={2}
                  accessibilityActions={[
                    { name: 'edit', label: t('agents.edit') },
                    {
                      name: s.status === 'active' ? 'pause' : 'resume',
                      label: t(s.status === 'active' ? 'integration.pause' : 'integration.resume'),
                    },
                    { name: 'run-now', label: t('integration.runNow') },
                    { name: 'remove', label: t('integration.remove') },
                  ]}
                  onAccessibilityAction={(e) => void action(s, e.nativeEvent.actionName)}
                  subtitle={[
                    t(s.status === 'active' ? 'integration.active' : 'integration.paused'),
                    s.quiet ? t('integration.quiet') : '',
                    plainText(s.brief),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  icon="clock"
                  accessory="chevron"
                  onPress={() => router.push({ pathname: '/agents/schedule', params: { id, schedule: s.id } })}
                />
              </NativeMenu>
            </ListSection>
          ))}
          {!r.data.items.length ? <EmptyState icon="clock" title={t('integration.noSchedules')} /> : null}
        </ScrollView>
      )}
    </>
  );
}
