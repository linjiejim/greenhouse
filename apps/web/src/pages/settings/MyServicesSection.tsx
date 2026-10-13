/**
 * 设置 → 我的服务 (SET-07): my own keys where an admin allows them. A key here serves only my
 * calls and its usage is mine; the workspace's serves me otherwise.
 */

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, Empty, ErrorBox, Skeleton, StatusBadge, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { ProviderCapability, ProviderInstance } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { keys } from '../../data/query';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { CAPABILITY_LABEL, InstanceDrawer, InstanceRow, type InstanceApi } from '../providers/Instances';

export function MyServicesSection() {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const data = useQuery({ queryKey: keys.myProviders, queryFn: () => api.me.providers() });
  const [editing, setEditing] = useState<{ capability: ProviderCapability; instance?: ProviderInstance } | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: keys.myProviders });
  const failed = (error: unknown) => notify(error instanceof ApiClientError ? error.message : t('common.error'));
  const instanceApi: InstanceApi = useMemo(
    () => ({
      create: async (input) => {
        await api.me.addProvider(input);
        await client.invalidateQueries({ queryKey: keys.myProviders });
        await client.invalidateQueries({ queryKey: keys.me });
      },
      update: async (id, input) => {
        await api.me.updateProvider(id, input);
        await client.invalidateQueries({ queryKey: keys.myProviders });
      },
    }),
    [client],
  );

  if (data.isPending) return <Skeleton lines={4} />;
  if (data.isError) return <ErrorBox onRetry={() => void data.refetch()}>{t('common.error')}</ErrorBox>;
  if (!data.data.capabilities.length) return <Empty title={t('myServices.none')} />;

  const actionsFor = (instance: ProviderInstance): MenuEntry[] => [
    {
      label: t('provider.test'),
      onClick: () =>
        void api.me
          .testProvider(instance.id)
          .then((result) => {
            notify(result.last_check?.ok ? t('provider.testOk') : t('provider.testFailed'));
            return refresh();
          })
          .catch(failed),
    },
    { label: t('provider.edit'), onClick: () => setEditing({ capability: instance.capability, instance }) },
    '-',
    {
      label: t('row.delete'),
      danger: true,
      onClick: () =>
        void api.me
          .removeProvider(instance.id)
          .then(() => refresh())
          .catch(failed),
    },
  ];

  return (
    <>
      {data.data.capabilities.map((entry) => (
        <section key={entry.capability} className="app-section">
          <div className="app-section-heading">
            <h2 className="app-section-title">{t(CAPABILITY_LABEL[entry.capability])}</h2>
            <StatusBadge
              status={
                entry.active === 'personal'
                  ? t('myServices.usingMine')
                  : entry.active === 'workspace'
                    ? t('myServices.usingWorkspace')
                    : t('provider.notConfigured')
              }
              tone="neutral"
            />
          </div>
          {entry.instances.length > 0 && (
            <ul className="app-list">
              {entry.instances.map((instance) => (
                <InstanceRow key={instance.id} instance={instance} actions={actionsFor(instance)} />
              ))}
            </ul>
          )}
          {entry.allowed ? (
            <div>
              <Button onClick={() => setEditing({ capability: entry.capability })}>
                <Plus size={icon.md} />
                {t('myServices.add')}
              </Button>
            </div>
          ) : (
            <p className="app-muted">{t('myServices.notAllowed')}</p>
          )}
        </section>
      ))}
      {editing && (
        <InstanceDrawer
          capability={editing.capability}
          catalog={data.data.catalog}
          instance={editing.instance}
          api={instanceApi}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
