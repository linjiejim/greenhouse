import { TodoPlan } from '../../src/chat/todo-plan';
import { operationErrorText } from '../../src/api/operation-error';
/**
 * A run (RUN-02; a pushed page): its status, who and where from, what needs the member (its
 * 「需要你」 cards), the result, the steps (failed ones say why) and the brief. 取消 while it runs;
 * 重试 retries the failed steps when it failed; 打开来源对话 goes to the conversation it reports
 * to. Refreshes every few seconds while active and on realtime `run.updated`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { listRequests } from '../../src/api/requests';
import { cancelRun, getRun, retryRun } from '../../src/api/runs';
import { Markdown } from '../../src/chat/markdown';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import { useResource } from '../../src/data/use-resource';
import { useOperations } from '../../src/data/use-operations';
import { RequestCard } from '../../src/requests/request-card';
import { RUN_SOURCE, RUN_STATUS, duration, isActiveRun } from '../../src/runs/status';
import { parseMs } from '../../src/data/time';
import type { NeedsYou } from '../../src/shared/contract';
import { openConversation } from '../../src/shell/nav';
import { useWorkspace } from '../../src/store/workspace';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../src/theme';
import { AgentAvatar } from '../../src/ui/agent-avatar';
import { NativeButton } from '../../src/ui/button';
import { Icon } from '../../src/ui/core';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListSection } from '../../src/ui/list';
import { toast } from '../../src/ui/toast';

export default function RunPage() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const agents = useWorkspace((s) => s.agents);
  const focused = useIsFocused();
  const operations = useOperations();
  const resource = useResource(
    useCallback(async () => {
      const result = await getRun(id);
      if (!result.ok) return result;
      let cards: NeedsYou[] = [];
      if (result.data.conversation_id) {
        const requests = await listRequests({ state: 'all', conversation_id: result.data.conversation_id, limit: 200 });
        if (!requests.ok) return requests;
        cards = requests.data.items.filter((request) => request.run_id === result.data.id);
      }
      return { ok: true as const, data: { run: result.data, cards } };
    }, [id]),
    ['run.updated', 'request.updated'],
  );
  const run = resource.data?.run ?? null;
  const cards = resource.data?.cards ?? [];
  const state = run ? 'ready' : resource.loading ? 'loading' : resource.error?.status === 404 ? 'missing' : 'failed';
  const load = resource.refresh;
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const pending = useRef(false);
  const [brief, setBrief] = useState(false);

  // While it runs: a fresh look every few seconds (steps land without their own events).
  const active = !!run && isActiveRun(run);
  useEffect(() => {
    if (!active || !focused) return undefined;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [active, focused, load]);

  const act = async (action: 'cancel' | 'retry') => {
    if (pending.current) return;
    const current = resource.captureWrite();
    pending.current = true;
    setBusy(action);
    const result = action === 'cancel' ? await cancelRun(id) : await retryRun(id);
    pending.current = false;
    if (!current()) return;
    setBusy(null);
    if (!result.ok) {
      alertError(
        action === 'cancel' ? t('runs.cancelFailed') : t('runs.retryFailed'),
        operationErrorText(result, t),
        operationErrorText(result, t) ? undefined : result.message,
      );
      return;
    }
    resource.setData((old) => (old ? { ...old, run: result.data } : old));
    toast(action === 'cancel' ? t('runs.canceled') : t('runs.retried'), 'check');
  };

  if (state !== 'ready' || !run) {
    return (
      <>
        <Stack.Screen options={{ title: t('runs.run') }} />
        <View style={styles.center}>
          {state === 'loading' ? (
            <LoadingState />
          ) : state === 'missing' ? (
            <EmptyState icon="runs" title={t('runs.notFound')} />
          ) : (
            <EmptyState icon="alert" title={t('runs.loadFailed')} onRetry={() => void load()} />
          )}
        </View>
      </>
    );
  }

  const agent = agents?.find((item) => item.id === run.agent_id) ?? null;
  const status = RUN_STATUS[run.status];
  const tone =
    status.tone === 'warning'
      ? c.orange
      : status.tone === 'danger'
        ? c.red
        : status.tone === 'success'
          ? c.green
          : status.tone === 'info'
            ? c.blue
            : c.secondaryLabel;
  const took =
    run.started_at && run.finished_at ? (parseMs(run.finished_at) || 0) - (parseMs(run.started_at) || 0) : null;
  const meta = [
    agent?.name,
    t(`runs.${RUN_SOURCE[run.source]}` as 'runs.fromConversation'),
    relativeTimeNow(run.started_at ?? run.created_at),
    took !== null && took > 0 ? t('runs.took', { time: duration(took) }) : '',
    run.attempt > 1 ? t('runs.attempt', { n: run.attempt }) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <Stack.Screen options={{ title: run.title }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {run.status === 'queued' && operations.data?.pause_background_runs ? (
          <Text accessibilityRole="alert" style={styles.meta}>
            {t('integration.backgroundPaused')}
          </Text>
        ) : null}
        <View style={styles.head}>
          <AgentAvatar
            agent={agent}
            size={40}
            state={run.status === 'running' ? 'thinking' : run.status === 'waiting' ? 'waiting' : undefined}
          />
          <View style={styles.headTexts}>
            <Text style={styles.title}>{run.title}</Text>
            <View style={styles.metaRow}>
              <View style={[styles.status, { borderColor: tone }]}>
                <Text style={[styles.statusText, { color: tone }]}>
                  {t(`runs.status.${status.word}` as 'runs.status.running')}
                </Text>
              </View>
              <Text style={styles.meta}>{meta}</Text>
            </View>
          </View>
        </View>

        {run.error ? (
          <View style={styles.error}>
            <Icon name="alert" size={15} color={c.red} />
            <Text style={styles.errorText}>{operationErrorText(run.error, t) ?? run.error.message}</Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          {run.conversation_id ? (
            <NativeButton
              label={t('runs.openSource')}
              icon="msg"
              onPress={() => openConversation(router, { id: run.conversation_id! }, 'dismissTo')}
            />
          ) : null}
          {active ? (
            <NativeButton
              label={t('runs.cancel')}
              destructive
              loading={busy === 'cancel'}
              onPress={() => void act('cancel')}
            />
          ) : null}
          {run.status === 'failed' && !run.parent_run_id ? (
            <NativeButton
              label={t('runs.retry')}
              variant="prominent"
              loading={busy === 'retry'}
              onPress={() => void act('retry')}
            />
          ) : null}
        </View>

        {cards.length ? (
          <View style={styles.cards}>
            {cards.map((request) => (
              <RequestCard key={request.id} request={request} />
            ))}
          </View>
        ) : null}

        {run.findings.length ? (
          <ListSection header={t('integration.findings')}>
            {run.findings.map((finding, index) => (
              <View key={index} style={styles.section}>
                <Markdown source={finding} safe />
              </View>
            ))}
          </ListSection>
        ) : null}
        {run.summary && !run.output ? (
          <View style={styles.section}>
            <Markdown source={run.summary} safe />
          </View>
        ) : null}
        {run.output ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('runs.output')}</Text>
            <Markdown source={run.output} safe />
          </View>
        ) : null}

        <TodoPlan items={run.todo} />
        <ListSection header={t('runs.steps')}>
          {run.steps.length ? (
            run.steps.map((step) => (
              <View key={step.id} style={styles.step}>
                <Icon
                  name={step.status === 'failed' ? 'alert' : step.status === 'succeeded' ? 'checkCircle' : 'circle'}
                  size={14}
                  color={step.status === 'failed' ? c.red : step.status === 'succeeded' ? c.green : c.secondaryLabel}
                />
                <View style={styles.stepTexts}>
                  {step.summary !== step.error?.message ? <Text style={styles.stepName}>{step.summary}</Text> : null}
                  {step.error ? (
                    <Text style={styles.stepError}>{operationErrorText(step.error, t) ?? step.error.message}</Text>
                  ) : null}
                </View>
                {step.duration_ms !== null ? <Text style={styles.stepTime}>{duration(step.duration_ms)}</Text> : null}
              </View>
            ))
          ) : (
            <Text style={styles.none}>{t('runs.noSteps')}</Text>
          )}
        </ListSection>

        {run.brief ? (
          <View style={styles.section}>
            <NativeButton
              label={brief ? t('runs.hideBrief') : t('runs.showBrief')}
              size="small"
              onPress={() => setBrief((v) => !v)}
            />
            {brief ? <Markdown source={run.brief} safe /> : null}
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  center: { flex: 1, justifyContent: 'center' },
  content: { paddingBottom: space.xxxl, gap: space.md },
  head: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.margin, paddingTop: space.md },
  headTexts: { flex: 1, gap: space.xs },
  title: { ...typo.title3, fontWeight: weight.semibold, color: c.label },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  status: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
  statusText: { ...typo.caption1, fontWeight: weight.semibold },
  meta: { flexShrink: 1, ...typo.footnote, color: c.secondaryLabel },
  error: {
    flexDirection: 'row',
    gap: space.sm,
    marginHorizontal: space.margin,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: c.redFill,
    ...squircle,
  },
  errorText: { flex: 1, ...typo.footnote, color: c.red },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.margin },
  cards: { gap: space.sm, paddingHorizontal: space.margin },
  section: { paddingHorizontal: space.margin, gap: space.sm, alignItems: 'flex-start' },
  sectionTitle: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingVertical: space.sm + 2,
  },
  stepTexts: { flex: 1, gap: 2 },
  stepName: { ...typo.subheadline, color: c.label },
  stepError: { ...typo.footnote, color: c.red },
  stepTime: { ...typo.caption1, color: c.tertiaryLabel, fontVariant: ['tabular-nums'] },
  none: { ...typo.footnote, color: c.tertiaryLabel, padding: space.margin },
}));
