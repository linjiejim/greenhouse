/**
 * One agent write as an object sheet (`/sheet/write?id=<request id>`): which agent, what it did to what, how it was
 * allowed, when, and its input and result as the server recorded them. Read from my recent writes
 * (the server keeps the last 50 per member); an older one is "not in your recent list".
 */

import React, { useCallback, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { listAgentWrites } from '../../src/api/agent';
import { WRITE_TONE } from '../../src/agent/look';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import { makeStyles, mono, radius, space, squircle, typo, useTheme, weight } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { Badge, Row, Section } from '../../src/ui/list';
import { SheetScreen } from '../../src/ui/screen';

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2).slice(0, 8000);
  } catch {
    return '';
  }
}

export default function AgentWriteScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const resource = useResource(useCallback(() => listAgentWrites(), []));
  const write = useMemo(() => resource.data?.writes.find((entry) => entry.request_id === id) ?? null, [resource.data, id]);

  if (!write) {
    return (
      <>
        <SheetScreen title={t('nav.agent')} />
        {resource.loading ? (
          <LoadingState style={styles.state} />
        ) : resource.data ? (
          <EmptyState icon="sparkle" title={t('agent.notFound')} style={styles.state} />
        ) : (
          <EmptyState icon="alert" title={t('agent.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
        )}
      </>
    );
  }

  const blocks: [string, string][] = [
    [t('agent.input'), pretty(write.input)],
    [t('agent.output'), pretty(write.output)],
    [t('agent.error'), write.error ?? ''],
  ];
  return (
    <>
      <SheetScreen title={write.client_name} />
      <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <Section>
          <Row
            title={t('agent.action')}
            value={write.action ?? write.tool_id}
            accessory={<Badge label={t(`agent.status.${write.status}`)} tone={WRITE_TONE[write.status]} />}
          />
          <Row title={t('agent.target')} subtitle={write.target_label ?? t('agent.targetHidden')} accessory="none" />
          <Row title={t('agent.client')} value={write.client_name} accessory="none" />
          <Row title={t('agent.tool')} value={write.tool_id} accessory="none" />
          <Row
            title={t('agent.risk')}
            value={[write.risk.toUpperCase(), write.basis ? t(`agent.basis.${write.basis}`) : ''].filter(Boolean).join(' · ')}
            accessory="none"
          />
          <Row title={t('agent.started')} value={relativeTimeNow(write.created_at)} accessory="none" />
          {write.settled_at ? (
            <Row title={t('agent.settled')} value={relativeTimeNow(write.settled_at)} accessory="none" />
          ) : null}
        </Section>
        {blocks
          .filter(([, text]) => text)
          .map(([title, text]) => (
            <View key={title} style={styles.block}>
              <Text style={styles.blockTitle} accessibilityRole="header">
                {title}
              </Text>
              <Text style={styles.code} selectable>
                {text}
              </Text>
            </View>
          ))}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2, paddingTop: space.sm },
  state: { paddingTop: space.xxxl },
  block: { marginHorizontal: space.margin, marginTop: space.lg, gap: space.sm },
  blockTitle: { ...typo.headline, fontWeight: weight.semibold, color: c.label },
  code: {
    ...typo.footnote,
    fontFamily: mono,
    color: c.codeText,
    backgroundColor: c.codeBg,
    padding: space.md,
    borderRadius: radius.md,
    overflow: 'hidden',
    ...squircle,
  },
}));
