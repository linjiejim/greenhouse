/**
 * An Agent's computer's background processes (AGNT-18): what it started to keep running, with
 * its state (running, finished, lost when the computer restarted under it) and exit code.
 * Read-only on the phone.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { computerProcesses } from '../api/computer';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import type { ComputerJob } from '../shared/contract';
import { makeStyles, radius, space, typo, useTheme, weight } from '../theme';
import { EmptyState, LoadingState } from '../ui/empty';
import { ListRow, ListSection } from '../ui/list';

export function ProcessesTab({ agentId }: { agentId: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [list, setList] = useState<ComputerJob[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const result = await computerProcesses(agentId);
    if (result.ok) {
      setList(result.data.items);
      setFailed(false);
    } else setFailed(true);
  }, [agentId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (!list) {
    return failed ? (
      <EmptyState icon="alertCircle" title={t('computer.processesFailed')} onRetry={() => void load()} style={styles.fill} />
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
        <EmptyState icon="hourglass" title={t('computer.noProcesses')} />
      ) : (
        <ListSection>
          {list.map((job) => {
            const tone = job.status === 'running' ? c.blue : job.status === 'lost' ? c.red : c.green;
            return (
              <ListRow
                key={job.id}
                title={job.name || job.command}
                subtitle={[job.command, job.started_at ? relativeTimeNow(job.started_at) : '', job.exit_code ? t('computer.exitCode', { code: job.exit_code }) : '']
                  .filter(Boolean)
                  .join(' · ')}
                accessory={
                  <View style={[styles.status, { borderColor: tone }]}>
                    <Text style={[styles.statusText, { color: tone }]}>{t(`computer.job.${job.status}`)}</Text>
                  </View>
                }
              />
            );
          })}
        </ListSection>
      )}
    </ScrollView>
  );
}

const useStyles = makeStyles(() => ({
  fill: { flex: 1, justifyContent: 'center' },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  status: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
  statusText: { ...typo.caption1, fontWeight: weight.semibold },
}));
