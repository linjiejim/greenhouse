import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorBox, Skeleton, Switch } from '@greenhouse/ui/kit';
import { OPERATION_SWITCHES, type OperationSwitch } from '@greenhouse/contract';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

export function OperationsSection() {
  const { t } = useI18n();
  const cache = useQueryClient();
  const key = ['admin', 'operations'];
  const state = useQuery({ queryKey: key, queryFn: () => api.admin.operations.get(), refetchInterval: 5000 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toggle = async (name: OperationSwitch, value: boolean) => {
    setSaving(true);
    try {
      cache.setQueryData(key, await api.admin.operations.update({ [name]: value }));
      setError('');
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setSaving(false);
    }
  };
  if (state.isPending) return <Skeleton lines={3} />;
  if (state.isError) return <ErrorBox onRetry={() => void state.refetch()}>{t('common.error')}</ErrorBox>;
  return (
    <section className="app-section">
      {error && <p role="alert">{error}</p>}
      {OPERATION_SWITCHES.map((name) => (
        <div className="app-setting-row" key={name}>
          <span className="app-setting-text">
            <strong>{t(`operations.${name}`)}</strong>
            <span>{t(`operations.${name}Hint`)}</span>
          </span>
          <Switch
            label={t(`operations.${name}`)}
            checked={state.data[name]}
            disabled={saving}
            onChange={(value) => void toggle(name, value)}
          />
        </div>
      ))}
    </section>
  );
}
