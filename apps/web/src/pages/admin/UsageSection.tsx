import { errorText } from '../../lib/errors';
import { useOverlayDraft } from '../../lib/useOverlayDraft';
import { WeeklyMetrics } from './WeeklyMetrics';
/**
 * 管理 → 用量 (ADM-07): the workspace's usage this month or the last 30 days, grouped by
 * member, Agent, service or capability, and the monthly budgets at the three levels (calls a
 * spent budget covers are refused until the month ends or the limit rises).
 */

import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  FieldGroup,
  Input,
  Menu,
  Overlay,
  OverlayActions,
  Segmented,
  Select,
  Skeleton,
  StatusBadge,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { AdminUsage, Budget, BudgetInput } from '@greenhouse/contract';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { BudgetBar, formatCost, formatHitRate, formatTokens, VoiceUsage } from '../../shell/usage';

const BUDGETS = ['admin', 'budgets'] as const;

function BudgetDrawer({ budget, onClose }: { budget: Budget | null; onClose: () => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const members = useQuery({ queryKey: ['members', 'directory'], queryFn: () => api.members.directory() });
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: () => api.admin.providers() });
  const [scope, setScope] = useState<BudgetInput['scope_type']>(budget?.scope_type ?? 'workspace');
  const agents = useQuery({
    queryKey: ['admin', 'public-agents'],
    queryFn: () => api.admin.publicAgents.list({ limit: 200 }),
    enabled: scope === 'agent',
  });
  const [scopeId, setScopeId] = useState(budget?.scope_type === 'workspace' ? '' : (budget?.scope_id ?? ''));
  const [unit, setUnit] = useState<BudgetInput['unit']>(budget?.unit ?? 'tokens');
  const [limit, setLimit] = useState(
    budget ? String(budget.unit === 'usd_micros' ? budget.monthly_limit / 1_000_000 : budget.monthly_limit) : '',
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dismiss = useOverlayDraft({ scope, scopeId, unit, limit }, saving, onClose);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(limit);
    if (!(value > 0)) return setError(t('budgets.limitRequired'));
    if (scope !== 'workspace' && !scopeId) return setError(t('budgets.scopeRequired'));
    if (saving) return;
    setSaving(true);
    try {
      await api.admin.budgets.save({
        scope_type: scope,
        ...(scope === 'workspace' ? {} : { scope_id: scopeId }),
        unit,
        monthly_limit: Math.round(unit === 'usd_micros' ? value * 1_000_000 : value),
      });
      await client.invalidateQueries({ queryKey: BUDGETS });
      onClose();
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setSaving(false);
    }
  };
  const instances = (providers.data?.capabilities ?? []).flatMap((state) => state.instances);
  return (
    <>
      <Overlay
        variant="dialog"
        title={budget ? t('budgets.edit') : t('budgets.add')}
        onClose={onClose}
        beforeClose={dismiss.beforeClose}
      >
        <form {...dismiss.formProps} id="budget" className="app-form" onSubmit={(event) => void submit(event)}>
          <FieldGroup label={t('budgets.scope')}>
            <Select
              label={t('budgets.scope')}
              value={scope}
              disabled={!!budget}
              options={[
                { value: 'workspace', label: t('budgets.workspace') },
                { value: 'provider', label: t('budgets.provider') },
                { value: 'member', label: t('budgets.member') },
                { value: 'agent', label: t('budgets.agent') },
              ]}
              onChange={(value) => {
                setScope(value as BudgetInput['scope_type']);
                setScopeId('');
              }}
            />
          </FieldGroup>
          {scope !== 'workspace' && (
            <FieldGroup
              label={
                scope === 'agent'
                  ? t('budgets.agent')
                  : scope === 'member'
                    ? t('budgets.member')
                    : t('budgets.provider')
              }
            >
              <Select
                label={
                  scope === 'agent'
                    ? t('budgets.agent')
                    : scope === 'member'
                      ? t('budgets.member')
                      : t('budgets.provider')
                }
                value={scopeId}
                disabled={!!budget}
                options={
                  scope === 'member'
                    ? (members.data?.items ?? []).map((member) => ({
                        value: member.id,
                        label: member.name,
                        description: member.email,
                      }))
                    : scope === 'agent'
                      ? (agents.data?.items ?? []).map((agent) => ({
                          value: agent.id,
                          label: agent.name,
                          description: agent.owner.name,
                        }))
                      : instances.map((instance) => ({
                          value: instance.id,
                          label: instance.name,
                          description: instance.kind,
                        }))
                }
                onChange={setScopeId}
              />
            </FieldGroup>
          )}
          <FieldGroup label={t('budgets.unit')}>
            <Segmented
              label={t('budgets.unit')}
              items={[
                { value: 'tokens', label: t('usage.tokens') },
                { value: 'usd_micros', label: t('budgets.dollars') },
              ]}
              value={unit}
              onChange={(value) => setUnit(value as BudgetInput['unit'])}
            />
          </FieldGroup>
          <Field label={t('budgets.limit')} required error={error || undefined}>
            <Input
              type="number"
              min={0}
              step={unit === 'usd_micros' ? 0.01 : 1000}
              value={limit}
              onChange={(event) => {
                setLimit(event.target.value);
                setError('');
              }}
            />
          </Field>
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="budget" loading={saving}>
            {t('common.save')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}

function Budgets() {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const budgets = useQuery({ queryKey: BUDGETS, queryFn: () => api.admin.budgets.list({ limit: 200 }) });
  const [editing, setEditing] = useState<Budget | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Budget | null>(null);
  const items = budgets.data?.items ?? [];
  const scopeLabel = (budget: Budget) =>
    budget.scope_type === 'workspace'
      ? t('budgets.workspace')
      : `${budget.scope_type === 'member' ? t('budgets.member') : budget.scope_type === 'agent' ? t('budgets.agent') : t('budgets.provider')} · ${budget.scope_name}`;
  return (
    <section className="app-section">
      <div className="app-section-heading">
        <h2 className="app-section-title">{t('budgets.title')}</h2>
        <Button onClick={() => setEditing('new')}>
          <Plus size={icon.md} />
          {t('budgets.add')}
        </Button>
      </div>
      {budgets.isPending ? (
        <Skeleton lines={2} />
      ) : budgets.isError ? (
        <ErrorBox onRetry={() => void budgets.refetch()}>{errorText(budgets.error, t)}</ErrorBox>
      ) : !items.length ? (
        <Empty title={t('budgets.none')} />
      ) : (
        <ul className="app-list">
          {items.map((budget) => (
            <li key={budget.id} className="app-list-row is-static app-budget-row">
              <span className="app-list-main">
                <span className="app-list-title">{scopeLabel(budget)}</span>
                <BudgetBar spent={budget.spent} limit={budget.monthly_limit} unit={budget.unit} />
              </span>
              {budget.exceeded && <StatusBadge status={t('budgets.exceeded')} tone="danger" />}
              <Menu
                label={t('row.actionsFor', { name: scopeLabel(budget) })}
                items={[
                  { label: t('members.edit'), onClick: () => setEditing(budget) },
                  '-',
                  { label: t('row.delete'), danger: true, onClick: () => setDeleting(budget) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {editing && <BudgetDrawer budget={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('budgets.deleteTitle', { name: scopeLabel(deleting) })}
          confirmLabel={t('row.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            void api.admin.budgets
              .remove(target.id)
              .then(() => client.invalidateQueries({ queryKey: BUDGETS }))
              .catch((error: unknown) => notify(errorText(error, t)));
          }}
        >
          {t('budgets.deleteBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}

export function UsageSection() {
  const { t, locale } = useI18n();
  const [period, setPeriod] = useState<'month' | '30d'>('month');
  const [group, setGroup] = useState<AdminUsage['group_by']>('member');
  const usage = useQuery({
    queryKey: ['admin', 'usage', period, group],
    queryFn: () => api.admin.usage({ period, group_by: group }),
  });
  return (
    <>
      <WeeklyMetrics />
      <div className="app-toolbar">
        <Segmented
          label={t('usage.period')}
          items={[
            { value: 'month', label: t('usage.thisMonth') },
            { value: '30d', label: t('usage.last30') },
          ]}
          value={period}
          onChange={(value) => setPeriod(value as 'month' | '30d')}
        />
        <Segmented
          label={t('usage.groupBy')}
          items={[
            { value: 'member', label: t('budgets.member') },
            { value: 'agent', label: t('nav.agents') },
            { value: 'provider', label: t('budgets.provider') },
            { value: 'capability', label: t('usage.capability') },
          ]}
          value={group}
          onChange={(value) => setGroup(value as AdminUsage['group_by'])}
        />
      </div>
      {usage.isPending ? (
        <Skeleton lines={5} />
      ) : usage.isError ? (
        <ErrorBox onRetry={() => void usage.refetch()}>{errorText(usage.error, t)}</ErrorBox>
      ) : (
        <>
          <div className="app-stats-grid">
            <div className="app-stat">
              <span className="app-stat-label">{t('usage.tokens')}</span>
              <span className="app-stat-value">{formatTokens(usage.data.totals.tokens, locale)}</span>
            </div>
            <div className="app-stat">
              <span className="app-stat-label">{t('usage.cost')}</span>
              <span className="app-stat-value">{formatCost(usage.data.totals.cost_micros, locale)}</span>
              {usage.data.totals.unpriced > 0 && (
                <span className="app-stat-hint">{t('usage.unpriced', { count: usage.data.totals.unpriced })}</span>
              )}
            </div>
            <div className="app-stat">
              <span className="app-stat-label">{t('usage.requests')}</span>
              <span className="app-stat-value">{usage.data.totals.requests.toLocaleString(locale)}</span>
            </div>
            <div className="app-stat">
              <span className="app-stat-label">{t('usage.cacheHitRate')}</span>
              <span className="app-stat-value">{formatHitRate(usage.data.totals.cache_hit_rate, locale)}</span>
            </div>
            <VoiceUsage totals={usage.data.totals} />
          </div>
          {usage.data.groups.length ? (
            <div className="app-table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>{t('usage.name')}</th>
                    <th className="is-number">{t('usage.tokens')}</th>
                    <th className="is-number">{t('usage.cost')}</th>
                    <th className="is-number">{t('usage.requests')}</th>
                    <th className="is-number">{t('usage.cacheHitRate')}</th>
                    <th className="is-number">{t('usage.sttSeconds')}</th>
                    <th className="is-number">{t('usage.ttsCharacters')}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.data.groups.map((row) => (
                    <tr key={row.key ?? 'none'}>
                      <td>
                        {row.label}
                        {row.detail && <span className="app-list-meta"> · {row.detail}</span>}
                      </td>
                      <td className="is-number">{row.tokens.toLocaleString(locale)}</td>
                      <td className="is-number">{formatCost(row.cost_micros, locale)}</td>
                      <td className="is-number">{row.requests.toLocaleString(locale)}</td>
                      <td className="is-number">{formatHitRate(row.cache_hit_rate, locale)}</td>
                      <td className="is-number">
                        {row.stt_seconds.toLocaleString(locale, { maximumFractionDigits: 2 })}
                      </td>
                      <td className="is-number">{row.tts_characters.toLocaleString(locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={t('usage.none')} />
          )}
        </>
      )}
      <Budgets />
    </>
  );
}
