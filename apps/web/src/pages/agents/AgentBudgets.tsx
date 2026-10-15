import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ConfirmDialog, Field, FieldGroup, Input, Select, Skeleton } from '@greenhouse/ui/kit';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { useDraftNavigation } from '../../lib/useDraftNavigation';
import { BudgetBar } from '../../shell/usage';

export function AgentBudgets({ agentId }: { agentId: string }) {
  const { t } = useI18n();
  const cache = useQueryClient();
  const key = ['agents', 'budgets', agentId];
  const budgets = useQuery({ queryKey: key, queryFn: () => api.agentBudgets.list(agentId) });
  const [unit, setUnit] = useState<'tokens' | 'usd_micros'>('tokens');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const navigation = useDraftNavigation(limit !== '', saving, () => setLimit(''));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(limit);
    if (!Number.isFinite(value) || value <= 0) return setError(t('budgets.limitRequired'));
    setSaving(true);
    try {
      await api.agentBudgets.save(agentId, {
        unit,
        monthly_limit: Math.round(value * (unit === 'usd_micros' ? 1_000_000 : 1)),
      });
      await cache.invalidateQueries({ queryKey: key });
      await cache.invalidateQueries({ queryKey: ['admin', 'budgets'] });
      setLimit('');
      setError('');
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="app-section" aria-label={t('budgets.agent')}>
      <h2 className="app-section-title">{t('budgets.agent')}</h2>
      {budgets.isPending ? (
        <Skeleton lines={2} />
      ) : budgets.isError ? (
        <p role="alert">{errorText(budgets.error, t)}</p>
      ) : (
        budgets.data.items.map((budget) => (
          <BudgetBar key={budget.id} spent={budget.spent} limit={budget.monthly_limit} unit={budget.unit} />
        ))
      )}
      <form className="app-form" onSubmit={(event) => void submit(event)}>
        <FieldGroup label={t('budgets.unit')}>
          <Select
            label={t('budgets.unit')}
            value={unit}
            options={[
              { value: 'tokens', label: t('usage.tokens') },
              { value: 'usd_micros', label: t('budgets.dollars') },
            ]}
            onChange={(value) => setUnit(value as typeof unit)}
          />
        </FieldGroup>
        <Field label={t('budgets.limit')} error={error || undefined}>
          <Input
            type="number"
            min={unit === 'tokens' ? 1 : 0.01}
            step={unit === 'tokens' ? 1 : 0.01}
            required
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" loading={saving}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      {navigation.asking && (
        <ConfirmDialog
          title={t('knowledge.discardTitle')}
          confirmLabel={t('knowledge.discard')}
          onCancel={navigation.cancel}
          onConfirm={navigation.discard}
        >
          {t('knowledge.discardBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}
