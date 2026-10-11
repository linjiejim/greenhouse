/**
 * One Agent's computer's background processes (`gh-jobs`: its run_background, a
 * terminal's job): the list, newest state first; one opens its log tail
 * (redacted by the server, re-read every 3 s while it runs) with Stop.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { computerProcessLog, listComputerProcesses, stopComputerProcess } from '../../api/bots';
import { useT } from '../../lib/i18n';
import { relativeTime } from '../../lib/format';
import type { ComputerProcessLog, ComputerProcessView } from '../../shared/bots';
import { makeStyles, radius, space, typo, useTheme } from '../../theme';
import { NativeButton } from '../../ui/button';
import { alertError, confirmAction } from '../../ui/dialogs';
import { EmptyState, LoadingState } from '../../ui/empty';
import { Badge, ListRow, ListSection } from '../../ui/list';
import { toast } from '../../ui/toast';
import { computerErrorKey } from './errors';
import type { ComputerBot } from './target';

const LOG_POLL_MS = 3000;

/** `bot`: whose computer (null = the main Agent's). */
export function ProcessesTab({ bot }: { bot: ComputerBot }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [list, setList] = useState<ComputerProcessView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listComputerProcesses(bot);
    if (result.ok) {
      setList(result.value);
      setFailed(false);
    } else setFailed(true);
  }, [bot]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = open ? list?.find((p) => p.id === open) : undefined;
  if (selected) {
    return <ProcessLog bot={bot} process={selected} onBack={() => setOpen(null)} onChanged={() => void load()} />;
  }
  if (!list) {
    return failed ? (
      <EmptyState icon="alertCircle" title={t('bots.computer.procLoadFailed')} onRetry={() => void load()} style={styles.fill} />
    ) : (
      <LoadingState style={styles.fill} />
    );
  }
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {list.length === 0 ? (
        <EmptyState icon="hourglass" title={t('bots.computer.procEmptyTitle')} message={t('bots.computer.procEmptyDesc')} />
      ) : (
        <ListSection>
          {list.map((process) => (
            <ListRow
              key={process.id}
              title={process.name || process.command}
              subtitle={t('bots.computer.procStarted', { time: relativeTime(process.started_at) })}
              accessory={
                <View style={styles.trailing}>
                  <StatusBadge process={process} />
                </View>
              }
              onPress={() => setOpen(process.id)}
            />
          ))}
        </ListSection>
      )}
    </ScrollView>
  );
}

function StatusBadge({ process }: { process: ComputerProcessView }) {
  const t = useT();
  if (process.status === 'running') return <Badge label={t('bots.computer.procRunning')} tone="green" />;
  if (process.status === 'lost') return <Badge label={t('bots.computer.procLost')} tone="orange" />;
  return process.exit_code != null && process.exit_code !== 0 ? (
    <Badge label={t('bots.computer.procExitCode', { code: process.exit_code })} tone="red" />
  ) : (
    <Badge label={t('bots.computer.procEnded')} tone="neutral" />
  );
}

function ProcessLog({
  bot,
  process,
  onBack,
  onChanged,
}: {
  bot: ComputerBot;
  process: ComputerProcessView;
  onBack: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [log, setLog] = useState<ComputerProcessLog | null>(null);
  const [failed, setFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const running = process.status === 'running';

  const read = useCallback(async () => {
    const result = await computerProcessLog(process.id, undefined, bot);
    if (result.ok) {
      setLog(result.value);
      setFailed(false);
    } else setFailed(true);
  }, [process.id, bot]);

  useEffect(() => {
    void read();
    if (!running) return undefined;
    const timer = setInterval(() => void read(), LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [read, running]);

  const stop = async () => {
    const name = process.name || process.command;
    const ok = await confirmAction({
      title: t('bots.computer.procStopTitle', { name }),
      message: t('bots.computer.procStopDesc'),
      confirmLabel: t('bots.computer.procStop'),
      destructive: true,
    });
    if (!ok) return;
    setStopping(true);
    const result = await stopComputerProcess(process.id, bot);
    setStopping(false);
    if (result.ok) toast(t('bots.computer.procStopped'), 'check');
    else alertError(t('bots.computer.procStopFailed', { name }), t(computerErrorKey(result.code) ?? 'common.retry'));
    onChanged();
  };

  return (
    <View style={styles.fill}>
      <View style={styles.logHead}>
        <NativeButton label={process.name || process.command} icon="chevL" size="small" onPress={onBack} />
        <View style={styles.flex} />
        <StatusBadge process={process} />
        {running ? (
          <NativeButton label={t('bots.computer.procStop')} size="small" destructive loading={stopping} onPress={() => void stop()} />
        ) : null}
      </View>
      <Text style={styles.command} numberOfLines={2} selectable>
        $ {process.command}
      </Text>
      <ScrollView style={styles.logBox} contentContainerStyle={styles.logContent}>
        {failed ? (
          <Text style={styles.logNote}>{t('bots.computer.procLogFailed')}</Text>
        ) : !log ? (
          <LoadingState />
        ) : (
          <>
            {log.truncated ? <Text style={styles.logNote}>{t('bots.computer.procLogTruncated')}</Text> : null}
            <Text style={styles.logText} selectable>
              {log.text || t('bots.computer.procLogEmpty')}
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  fill: { flex: 1 },
  flex: { flex: 1 },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  logHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingTop: space.md,
  },
  command: { ...typo.footnote, fontFamily: 'Menlo', color: c.secondaryLabel, marginHorizontal: space.margin, marginTop: space.sm },
  logBox: {
    flex: 1,
    margin: space.margin,
    borderRadius: radius.md,
    backgroundColor: c.codeBg,
  },
  logContent: { padding: space.md },
  logText: { fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, color: c.codeText },
  logNote: { ...typo.caption1, color: c.codeComment, marginBottom: space.sm },
}));
