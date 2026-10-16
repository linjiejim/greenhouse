import { useCallback } from 'react';
import { Text } from 'react-native';
import { agentUsage } from '../api/agents';
import { useResource } from '../data/use-resource';
import { useLocale, useT } from '../lib/i18n';
import { makeStyles, space, typo, useTheme } from '../theme';
import { EmptyState, LoadingState } from '../ui/empty';
import { ListRow, ListSection } from '../ui/list';

export function AgentUsage({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useStyles(colors);
  const r = useResource(
    useCallback(() => agentUsage(id), [id]),
    ['run.updated'],
  );
  const data = r.data;
  const number = (n: number) => n.toLocaleString(locale);
  const cost = (micros: number) =>
    (micros / 1e6).toLocaleString(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  return (
    <ListSection
      header={t('integration.usage')}
      footer={data?.totals.unpriced ? t('integration.unknownCost') : undefined}
    >
      {!data ? (
        r.loading ? (
          <LoadingState />
        ) : (
          <EmptyState icon="alert" title={t('work.loadFailed')} onRetry={() => void r.refresh()} />
        )
      ) : (
        [
          ...data.budgets.map((budget) => (
            <ListRow
              key={budget.id}
              title={t('integration.budget')}
              titleLines={0}
              subtitle={t('integration.budgetSpent', {
                spent: budget.unit === 'tokens' ? number(budget.spent) + ' token' : cost(budget.spent),
                limit: budget.unit === 'tokens' ? number(budget.monthly_limit) + ' token' : cost(budget.monthly_limit),
              })}
              footer={
                budget.exceeded || !budget.enabled ? (
                  <Text style={styles.note}>
                    {t(budget.enabled ? 'integration.budgetExceeded' : 'integration.budgetDisabled')}
                  </Text>
                ) : undefined
              }
            />
          )),
          !data.budgets.length ? <ListRow key="budget" title={t('integration.noBudget')} titleLines={0} /> : null,
          <ListRow key="tokens" title={t('integration.tokens')} value={number(data.totals.tokens)} />,
          <ListRow key="cost" title={t('integration.cost')} subtitle={cost(data.totals.cost_micros)} titleLines={0} />,
          <ListRow key="replies" title={t('integration.replies')} value={number(data.turns.total)} />,
          <ListRow key="runs" title={t('integration.backgroundRuns')} value={number(data.background_runs.total)} />,
        ]
      )}
    </ListSection>
  );
}

const useStyles = makeStyles((c) => ({ note: { ...typo.footnote, color: c.secondaryLabel, paddingBottom: space.sm } }));
