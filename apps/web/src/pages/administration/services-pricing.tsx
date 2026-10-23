/**
 * Administration › Services & pricing (super only).
 *
 * Reads `GET /api/admin/metering/overview`:
 * - Spend: this month's USD spend by member, service, client and the agent
 *   (OAuth client) that made it over MCP; unpriced calls are flagged.
 * - Prices: every paid service and model with its price, or 未定价, and
 *   whether its key is configured. models.yaml / services.yaml are the
 *   defaults; a super's price here overrides them (`PUT /prices`) and applies
 *   to calls settled afterwards. A banner warns while anything in use is unpriced.
 * - Budgets: the team, per-service and member-default monthly limits with
 *   this month's spent / reserved, plus per-member overrides (CRUD). Writes go
 *   to `PUT / DELETE /api/admin/metering/budgets` and apply on the next call.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BudgetLimitInput,
  BudgetView,
  MeteringOverview,
  PriceOverrideInput,
  ServicePriceView,
  ServiceUnitKind,
  TokenPriceView,
} from '@greenhouse/types/metering';
import { defineCrud, CrudPage, type CrudDataSource } from '../settings/crud';
import { Button, Dialog, EmptyState, Input, Select, SkeletonCard, Tabs, Tag, toast } from '../../components/ui';
import { FormActions, FormField } from '../../components/form';
import { ModulePage } from '../../components/app/module-page';
import { SettingsSection } from '../../components/settings';
import { KpiCard } from '../../components/usage/usage-widgets';
import { BudgetBar, SpendTable } from '../../components/usage/spend-widgets';
import {
  AlertTriangle,
  Bot,
  Coins,
  Cpu,
  Layers,
  Pencil,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Users,
} from '../../lib/icons';
import { authFetch } from '../../lib/auth';
import {
  fetchMeteringOverview,
  resetBudgetLimit,
  resetPriceOverride,
  saveBudgetLimit,
  savePriceOverride,
} from '../../lib/api/metering';
import { useT } from '../../lib/i18n';
import {
  clientLabelKey,
  formatUsd,
  formatUsdPrice,
  pageOf,
  parseUsdInput,
  perUnitKey,
  serviceLabelKey,
  USD_MICROS,
} from '../../lib/metering/format';

type Translate = ReturnType<typeof useT>;
type TabKey = 'spend' | 'prices' | 'budgets';

interface EditTarget {
  scope: BudgetLimitInput['scope'];
  scopeId?: string;
  name: string;
  limit: number;
}

/** The current UTC month and the five before it, newest first. */
function recentMonths(): string[] {
  const now = new Date();
  return Array.from({ length: 6 }, (_, back) => {
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

function serviceName(service: string, t: Translate): string {
  const key = serviceLabelKey(service);
  return key ? t(key) : service;
}

function tokenPriceLabel(price: TokenPriceView, t: Translate): string {
  const base = t('metering.tokenPrice', {
    input: formatUsdPrice(price.input),
    output: formatUsdPrice(price.output),
  });
  return price.cached_input === null
    ? base
    : `${base} · ${t('metering.cachedPrice', { price: formatUsdPrice(price.cached_input) })}`;
}

function UnpricedTag() {
  const t = useT();
  return <Tag tone="warning">{t('metering.unpriced')}</Tag>;
}

function ServicePrice({
  service,
  provider,
}: {
  service: ServicePriceView;
  provider: ServicePriceView['providers'][number];
}) {
  const t = useT();
  if (!provider.priced) return <UnpricedTag />;
  const parts: string[] = [];
  const unitKey = perUnitKey(service.unit);
  if (provider.price !== null && unitKey) parts.push(t(unitKey, { price: formatUsdPrice(provider.price) }));
  if (provider.price_by_size) {
    for (const [quality, sizes] of Object.entries(provider.price_by_size)) {
      for (const [size, usd] of Object.entries(sizes)) parts.push(`${quality} ${size} ${formatUsdPrice(usd)}`);
    }
  }
  if (provider.token_price) parts.push(tokenPriceLabel(provider.token_price, t));
  return <span className="text-fg-secondary">{parts.join(' · ')}</span>;
}

function SourceTag({ source }: { source: BudgetView['source'] }) {
  const t = useT();
  return <Tag tone={source === 'override' ? 'primary' : 'neutral'}>{t(`metering.source.${source}`)}</Tag>;
}

// ─── Spend ───────────────────────────────────────────────

function SpendTab({ overview }: { overview: MeteringOverview }) {
  const t = useT();
  const { spend } = overview;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title={t('metering.totalSpent')}>
          <div className="text-xl font-semibold tabular-nums text-fg" data-testid="metering-total">
            {formatUsd(spend.totals.cost_usd_micros)}
          </div>
        </KpiCard>
        <KpiCard title={t('metering.calls')}>
          <div className="text-xl font-semibold tabular-nums text-fg">{spend.totals.calls.toLocaleString()}</div>
        </KpiCard>
        <KpiCard title={t('metering.unpricedCalls')}>
          <div
            className={`text-xl font-semibold tabular-nums ${spend.totals.unpriced_calls > 0 ? 'text-warning' : 'text-fg'}`}
            title={t('metering.unpricedHint')}
          >
            {spend.totals.unpriced_calls.toLocaleString()}
          </div>
        </KpiCard>
        <KpiCard title={t('metering.unsettled')}>
          <div className="text-xl font-semibold tabular-nums text-fg" title={t('metering.unsettledHint')}>
            {formatUsd(spend.unsettled_usd_micros)}
          </div>
        </KpiCard>
      </div>
      {spend.totals.unpriced_calls > 0 && <p className="text-xs text-fg-muted">{t('metering.unpricedHint')}</p>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SettingsSection title={t('metering.byMember')} icon={Users}>
          <SpendTable
            rows={spend.by_member}
            keyHeader={t('metering.member')}
            emptyLabel={t('metering.noSpend')}
            renderKey={(row) => (
              <span title={row.key}>{row.label ?? (row.key || t('metering.clientNames.unknown'))}</span>
            )}
          />
        </SettingsSection>
        <SettingsSection title={t('metering.byService')} icon={Layers}>
          <SpendTable
            rows={spend.by_service}
            keyHeader={t('metering.service')}
            emptyLabel={t('metering.noSpend')}
            renderKey={(row) => <span>{serviceName(row.key, t)}</span>}
          />
        </SettingsSection>
        <SettingsSection title={t('metering.byClient')} icon={Smartphone}>
          <SpendTable
            rows={spend.by_client}
            keyHeader={t('metering.client')}
            emptyLabel={t('metering.noSpend')}
            renderKey={(row) => <span>{t(clientLabelKey(row.key))}</span>}
          />
        </SettingsSection>
        <SettingsSection title={t('metering.byAgentClient')} icon={Bot}>
          <SpendTable
            rows={spend.by_agent_client}
            keyHeader={t('metering.agentClient')}
            emptyLabel={t('metering.noSpend')}
            renderKey={(row) => <span title={row.key}>{row.label ?? row.key}</span>}
          />
        </SettingsSection>
      </div>
    </div>
  );
}

// ─── Prices ──────────────────────────────────────────────

interface PriceTarget {
  kind: PriceOverrideInput['kind'];
  target: string;
  provider?: string;
  name: string;
  /** Token-priced (models, image understanding) vs per call / image / minute. */
  unit: ServiceUnitKind;
  current: { input?: number; output?: number; cached_input?: number | null; unit_price?: number };
}

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function parsePrice(value: string): number | null {
  const trimmed = value.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

function PriceEditDialog({
  target,
  onClose,
  onSaved,
}: {
  target: PriceTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cached, setCached] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!target) return;
    setInput(numberText(target.current.input));
    setOutput(numberText(target.current.output));
    setCached(numberText(target.current.cached_input));
    setUnitPrice(numberText(target.current.unit_price));
  }, [target]);

  const tokenPriced = target?.unit === 'token';
  const inputValue = parsePrice(input);
  const outputValue = parsePrice(output);
  const cachedValue = cached.trim() ? parsePrice(cached) : null;
  const unitValue = parsePrice(unitPrice);
  const valid = tokenPriced
    ? inputValue !== null && outputValue !== null && (cached.trim() === '' || cachedValue !== null)
    : unitValue !== null;
  const invalid = (text: string, parsed: number | null) =>
    text.trim() && parsed === null ? t('metering.invalidAmount') : undefined;

  const save = async () => {
    if (!target || !valid) return;
    setSaving(true);
    try {
      await savePriceOverride({
        kind: target.kind,
        target: target.target,
        ...(target.provider ? { provider: target.provider } : {}),
        ...(tokenPriced
          ? { input: inputValue!, output: outputValue!, cached_input: cachedValue }
          : { unit_price: unitValue! }),
      });
      toast(t('metering.priceSaved'), 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('metering.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      size="sm"
      title={t('metering.priceTitle', { name: target?.name ?? '' })}
    >
      <div className="space-y-3">
        <p className="text-xs leading-5 text-fg-muted">{t('metering.priceHelp')}</p>
        {tokenPriced ? (
          <>
            <FormField label={t('metering.inputPrice')} error={invalid(input, inputValue)} required>
              <Input
                value={input}
                inputMode="decimal"
                onChange={(e) => setInput(e.target.value)}
                data-testid="metering-price-input"
              />
            </FormField>
            <FormField label={t('metering.outputPrice')} error={invalid(output, outputValue)} required>
              <Input
                value={output}
                inputMode="decimal"
                onChange={(e) => setOutput(e.target.value)}
                data-testid="metering-price-output"
              />
            </FormField>
            <FormField label={t('metering.cachedInputPrice')} error={invalid(cached, cachedValue)}>
              <Input value={cached} inputMode="decimal" onChange={(e) => setCached(e.target.value)} />
            </FormField>
          </>
        ) : (
          <FormField
            label={t('metering.unitPrice', {
              unit: target && target.unit !== 'token' ? t(`metering.unitNames.${target.unit}`) : '',
            })}
            error={invalid(unitPrice, unitValue)}
            required
          >
            <Input
              value={unitPrice}
              inputMode="decimal"
              onChange={(e) => setUnitPrice(e.target.value)}
              data-testid="metering-price-unit"
            />
          </FormField>
        )}
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving || !valid} data-testid="metering-price-save">
            {t('common.save')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}

function PriceActions({
  overridden,
  onEdit,
  onReset,
}: {
  overridden: boolean;
  onEdit: () => void;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-end gap-1 whitespace-nowrap">
      {overridden ? <Tag tone="primary">{t('metering.source.override')}</Tag> : null}
      <Button size="sm" variant="ghost" onClick={onEdit}>
        <Pencil size={12} />
        {t('metering.editPrice')}
      </Button>
      {overridden && (
        <Button size="sm" variant="ghost" onClick={onReset}>
          <RotateCcw size={12} />
          {t('metering.resetPrice')}
        </Button>
      )}
    </div>
  );
}

function PricesTab({ overview, onChanged }: { overview: MeteringOverview; onChanged: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState<PriceTarget | null>(null);

  const reset = async (kind: PriceOverrideInput['kind'], target: string, provider?: string) => {
    try {
      await resetPriceOverride(kind, target, provider);
      toast(t('metering.priceReset'), 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('metering.saveFailed'), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-muted">{t('metering.pricesHint')}</p>
      <SettingsSection title={t('metering.services')} icon={Layers}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs" data-testid="metering-services">
            <thead>
              <tr className="text-fg-faint">
                <th className="pb-2 text-left font-medium">{t('metering.service')}</th>
                <th className="pb-2 text-left font-medium">{t('metering.provider')}</th>
                <th className="pb-2 text-left font-medium">{t('metering.status')}</th>
                <th className="pb-2 text-left font-medium">{t('metering.price')}</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {overview.services.flatMap((service) =>
                service.providers.map((provider, index) => (
                  <tr
                    key={`${service.service}:${provider.provider}`}
                    className="border-b border-edge text-fg-secondary"
                  >
                    <td className="py-1.5 pr-3 text-fg">{index === 0 ? serviceName(service.service, t) : ''}</td>
                    <td className="py-1.5 pr-3 font-mono">{provider.provider}</td>
                    <td className="py-1.5 pr-3">
                      {!service.enabled ? (
                        <Tag tone="neutral">{t('metering.notEnabled')}</Tag>
                      ) : provider.configured ? (
                        <Tag tone="success">{t('metering.configured')}</Tag>
                      ) : (
                        <Tag tone="neutral">{t('metering.notConfigured')}</Tag>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <ServicePrice service={service} provider={provider} />
                    </td>
                    <td className="py-1.5">
                      <PriceActions
                        overridden={provider.source === 'override'}
                        onEdit={() =>
                          setEditing({
                            kind: 'service',
                            target: service.service,
                            provider: provider.provider,
                            name: `${serviceName(service.service, t)} · ${provider.provider}`,
                            unit: service.unit,
                            current: {
                              ...(provider.token_price
                                ? {
                                    input: provider.token_price.input,
                                    output: provider.token_price.output,
                                    cached_input: provider.token_price.cached_input,
                                  }
                                : {}),
                              ...(provider.price !== null ? { unit_price: provider.price } : {}),
                            },
                          })
                        }
                        onReset={() => void reset('service', service.service, provider.provider)}
                      />
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </SettingsSection>
      <SettingsSection title={t('metering.models')} icon={Cpu}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs" data-testid="metering-models">
            <thead>
              <tr className="text-fg-faint">
                <th className="pb-2 text-left font-medium">{t('metering.models')}</th>
                <th className="pb-2 text-left font-medium">{t('metering.status')}</th>
                <th className="pb-2 text-left font-medium">{t('metering.price')}</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {overview.models.map((model) => (
                <tr key={model.id} className="border-b border-edge text-fg-secondary">
                  <td className="py-1.5 pr-3">
                    <span className="text-fg">{model.name}</span>{' '}
                    <span className="font-mono text-fg-faint">{model.id}</span>
                  </td>
                  <td className="py-1.5 pr-3">
                    <Tag tone={model.configured ? 'success' : 'neutral'}>
                      {model.configured ? t('metering.configured') : t('metering.notConfigured')}
                    </Tag>
                  </td>
                  <td className="py-1.5 pr-3">{model.price ? tokenPriceLabel(model.price, t) : <UnpricedTag />}</td>
                  <td className="py-1.5">
                    <PriceActions
                      overridden={model.source === 'override'}
                      onEdit={() =>
                        setEditing({
                          kind: 'model',
                          target: model.id,
                          name: model.name,
                          unit: 'token',
                          current: model.price
                            ? {
                                input: model.price.input,
                                output: model.price.output,
                                cached_input: model.price.cached_input,
                              }
                            : {},
                        })
                      }
                      onReset={() => void reset('model', model.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>
      <PriceEditDialog target={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
    </div>
  );
}

/** The 未定价 warning: anything configured and enabled that has no price counts as $0. */
function UnpricedBanner({ overview, onOpenPrices }: { overview: MeteringOverview; onOpenPrices: () => void }) {
  const t = useT();
  const { models, services } = overview.unpriced_in_use;
  const count = models.length + services.length;
  if (count === 0) return null;
  const names = [
    ...models.map((id) => overview.models.find((model) => model.id === id)?.name ?? id),
    ...services.map((entry) => `${serviceName(entry.service, t)} · ${entry.provider}`),
  ];
  return (
    <div
      role="status"
      data-testid="metering-unpriced-banner"
      className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-subtle px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-warning">
          <AlertTriangle size={14} aria-hidden="true" />
          {t('metering.unpricedBanner', { count })}
        </div>
        <div className="mt-0.5 truncate text-xs text-fg-secondary" title={names.join(', ')}>
          {names.join(', ')}
        </div>
      </div>
      <Button size="sm" variant="secondary" onClick={onOpenPrices}>
        {t('metering.unpricedBannerAction')}
      </Button>
    </div>
  );
}

// ─── Budgets ─────────────────────────────────────────────

function BudgetEditDialog({
  target,
  onClose,
  onSaved,
}: {
  target: EditTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (target) setValue(String(target.limit / USD_MICROS));
  }, [target]);
  const micros = parseUsdInput(value);

  const save = async () => {
    if (!target || micros === null) return;
    setSaving(true);
    try {
      await saveBudgetLimit({
        scope: target.scope,
        ...(target.scopeId ? { scope_id: target.scopeId } : {}),
        limit_usd_micros: micros,
      });
      toast(t('metering.saved'), 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('metering.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      size="sm"
      title={t('metering.editTitle', { name: target?.name ?? '' })}
    >
      <div className="space-y-3">
        <FormField
          label={t('metering.limitUsd')}
          help={t('metering.limitHelp')}
          error={value && micros === null ? t('metering.invalidAmount') : undefined}
        >
          <Input
            value={value}
            inputMode="decimal"
            onChange={(event) => setValue(event.target.value)}
            data-testid="metering-limit-input"
          />
        </FormField>
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving || micros === null} data-testid="metering-limit-save">
            {t('common.save')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}

function BudgetRow({
  name,
  hint,
  budget,
  showBalance,
  onEdit,
  onReset,
}: {
  name: string;
  hint?: string;
  budget: BudgetView;
  showBalance: boolean;
  onEdit: () => void;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <tr className="border-b border-edge text-fg-secondary">
      <td className="py-2 pr-3">
        <div className="text-fg">{name}</div>
        {hint && <div className="text-[11px] text-fg-faint">{hint}</div>}
      </td>
      <td className="py-2 pr-3 text-right font-mono tabular-nums text-fg">{formatUsd(budget.limit_usd_micros)}</td>
      <td className="py-2 pr-3 text-right font-mono tabular-nums">
        {showBalance ? formatUsd(budget.spent_usd_micros) : '—'}
      </td>
      <td className="py-2 pr-3 text-right font-mono tabular-nums">
        {showBalance ? formatUsd(budget.reserved_usd_micros) : '—'}
      </td>
      <td className="w-32 py-2 pr-3">
        {showBalance && (
          <BudgetBar
            spent={budget.spent_usd_micros}
            reserved={budget.reserved_usd_micros}
            limit={budget.limit_usd_micros}
          />
        )}
      </td>
      <td className="py-2 pr-3">
        <SourceTag source={budget.source} />
      </td>
      <td className="whitespace-nowrap py-2 text-right">
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label={t('metering.edit')}>
          <Pencil size={12} />
          {t('metering.edit')}
        </Button>
        {budget.source === 'override' && (
          <Button size="sm" variant="ghost" onClick={onReset} aria-label={t('metering.reset')}>
            <RotateCcw size={12} />
            {t('metering.reset')}
          </Button>
        )}
      </td>
    </tr>
  );
}

interface MemberLimitRow {
  id: string;
  name: string;
  limit_usd: string;
  limit_usd_micros: number;
  spent_usd_micros: number;
  reserved_usd_micros: number;
  source: BudgetView['source'];
}

interface AdminUser {
  id: string;
  email?: string | null;
  nickname?: string | null;
  role: string;
}

function MemberLimits({ month, version, onChanged }: { month: string; version: number; onChanged: () => void }) {
  const t = useT();

  const dataSource = useMemo<CrudDataSource<MemberLimitRow>>(
    () => ({
      async list(params) {
        void version;
        const overview = await fetchMeteringOverview(month);
        const items = overview.budgets.members.map((budget) => ({
          id: budget.scope_id,
          name: budget.label ?? budget.scope_id,
          limit_usd: String(budget.limit_usd_micros / USD_MICROS),
          limit_usd_micros: budget.limit_usd_micros,
          spent_usd_micros: budget.spent_usd_micros,
          reserved_usd_micros: budget.reserved_usd_micros,
          source: budget.source,
        }));
        // One page of the list, with the full count, so the pager is truthful.
        return pageOf(items, params);
      },
      async create(data) {
        const micros = parseUsdInput(String(data.limit_usd ?? ''));
        if (micros === null) throw new Error(t('metering.invalidAmount'));
        await saveBudgetLimit({ scope: 'member', scope_id: String(data.id ?? ''), limit_usd_micros: micros });
        onChanged();
        return null;
      },
      async update(id, data) {
        const micros = parseUsdInput(String(data.limit_usd ?? ''));
        if (micros === null) throw new Error(t('metering.invalidAmount'));
        await saveBudgetLimit({ scope: 'member', scope_id: id, limit_usd_micros: micros });
        onChanged();
        return null;
      },
      async remove(id) {
        await resetBudgetLimit('member', id);
        onChanged();
      },
    }),
    [month, version, onChanged, t],
  );

  const schema = useMemo(
    () =>
      defineCrud<MemberLimitRow>({
        name: t('metering.memberLimit'),
        idField: 'id',
        dataSource,
        pageSize: 50,
        storageKey: 'administration-member-limits',
        formMode: 'dialog',
        formSize: 'sm',
        testId: 'member-limits',
        emptyMessage: t('metering.noMemberLimits'),
        access: {
          canAdd: true,
          canEdit: true,
          canDelete: true,
          // Only an override can be dropped; a member on the default has nothing to reset.
          canDeleteRow: (row) => row.source === 'override',
        },
        formTitle: (mode, row) =>
          mode === 'add' ? t('metering.addMemberLimit') : t('metering.editTitle', { name: row?.name ?? '' }),
        deleteConfirm: (row) => ({ title: t('metering.reset'), description: row.name }),
        columns: [
          { key: 'name', label: t('metering.member'), type: 'text' },
          {
            key: 'limit_usd_micros',
            label: t('metering.limit'),
            type: 'custom',
            align: 'right',
            render: (row) => <span className="font-mono tabular-nums">{formatUsd(row.limit_usd_micros)}</span>,
          },
          {
            key: 'spent_usd_micros',
            label: t('metering.spent'),
            type: 'custom',
            align: 'right',
            render: (row) => <span className="font-mono tabular-nums">{formatUsd(row.spent_usd_micros)}</span>,
          },
          {
            key: 'reserved_usd_micros',
            label: t('metering.used'),
            type: 'custom',
            width: '9rem',
            render: (row) => (
              <BudgetBar spent={row.spent_usd_micros} reserved={row.reserved_usd_micros} limit={row.limit_usd_micros} />
            ),
          },
          {
            key: 'source',
            label: t('metering.scope'),
            type: 'custom',
            width: '8rem',
            render: (row) => <SourceTag source={row.source} />,
          },
        ],
        formFields: [
          {
            key: 'id',
            label: t('metering.memberField'),
            type: 'select',
            required: true,
            allows: { add: true, edit: false },
            options: async () => {
              const res = await authFetch('/api/admin/users');
              if (!res.ok) return [];
              const data = (await res.json()) as { users: AdminUser[] };
              return data.users
                .filter((user) => user.role === 'team' || user.role === 'super')
                .map((user) => ({ value: user.id, label: user.nickname || user.email || user.id }));
            },
          },
          {
            key: 'limit_usd',
            label: t('metering.limitUsd'),
            type: 'text',
            required: true,
            help: t('metering.limitHelp'),
            rules: [
              {
                validate: (value) => (parseUsdInput(String(value ?? '')) === null ? t('metering.invalidAmount') : null),
              },
            ],
          },
        ],
      }),
    [dataSource, t],
  );

  // The list is this month's balances: a new month or a budget change elsewhere on the page re-reads it.
  return <CrudPage key={`${month}:${version}`} schema={schema} />;
}

function BudgetsTab({
  overview,
  month,
  version,
  onChanged,
}: {
  overview: MeteringOverview;
  month: string;
  version: number;
  onChanged: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const { budgets } = overview;

  const reset = async (scope: BudgetLimitInput['scope'], scopeId?: string) => {
    try {
      await resetBudgetLimit(scope, scopeId);
      toast(t('metering.resetDone'), 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('metering.saveFailed'), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection title={t('metering.limit')} icon={Coins}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs" data-testid="metering-budgets">
            <thead>
              <tr className="text-fg-faint">
                <th className="pb-2 text-left font-medium">{t('metering.scope')}</th>
                <th className="pb-2 text-right font-medium">{t('metering.limit')}</th>
                <th className="pb-2 text-right font-medium">{t('metering.spent')}</th>
                <th className="pb-2 text-right font-medium">{t('metering.reserved')}</th>
                <th className="pb-2 text-left font-medium">{t('metering.used')}</th>
                <th className="pb-2 text-left font-medium" />
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              <BudgetRow
                name={t('metering.organization')}
                budget={budgets.organization}
                showBalance
                onEdit={() =>
                  setEditing({
                    scope: 'organization',
                    name: t('metering.organization'),
                    limit: budgets.organization.limit_usd_micros,
                  })
                }
                onReset={() => void reset('organization')}
              />
              <BudgetRow
                name={t('metering.memberDefault')}
                hint={t('metering.memberDefaultHint')}
                budget={budgets.member_default}
                showBalance={false}
                onEdit={() =>
                  setEditing({
                    scope: 'member_default',
                    name: t('metering.memberDefault'),
                    limit: budgets.member_default.limit_usd_micros,
                  })
                }
                onReset={() => void reset('member_default')}
              />
              {budgets.services.map((budget) => (
                <BudgetRow
                  key={budget.scope_id}
                  name={serviceName(budget.scope_id, t)}
                  budget={budget}
                  showBalance
                  onEdit={() =>
                    setEditing({
                      scope: 'service',
                      scopeId: budget.scope_id,
                      name: serviceName(budget.scope_id, t),
                      limit: budget.limit_usd_micros,
                    })
                  }
                  onReset={() => void reset('service', budget.scope_id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>
      <SettingsSection title={t('metering.memberLimits')} icon={Users}>
        <MemberLimits month={month} version={version} onChanged={onChanged} />
      </SettingsSection>
      <BudgetEditDialog target={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────

export function ServicesPricingPanel() {
  const t = useT();
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState(months[0]!);
  const [tab, setTab] = useState<TabKey>('spend');
  const [overview, setOverview] = useState<MeteringOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setOverview(await fetchMeteringOverview(month));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <ModulePage
      moduleId="admin.services"
      layout="list"
      actions={
        <>
          <Select
            size="sm"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            aria-label={t('metering.month')}
            data-testid="metering-month"
          >
            {months.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} />
            {t('common.refresh')}
          </Button>
        </>
      }
      notice={overview ? <UnpricedBanner overview={overview} onOpenPrices={() => setTab('prices')} /> : undefined}
      tabs={
        <Tabs
          tabs={[
            { key: 'spend', label: t('metering.tabs.spend') },
            { key: 'prices', label: t('metering.tabs.prices') },
            { key: 'budgets', label: t('metering.tabs.budgets') },
          ]}
          active={tab}
          onChange={(key) => setTab(key as TabKey)}
        />
      }
    >
      {loading && !overview ? (
        <SkeletonCard />
      ) : failed || !overview ? (
        <EmptyState icon={Coins} title={t('metering.loadFailed')} tone="danger" />
      ) : tab === 'spend' ? (
        <SpendTab overview={overview} />
      ) : tab === 'prices' ? (
        <PricesTab overview={overview} onChanged={changed} />
      ) : (
        <BudgetsTab overview={overview} month={month} version={version} onChanged={changed} />
      )}
    </ModulePage>
  );
}
