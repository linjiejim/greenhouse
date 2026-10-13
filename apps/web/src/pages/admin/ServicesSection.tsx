/**
 * 管理 → 服务 (ADM-04, ADM-12): each capability with what serves it now. A capability opens its
 * instances in fallback order (move up / down), add, test, copy an env one to edit, turn off,
 * the personal-key policy and, for models, the default / strong / fast picks. Without any model
 * service a banner says so first: nothing answers until one exists.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Plus } from 'lucide-react';
import {
  Banner,
  Button,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Overlay,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
  type MenuEntry,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { CapabilityState, ProviderCapability, ProviderInstance } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { CAPABILITY_LABEL, InstanceDrawer, InstanceRow, type InstanceApi } from '../providers/Instances';

const KEY = ['admin', 'providers'] as const;

/** `instance/model` choices for the llm defaults: every model each instance lists. */
function modelChoices(state: CapabilityState) {
  return state.instances.flatMap((instance) => {
    const models = (instance.config.models as { id: string; label?: string }[] | undefined) ?? [];
    const ids = models.length
      ? models.map((model) => model.id)
      : [String(instance.config.defaultModel ?? '')].filter(Boolean);
    return ids.map((id) => ({ value: `${instance.id}/${id}`, label: `${instance.name} / ${id}` }));
  });
}

function CapabilityDrawer({ capability, onClose }: { capability: ProviderCapability; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const data = useQuery({ queryKey: KEY, queryFn: () => api.admin.providers() });
  const [editing, setEditing] = useState<ProviderInstance | 'new' | null>(null);
  const state = data.data?.capabilities.find((item) => item.capability === capability);
  const refresh = () => client.invalidateQueries({ queryKey: KEY });
  const failed = (error: unknown) => notify(error instanceof ApiClientError ? error.message : t('common.error'));
  const bind = useMutation({
    mutationFn: (input: Parameters<typeof api.admin.setBinding>[1]) => api.admin.setBinding(capability, input),
    onSettled: refresh,
    onError: failed,
  });
  const instanceApi: InstanceApi = useMemo(
    () => ({
      create: async (input) => {
        await api.admin.createProvider(input);
        await refresh();
      },
      update: async (id, input) => {
        await api.admin.updateProvider(id, input);
        await refresh();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!state) {
    return (
      <Overlay title={t(CAPABILITY_LABEL[capability])} onClose={onClose}>
        {data.isError ? (
          <ErrorBox onRetry={() => void data.refetch()}>{t('common.error')}</ErrorBox>
        ) : (
          <Skeleton lines={4} />
        )}
      </Overlay>
    );
  }

  const byId = new Map(state.instances.map((instance) => [instance.id, instance]));
  const ordered = [
    ...state.order.map((id) => byId.get(id)).filter((item): item is ProviderInstance => !!item),
    ...state.instances.filter((instance) => !state.order.includes(instance.id)),
  ];
  const order = ordered.map((instance) => instance.id);
  const move = (index: number, delta: number) => {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    bind.mutate({ instance_ids: next, defaults: state.defaults, policy: state.policy });
  };
  const actionsFor = (instance: ProviderInstance): MenuEntry[] => [
    {
      label: t('provider.test'),
      onClick: () =>
        void api.admin
          .testProvider(instance.id)
          .then((result) => {
            notify(result.last_check?.ok ? t('provider.testOk') : t('provider.testFailed'));
            return refresh();
          })
          .catch(failed),
    },
    ...(instance.source === 'env'
      ? [
          {
            label: t('provider.copy'),
            onClick: () =>
              void api.admin
                .copyProvider(instance.id)
                .then(() => refresh())
                .catch(failed),
          },
        ]
      : instance.editable
        ? ([
            { label: t('provider.edit'), onClick: () => setEditing(instance) },
            '-',
            {
              label: t('row.delete'),
              danger: true,
              onClick: () =>
                void api.admin
                  .removeProvider(instance.id)
                  .then(() => refresh())
                  .catch(failed),
            },
          ] as MenuEntry[])
        : []),
  ];

  return (
    <Overlay title={t(CAPABILITY_LABEL[capability])} onClose={onClose}>
      <section className="app-section">
        {ordered.length ? (
          <>
            <ul className="app-list">
              {ordered.map((instance, index) => (
                <InstanceRow
                  key={instance.id}
                  instance={instance}
                  index={index}
                  actions={actionsFor(instance)}
                  extra={
                    ordered.length > 1 && (
                      <span className="app-inline-actions">
                        <IconButton
                          label={t('provider.up')}
                          size="sm"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp size={icon.sm} />
                        </IconButton>
                        <IconButton
                          label={t('provider.down')}
                          size="sm"
                          disabled={index === ordered.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown size={icon.sm} />
                        </IconButton>
                      </span>
                    )
                  }
                />
              ))}
            </ul>
            {ordered.length > 1 && <p className="app-muted">{t('provider.fallback')}</p>}
          </>
        ) : (
          <Empty title={t('provider.none')} description={t('provider.noneHint')} />
        )}
        <Button onClick={() => setEditing('new')}>
          <Plus size={icon.md} />
          {t('provider.addInstance')}
        </Button>
      </section>

      {capability === 'llm' && state.instances.length > 0 && (
        <section className="app-section">
          <h3 className="app-section-title">{t('provider.defaults')}</h3>
          {(['default', 'strong', 'fast'] as const).map((alias) => (
            <Field key={alias} label={t(`provider.alias.${alias}`)}>
              <Select
                label={t(`provider.alias.${alias}`)}
                value={String(state.defaults[alias] ?? '')}
                options={modelChoices(state)}
                placeholder={t('provider.aliasFirst')}
                onChange={(value) =>
                  bind.mutate({
                    instance_ids: order,
                    defaults: { ...state.defaults, [alias]: value },
                    policy: state.policy,
                  })
                }
              />
            </Field>
          ))}
        </section>
      )}

      <section className="app-section">
        <div className="app-setting-row is-plain">
          <span className="app-setting-text">
            <strong>{t('provider.allowPersonal')}</strong>
            <span>{t('provider.allowPersonalHint')}</span>
          </span>
          <Switch
            label={t('provider.allowPersonal')}
            checked={state.policy.allow_personal}
            onChange={(allow) =>
              bind.mutate({
                instance_ids: order,
                defaults: state.defaults,
                policy: { ...state.policy, allow_personal: allow },
              })
            }
          />
        </div>
      </section>

      {editing && (
        <InstanceDrawer
          capability={capability}
          catalog={data.data?.catalog ?? []}
          instance={editing === 'new' ? undefined : editing}
          api={instanceApi}
          onClose={() => setEditing(null)}
        />
      )}
    </Overlay>
  );
}

export function ServicesSection() {
  const { t } = useI18n();
  const data = useQuery({ queryKey: KEY, queryFn: () => api.admin.providers() });
  const [open, setOpen] = useState<ProviderCapability | null>(null);
  if (data.isPending) return <Skeleton lines={6} />;
  if (data.isError) return <ErrorBox onRetry={() => void data.refetch()}>{t('common.error')}</ErrorBox>;
  const noModel = !data.data.capabilities.find((state) => state.capability === 'llm')?.effective.length;
  return (
    <>
      {noModel && (
        <Banner
          tone="warning"
          action={
            <Button size="sm" kind="primary" onClick={() => setOpen('llm')}>
              {t('provider.addModel')}
            </Button>
          }
        >
          {t('provider.noModel')}
        </Banner>
      )}
      <ul className="app-list app-bordered">
        {data.data.capabilities.map((state) => {
          const serving = state.effective
            .map((id) => state.instances.find((instance) => instance.id === id)?.name)
            .filter(Boolean);
          return (
            <li key={state.capability}>
              <button type="button" className="app-list-row" onClick={() => setOpen(state.capability)}>
                <span className="app-list-main">
                  <span className="app-list-title">{t(CAPABILITY_LABEL[state.capability])}</span>
                  <span className="app-list-meta">{serving.length ? serving.join(' → ') : t('provider.notSetUp')}</span>
                </span>
                <StatusBadge
                  status={serving.length ? t('provider.available') : t('provider.notConfigured')}
                  tone={serving.length ? 'success' : 'neutral'}
                />
                <ChevronRight size={icon.md} className="app-row-muted" />
              </button>
            </li>
          );
        })}
      </ul>
      {open && <CapabilityDrawer capability={open} onClose={() => setOpen(null)} />}
    </>
  );
}
