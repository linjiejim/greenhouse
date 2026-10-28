/**
 * Computer (phone page; the browser place is ./screen.web.tsx): my cloud computer's state in words
 * with its one action, this month's minutes and their price, and the idle rule. A station without
 * computers says why and who can change it. There is no live view: the plugin runs no desktop.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { captureIdentity } from '../../data/identity';
import { useResource } from '../../data/use-resource';
import { localeOf, useT } from '../../lib/i18n';
import { relativeTimeNow } from '../../lib/time-words';
import { usePrefs } from '../../store/prefs';
import { makeStyles, space, useTheme } from '../../theme';
import { NativeButton } from '../../ui/button';
import { alertError, confirmAction } from '../../ui/dialogs';
import { EmptyState, LoadingState } from '../../ui/empty';
import { Row, Section, SectionFooter } from '../../ui/list';
import { usePullRefresh } from '../../ui/refresh';
import { Screen } from '../../ui/screen';
import { toast } from '../../ui/toast';
import { myComputer, startComputer, stopComputer } from './api';
import {
  canStart,
  canStop,
  computerCosts,
  computerState,
  startRefusal,
  TRANSITION_POLL_MS,
} from './model';

export function ComputerScreen({ title }: { title: string }) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const report = useResource(useCallback(() => myComputer(), []));
  const pull = usePullRefresh(report.refresh);
  const [busy, setBusy] = useState(false);
  const { data, refresh } = report;
  const state = data ? computerState(data) : null;
  const costs = data ? computerCosts(data, localeOf(lang)) : null;
  useEffect(() => {
    if (state !== 'starting' && state !== 'stopping') return;
    const timer = setTimeout(() => void refresh(), TRANSITION_POLL_MS);
    return () => clearTimeout(timer);
  }, [state, data, refresh]);

  const start = async () => {
    const current = captureIdentity();
    setBusy(true);
    const r = await startComputer();
    if (!current()) return;
    setBusy(false);
    if (!r.ok) {
      const refusal = startRefusal(r.code);
      alertError(t('appPages.computer.startFailed'), refusal ? t(`appPages.computer.refusal.${refusal}`) : r.message);
    } else toast(t(r.data.started ? 'appPages.computer.started' : 'appPages.computer.alreadyRunning'), 'computer');
    void report.refresh();
  };
  const stop = async () => {
    const current = captureIdentity();
    const ok = await confirmAction({
      title: t('appPages.computer.stopTitle'),
      message: t('appPages.computer.stopHint'),
      confirmLabel: t('appPages.computer.stop'),
      destructive: true,
    });
    if (!ok || !current()) return;
    setBusy(true);
    const r = await stopComputer();
    if (!current()) return;
    setBusy(false);
    if (!r.ok) alertError(t('appPages.computer.stopFailed'), r.message);
    else toast(t('appPages.computer.stopped'), 'stop');
    void report.refresh();
  };

  return (
    <>
      <Screen title={title} busy={report.loading && !pull.refreshing && !!data} />
      <ScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {!data || !state ? (
          report.loading ? (
            <LoadingState />
          ) : (
            <EmptyState
              icon="computer"
              title={report.error?.message || t('places.pluginError')}
              onRetry={report.error?.status === 403 ? undefined : () => void report.refresh()}
              style={styles.state}
            />
          )
        ) : (
          <>
            <Section
              footer={
                state === 'running' && data.computer
                  ? t('appPages.computer.stateHint.running', {
                      started: relativeTimeNow(data.computer.started_at),
                      used: relativeTimeNow(data.computer.last_used_at),
                    })
                  : t(`appPages.computer.stateHint.${state}`)
              }
            >
              <Row title={t(`appPages.computer.state.${state}`)} icon="computer" />
            </Section>
            {canStart(state) || canStop(state) ? (
              <View style={styles.action}>
                {canStart(state) ? (
                  <NativeButton
                    label={t('appPages.computer.start')}
                    icon="computer"
                    variant="prominent"
                    fullWidth
                    loading={busy}
                    onPress={() => void start()}
                  />
                ) : (
                  <NativeButton
                    label={t('appPages.computer.stop')}
                    icon="stop"
                    destructive
                    fullWidth
                    loading={busy}
                    onPress={() => void stop()}
                  />
                )}
              </View>
            ) : null}
            <Section header={t('appPages.computer.usage')} footer={t('appPages.computer.files')}>
              <Row
                title={t('appPages.computer.thisMonth')}
                value={
                  costs
                    ? `${t('appPages.computer.minutes', { n: data.minutes_this_month })} · ${t('appPages.computer.about', { amount: costs.thisMonth })}`
                    : t('appPages.computer.minutes', { n: data.minutes_this_month })
                }
              />
              <Row
                title={t('appPages.computer.price')}
                value={costs ? t('appPages.computer.perMinute', { price: costs.perMinute }) : t('appPages.computer.unpriced')}
                subtitle={costs ? t('appPages.computer.perHour', { price: costs.perHour }) : undefined}
              />
              <Row title={t('appPages.computer.idle')} value={t('appPages.computer.idleAfter', { n: data.idle_minutes })} />
            </Section>
            <SectionFooter text={t('appPages.computer.intro')} />
          </>
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  action: { paddingHorizontal: space.margin, paddingBottom: space.lg },
}));
