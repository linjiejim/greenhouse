/**
 * My Agents (我的 Agent): this month's spend against my budget, the recent writes of the agents I
 * connected (tap one for its details), and my model-gateway keys — read-only; keys are created
 * and revoked on the web. Each part loads on its own and shows its own failure with a retry
 * (src/data/load-view.ts), so one failing neither hides nor blocks the others.
 */

import React, { useCallback } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useOpenObject } from '../../src/shell/open-object';
import { AgentAvatar } from '../../src/ui/avatar';
import { clientKindOf } from '../../src/ui/plant-avatar/agent-plant';
import { gatewayOverview, listAgentWrites, mySpend } from '../../src/api/agent';
import { WRITE_TONE } from '../../src/agent/look';
import { noAccess } from '../../src/data/access';
import { loadView } from '../../src/data/load-view';
import { budgetLeft, budgetShare, formatUsd } from '../../src/data/money';
import { useResource } from '../../src/data/use-resource';
import { useT, type TranslationKey } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { Badge, Row, Section, SectionFooter, SectionHeader } from '../../src/ui/list';

const SERVICES = new Set(['llm', 'vision', 'web_search', 'page_read', 'image_generation', 'computer']);

export default function MyAgents() {
  const t = useT();
  const openObject = useOpenObject();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const spend = useResource(useCallback(() => mySpend(), []));
  const writes = useResource(useCallback(() => listAgentWrites(), []));
  const gateway = useResource(useCallback(() => gatewayOverview(), []));
  const loading = spend.loading || writes.loading || gateway.loading;
  const refresh = () => {
    void spend.refresh();
    void writes.refresh();
    void gateway.refresh();
  };

  if (!spend.data && !writes.data && !gateway.data && !loading && noAccess(writes.error)) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('nav.agent') }} />
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          <EmptyState icon="hand" title={t('agent.loadFailed')} message={writes.error?.message || undefined} style={styles.state} />
        </ScrollView>
      </View>
    );
  }

  const budget = spend.data?.budget;
  const services = (spend.data?.by_service ?? []).filter((row) => row.cost_usd_micros > 0 || row.calls > 0);

  return (
    <>
      <Stack.Screen options={{ title: t('nav.agent') }} />
      <ScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading && !!(spend.data || writes.data)} onRefresh={refresh} />}
      >
        {/* ── this month ── */}
        {spend.data ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>{t('agent.spend')}</Text>
            <Text style={styles.amount} accessibilityLabel={`${t('agent.spent')} ${formatUsd(spend.data.totals.cost_usd_micros)}`}>
              {formatUsd(spend.data.totals.cost_usd_micros)}
            </Text>
            <Text style={styles.cardMeta}>{t('agent.calls', { n: spend.data.totals.calls })}</Text>
            {budget ? (
              <>
                <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no">
                  <View
                    style={[
                      styles.fill,
                      { width: `${Math.round(budgetShare(budget) * 100)}%` },
                      budgetShare(budget) >= 1 && { backgroundColor: c.red },
                    ]}
                  />
                </View>
                <Text style={styles.cardMeta}>
                  {`${t('agent.budget')} ${formatUsd(budget.limit_usd_micros)} · ${t('agent.left')} ${formatUsd(budgetLeft(budget))}`}
                </Text>
              </>
            ) : null}
          </View>
        ) : loadView(spend) === 'failed' ? (
          <SectionFailed title={t('agent.spend')} onRetry={() => void spend.refresh()} />
        ) : (
          <LoadingState style={styles.state} />
        )}
        {services.length ? (
          <Section header={t('agent.byService')}>
            {services.map((row) => (
              <Row
                key={row.key}
                title={SERVICES.has(row.key) ? t(`agent.service.${row.key}` as TranslationKey) : row.label || row.key}
                subtitle={t('agent.calls', { n: row.calls })}
                value={formatUsd(row.cost_usd_micros)}
                accessory="none"
              />
            ))}
          </Section>
        ) : null}

        {/* ── recent writes ── */}
        {writes.data ? (
          writes.data.writes.length ? (
            <Section header={t('agent.writes')}>
              {writes.data.writes.map((write) => (
                <Row
                  key={write.request_id}
                  title={`${write.client_name} · ${write.action ?? write.tool_id}`}
                  subtitle={[write.target_label ?? t('agent.targetHidden'), relativeTimeNow(write.created_at)].join(' · ')}
                  leading={<AgentAvatar kind={clientKindOf(write.client_name)} name={write.client_name} size={30} />}
                  accessory={<Badge label={t(`agent.status.${write.status}`)} tone={WRITE_TONE[write.status]} />}
                  onPress={() => openObject({ kind: 'write', id: write.request_id })}
                />
              ))}
            </Section>
          ) : (
            <EmptyState icon="sparkle" title={t('agent.writesEmpty')} message={t('agent.writesHint')} />
          )
        ) : loadView(writes) === 'failed' ? (
          <SectionFailed title={t('agent.writes')} onRetry={() => void writes.refresh()} />
        ) : null}

        {/* ── gateway keys ── */}
        {gateway.data ? (
          <>
            <Section header={t('agent.keys')}>
              {gateway.data.keys.length ? (
                gateway.data.keys.map((key) => (
                  <Row
                    key={key.id}
                    title={key.name}
                    subtitle={[
                      `${key.prefix}…`,
                      key.last_used_at ? t('agent.lastUsed', { when: relativeTimeNow(key.last_used_at) }) : t('agent.neverUsed'),
                      t('agent.keyMonth', { amount: formatUsd(key.month_spend_usd_micros), n: key.month_calls }),
                    ].join('\n')}
                    subtitleLines={3}
                    icon="key"
                    accessory={
                      <Badge
                        label={t(`agent.keyStatus.${key.status}`)}
                        tone={key.status === 'active' ? 'green' : 'neutral'}
                      />
                    }
                  />
                ))
              ) : (
                <Row title={t('agent.keysEmpty')} icon="key" accessory="none" />
              )}
            </Section>
            <SectionFooter text={gateway.data.enabled ? t('agent.keysHint') : t('agent.gatewayOff')} />
          </>
        ) : loadView(gateway) === 'failed' ? (
          <SectionFailed title={t('agent.keys')} onRetry={() => void gateway.refresh()} />
        ) : null}
      </ScrollView>
    </>
  );
}

/** One part that failed to load: its name, and a retry for that part alone. */
function SectionFailed({ title, onRetry }: { title: string; onRetry: () => void }) {
  const t = useT();
  return (
    <View>
      <SectionHeader title={title} />
      <EmptyState icon="alert" title={t('agent.partFailed')} onRetry={onRetry} style={{ paddingVertical: space.md }} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  card: {
    marginHorizontal: space.margin,
    marginTop: space.md,
    padding: space.lg,
    gap: space.xs,
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    ...squircle,
  },
  cardLabel: { ...typo.subheadline, color: c.secondaryLabel },
  amount: { ...typo.largeTitle, fontWeight: weight.bold, color: c.label, fontVariant: ['tabular-nums'] },
  cardMeta: { ...typo.footnote, color: c.secondaryLabel },
  track: { height: 6, borderRadius: radius.full, backgroundColor: c.tertiaryFill, overflow: 'hidden', marginTop: space.sm },
  fill: { height: 6, borderRadius: radius.full, backgroundColor: c.accent },
}));
