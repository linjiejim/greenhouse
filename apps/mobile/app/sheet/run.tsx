/**
 * A run as an object sheet (`/sheet/run?id=`, `GET /api/runtime/runs/:id`): what kind of run,
 * how it went, when, the tools it used, why it failed; its conversation opens as a page, and the
 * whole run log on the web. A run that is not mine answers 404 — "not available".
 */

import React, { useCallback } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { get, seg } from '../../src/api/client';
import { noAccess, notFound } from '../../src/data/access';
import { useResource } from '../../src/data/use-resource';
import { webUrl } from '../../src/lib/deep-links';
import { useT } from '../../src/lib/i18n';
import { openLink } from '../../src/lib/links';
import { relativeTimeNow } from '../../src/lib/time-words';
import { toolLabel } from '../../src/chat/messages';
import { useOpenObject } from '../../src/shell/open-object';
import { getApiBase } from '../../src/store/stations';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { Badge, Row, Section, type BadgeTone } from '../../src/ui/list';
import { SheetScreen } from '../../src/ui/screen';

interface RunDetail {
  run: {
    id: string;
    kind: string;
    status: string;
    session_id: string | null;
    error_message: string | null;
    started_at: string | null;
    ended_at: string | null;
    created_at: string;
  };
  tool_calls: { id: string; tool_name: string; status: string; error_message: string | null }[];
}

const TONE: Record<string, BadgeTone> = { succeeded: 'green', failed: 'red', running: 'blue', waiting: 'orange', cancelled: 'neutral' };

export default function RunSheet() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const t = useT();
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const openObject = useOpenObject();
  const resource = useResource(useCallback(() => get<RunDetail>(`/api/runtime/runs/${seg(id)}`), [id]));
  const detail = resource.data;

  if (!detail) {
    return (
      <View style={styles.root}>
        <SheetScreen title={t('runs.title')} />
        {resource.loading ? (
          <LoadingState style={styles.state} />
        ) : (
          <EmptyState
            icon="runs"
            title={notFound(resource.error) || noAccess(resource.error) ? t('runs.notFound') : t('runs.loadFailed')}
            onRetry={notFound(resource.error) || noAccess(resource.error) ? undefined : () => void resource.refresh()}
            style={styles.state}
          />
        )}
      </View>
    );
  }
  const { run } = detail;
  return (
    <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <SheetScreen
        title={t('runs.title')}
        actions={[{ icon: 'open', label: t('runs.openWeb'), onPress: () => void openLink(webUrl(getApiBase(), `#/activity/${seg(run.kind)}/${seg(run.id)}`), hex.accent) }]}
      />
      <Section>
        <Row title={t('runs.kind')} value={run.kind} accessory="none" />
        <Row title={t('runs.status')} accessory={<Badge label={run.status} tone={TONE[run.status] ?? 'neutral'} />} />
        <Row title={t('runs.started')} value={relativeTimeNow(run.started_at ?? run.created_at)} accessory="none" />
        {run.ended_at ? <Row title={t('runs.ended')} value={relativeTimeNow(run.ended_at)} accessory="none" /> : null}
        {run.session_id ? (
          <Row title={t('runs.conversation')} icon="msg" accessory="chevron" onPress={() => openObject({ kind: 'chat', sessionId: run.session_id! })} />
        ) : null}
      </Section>
      {run.error_message ? <Text style={styles.error}>{run.error_message}</Text> : null}
      {detail.tool_calls.length ? (
        <Section header={t('runs.tools', { n: detail.tool_calls.length })}>
          {detail.tool_calls.map((call) => (
            <Row
              key={call.id}
              title={toolLabel(call.tool_name)}
              subtitle={call.error_message ?? undefined}
              accessory={<Badge label={call.status} tone={TONE[call.status] ?? 'neutral'} />}
            />
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
  error: { ...typo.footnote, color: c.red, marginHorizontal: space.margin + space.xs, marginBottom: space.lg },
}));
