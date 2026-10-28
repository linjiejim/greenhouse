/**
 * One automation as an object sheet (`/sheet/automation?id=`, `GET /api/tasks/:id`): what it does
 * (its prompt), the switch that pauses and resumes it, when it runs and next runs, where it
 * reports and whom it runs as; Run Now opens the run's conversation; its recent runs open their
 * run sheet (a run from before the Runtime, its conversation). Changes are asked of the assistant
 * in a new conversation, never typed into a form here; Delete asks first (the runs'
 * conversations stay). Not mine, or gone: "not available", no retry.
 */

import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  deleteAutomation,
  getAutomation,
  listAutomationRuns,
  runAutomationNow,
  setAutomationEnabled,
} from '../../src/api/automations';
import { findProfile, listProfiles, profileName } from '../../src/api/profiles';
import { lastResult, runResult, runsAsAssistant, type Automation } from '../../src/automations/model';
import { resultTone } from '../../src/automations/look';
import { nextRunNow, scheduleLabel } from '../../src/automations/words';
import { noAccess, notFound } from '../../src/data/access';
import { captureIdentity } from '../../src/data/identity';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { objectId } from '../../src/lib/object-id';
import { relativeTimeNow } from '../../src/lib/time-words';
import { useOpenObject, useStartChat } from '../../src/shell/open-object';
import { usePrefs } from '../../src/store/prefs';
import { HIT, makeStyles, space, typo, useTheme } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { notifySuccess, selectionTick } from '../../src/ui/haptics';
import { Badge, Card, Row, Section, SectionHeader } from '../../src/ui/list';
import { SheetScreen } from '../../src/ui/screen';
import { toast } from '../../src/ui/toast';
import { NativeToggle } from '../../src/ui/toggle';

/** Runs shown here; the full history is on the web. */
const RUNS = 10;

export default function AutomationSheet() {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  const id = objectId(raw);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const router = useRouter();
  const openObject = useOpenObject();
  const startChat = useStartChat();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const resource = useResource(useCallback(() => getAutomation(id ?? '0'), [id]));
  const runs = useResource(useCallback(() => listAutomationRuns(id ?? '0'), [id]));
  const profiles = useResource(listProfiles);
  const { setData } = resource;
  const task = resource.data?.task ?? null;
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // one toggle save at a time: an older answer landing last would leave the opposite state saved
  const [toggling, setToggling] = useState(false);

  const patchTask = useCallback(
    (patch: Partial<Automation>) => setData((data) => (data ? { ...data, task: { ...data.task, ...patch } } : data)),
    [setData],
  );

  const toggle = useCallback(
    async (enabled: boolean) => {
      if (!task || toggling) return;
      const current = captureIdentity();
      selectionTick();
      patchTask({ enabled });
      setToggling(true);
      const result = await setAutomationEnabled(task.id, enabled);
      if (!current()) return;
      setToggling(false);
      if (!result.ok) {
        patchTask({ enabled: !enabled });
        alertError(t('automations.toggleFailed'), result.message || undefined);
        return;
      }
      patchTask(result.data.task);
      notifySuccess();
      toast(t(enabled ? 'automations.resumed' : 'automations.pausedToast'), 'check');
    },
    [task, toggling, patchTask, t],
  );

  const runNow = useCallback(async () => {
    if (!task || running) return;
    const current = captureIdentity();
    setRunning(true);
    const result = await runAutomationNow(task.id);
    if (!current()) return;
    setRunning(false);
    if (!result.ok) {
      alertError(t('automations.runFailed'), result.message || undefined);
      return;
    }
    notifySuccess();
    // the run is a conversation: follow it there as it is written
    openObject({ kind: 'chat', sessionId: result.data.session_id });
  }, [task, running, openObject, t]);

  const remove = useCallback(async () => {
    if (!task || deleting) return;
    const ok = await confirmAction({
      title: t('automations.deleteTitle', { name: task.name }),
      message: t('automations.deleteHint'),
      confirmLabel: t('automations.delete'),
      destructive: true,
    });
    if (!ok) return;
    const current = captureIdentity();
    setDeleting(true);
    const result = await deleteAutomation(task.id);
    if (!current()) return;
    setDeleting(false);
    if (!result.ok) {
      alertError(t('automations.deleteFailed'), result.message || undefined);
      return;
    }
    notifySuccess();
    toast(t('automations.deleted'), 'check');
    // the list under the sheet reloads as it comes back into view
    router.back();
  }, [task, deleting, router, t]);

  if (id == null || (!task && !resource.loading && (notFound(resource.error) || noAccess(resource.error)))) {
    return (
      <View style={styles.root}>
        <SheetScreen title={t('nav.automations')} />
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          <EmptyState icon="clock" title={t('automations.notFound')} style={styles.state} />
        </ScrollView>
      </View>
    );
  }

  if (!task) {
    return (
      <View style={styles.root}>
        <SheetScreen title={t('nav.automations')} />
        {resource.loading ? (
          <LoadingState style={styles.state} />
        ) : (
          <EmptyState icon="alert" title={t('automations.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
        )}
      </View>
    );
  }

  const result = lastResult(task);
  const next = task.enabled ? nextRunNow(task.next_run_at) : '';
  const channels = [
    task.notify?.wecom ? t('automations.channel.wecom') : '',
    task.notify?.feishu ? t('automations.channel.feishu') : '',
    task.notify?.email ? t('automations.channel.email') : '',
    task.notify?.webhook ? t('automations.channel.webhook') : '',
  ].filter(Boolean);
  const profile = findProfile(profiles.data ?? [], task.profile_id);
  const runsAs = runsAsAssistant(task.profile_id)
    ? t('nav.assistant')
    : profile
      ? profileName(profile, lang)
      : t('automations.customAgent');
  const entries = (runs.data ?? []).slice(0, RUNS);

  return (
    <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <SheetScreen title={task.name} busy={resource.loading} />
      <SectionHeader title={t('automations.prompt')} />
      <Card style={styles.card}>
        <Text style={styles.promptText} selectable>
          {task.task_prompt}
        </Text>
      </Card>
      <Card style={[styles.card, styles.toggle]}>
        <NativeToggle label={t('automations.enabled')} value={task.enabled} onChange={(on) => void toggle(on)} disabled={toggling} />
      </Card>
      <Section>
        <Row title={t('automations.scheduleLabel')} value={scheduleLabel(task.schedule, task.timezone)} icon="clock" />
        {task.enabled && next ? (
          <Row title={t('automations.nextRunLabel')} value={next} icon="hourglass" iconTint={c.blueTile} />
        ) : !task.enabled ? (
          <Row title={t('automations.paused')} icon="sleep" iconTint={c.gray} />
        ) : null}
        <Row title={t('automations.timezone')} value={task.timezone} icon="globe" iconTint={c.gray} />
        <Row
          title={t('automations.notify')}
          value={channels.length ? channels.join(t('common.listSep')) : t('automations.notifyApp')}
          icon="bell"
          iconTint={c.orangeTile}
        />
        <Row title={t('automations.runsAs')} value={runsAs} icon="sparkle" />
        {result !== 'none' ? (
          <Row
            title={t('automations.lastRun')}
            value={task.last_run_at ? relativeTimeNow(task.last_run_at) : undefined}
            icon="runs"
            iconTint={c.gray}
            accessory={<Badge label={t(`automations.result.${result}`)} tone={resultTone(result)} />}
          />
        ) : null}
      </Section>
      <View style={styles.actions}>
        <NativeButton
          label={t('automations.runNow')}
          icon="refresh"
          variant="prominent"
          loading={running}
          fullWidth
          onPress={() => void runNow()}
        />
        <NativeButton
          label={t('automations.askChange')}
          icon="compose"
          fullWidth
          onPress={() => startChat(t('automations.changeDraft', { name: task.name }))}
        />
      </View>
      <Section header={t('automations.runs')}>
        {entries.length ? (
          entries.map((entry) => {
            const outcome = runResult(entry);
            const trigger = entry.run ? t(`automations.trigger.${entry.run.trigger}`) : '';
            return (
              <Row
                key={entry.session_id}
                title={relativeTimeNow(entry.created_at)}
                subtitle={[trigger, entry.run?.error_message].filter(Boolean).join(' · ') || undefined}
                subtitleLines={2}
                accessory={<Badge label={t(`automations.result.${outcome}`)} tone={resultTone(outcome)} />}
                onPress={() =>
                  entry.run ? openObject({ kind: 'run', id: entry.run.id }) : openObject({ kind: 'chat', sessionId: entry.session_id })
                }
              />
            );
          })
        ) : (
          <Row title={runs.loading ? t('common.loading') : t('automations.noRuns')} quiet />
        )}
      </Section>
      <Section>
        <Row title={t('automations.delete')} icon="trash" iconTint={c.redTile} destructive disabled={deleting} onPress={() => void remove()} />
      </Section>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
  card: { marginBottom: space.xxl, paddingHorizontal: space.margin, paddingVertical: space.md },
  promptText: { ...typo.body, color: c.label },
  toggle: { paddingVertical: 0, minHeight: HIT, justifyContent: 'center' },
  actions: { marginHorizontal: space.margin, marginBottom: space.xxl, gap: space.sm },
}));
