/**
 * Services & pricing (GET /api/admin/metering/overview?month=): the month's spend by member,
 * service, client and agent; every model's and paid service's price (config default or an
 * override set here); team, per-service, member-default and per-member monthly budgets; the model
 * gateway switch and every member's gateway key (revocable). A banner names what is in use unpriced.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useResource } from '../data/use-resource';
import { useT, localeOf, type TFunction } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { Icon } from '../ui/core';
import { confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import * as admin from './api';
import {
  AdminDialog,
  AdminPage,
  Badge,
  Callout,
  Card,
  Field,
  FlagSwitch,
  Kpis,
  Meter,
  SectionState,
  Tabs,
} from './kit.web';
import { useWrite } from './use-write';
import { USD_MICROS, dayLabel, formatUsd, formatUsdPrice, parseUsdInput, recentMonths } from './format';
import {
  clientKey,
  knownService,
  modelTarget,
  priceInput,
  priceText,
  serviceTarget,
  type PriceTarget,
} from './metering-model';
import type {
  Budget,
  BudgetScope,
  MeteringOverview,
  ServicePrice,
  ServiceProvider,
  SpendRow,
  TokenPrice,
} from './types';

type Tab = 'spend' | 'prices' | 'budgets' | 'gateway';

export function serviceName(key: string, t: TFunction): string {
  return knownService(key) ? t(`admin.metering.service.${key}`) : key;
}
function tokenPriceLabel(price: TokenPrice, t: TFunction): string {
  const base = t('admin.metering.tokenPrice', {
    input: formatUsdPrice(price.input),
    output: formatUsdPrice(price.output),
  });
  return price.cached_input === null
    ? base
    : `${base} · ${t('admin.metering.cachedPrice', { price: formatUsdPrice(price.cached_input) })}`;
}

export default function ServicesSection() {
  const t = useT();
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState(months[0]!);
  const [tab, setTab] = useState<Tab>('spend');
  const overview = useResource(useCallback(() => admin.meteringOverview(month), [month]));
  const data = overview.data;
  const refresh = () => void overview.refresh();
  return (
    <AdminPage
      title={t('admin.sections.services')}
      testID="admin-services"
      actions={
        <>
          {tab !== 'gateway' ? (
            <select
              className="gh-input"
              aria-label={t('admin.metering.month')}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : null}
          <button
            className="gh-icon-button"
            aria-label={t('common.refresh')}
            disabled={overview.loading}
            onClick={refresh}
          >
            <Icon name="refresh" size={16} />
          </button>
        </>
      }
      tabs={
        <Tabs
          label={t('admin.sections.services')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'spend', label: t('admin.metering.tabs.spend') },
            { value: 'prices', label: t('admin.metering.tabs.prices') },
            { value: 'budgets', label: t('admin.metering.tabs.budgets') },
            { value: 'gateway', label: t('admin.metering.tabs.gateway') },
          ]}
        />
      }
    >
      {tab === 'gateway' ? (
        <GatewayTab />
      ) : !data ? (
        <SectionState loading={overview.loading} error={overview.error} retry={refresh} />
      ) : (
        <>
          <UnpricedBanner overview={data} openPrices={() => setTab('prices')} />
          {tab === 'spend' ? (
            <SpendTab overview={data} />
          ) : tab === 'prices' ? (
            <PricesTab overview={data} changed={refresh} />
          ) : (
            <BudgetsTab overview={data} changed={refresh} />
          )}
        </>
      )}
    </AdminPage>
  );
}

function UnpricedBanner({ overview, openPrices }: { overview: MeteringOverview; openPrices: () => void }) {
  const t = useT();
  const { models, services } = overview.unpriced_in_use;
  const count = models.length + services.length;
  if (!count) return null;
  const names = [
    ...models.map((id) => overview.models.find((m) => m.id === id)?.name ?? id),
    ...services.map((s) => `${serviceName(s.service, t)} · ${s.provider}`),
  ];
  return (
    <Callout
      testID="admin-unpriced"
      action={
        <button className="gh-secondary-button" onClick={openPrices}>
          {t('admin.metering.setPrices')}
        </button>
      }
    >
      <strong>{t('admin.metering.unpricedBanner', { n: count })}</strong>
      <div>{names.join(t('common.listSep'))}</div>
    </Callout>
  );
}

// ─── Spend ───────────────────────────────────────────────

function SpendTab({ overview }: { overview: MeteringOverview }) {
  const t = useT();
  const { spend } = overview;
  return (
    <>
      <Kpis
        items={[
          { label: t('admin.metering.totalSpent'), value: formatUsd(spend.totals.cost_usd_micros) },
          { label: t('admin.metering.calls'), value: spend.totals.calls.toLocaleString() },
          {
            label: t('admin.metering.unpricedCalls'),
            value: spend.totals.unpriced_calls.toLocaleString(),
            hint: t('admin.metering.unpricedHint'),
            tone: spend.totals.unpriced_calls > 0 ? 'warning' : undefined,
          },
          {
            label: t('admin.metering.unsettled'),
            value: formatUsd(spend.unsettled_usd_micros),
            hint: t('admin.metering.unsettledHint'),
          },
        ]}
      />
      {spend.totals.unpriced_calls > 0 ? <p className="gh-hint">{t('admin.metering.unpricedHint')}</p> : null}
      <div className="gh-admin-grid-2">
        <SpendCard
          title={t('admin.metering.byMember')}
          icon="users"
          head={t('admin.metering.member')}
          rows={spend.by_member}
          label={(r) => r.label ?? (r.key || t('admin.metering.client.unknown'))}
        />
        <SpendCard
          title={t('admin.metering.byService')}
          icon="pricing"
          head={t('admin.metering.serviceCol')}
          rows={spend.by_service}
          label={(r) => serviceName(r.key, t)}
        />
        <SpendCard
          title={t('admin.metering.byClient')}
          icon="computer"
          head={t('admin.metering.client.title')}
          rows={spend.by_client}
          label={(r) => t(`admin.metering.client.${clientKey(r.key)}`)}
        />
        <SpendCard
          title={t('admin.metering.byAgent')}
          icon="sparkle"
          head={t('admin.metering.agent')}
          rows={spend.by_agent_client}
          label={(r) => r.label ?? r.key}
        />
      </div>
    </>
  );
}

function SpendCard({
  title,
  icon,
  head,
  rows,
  label,
}: {
  title: string;
  icon: React.ComponentProps<typeof Card>['icon'];
  head: string;
  rows: SpendRow[];
  label: (row: SpendRow) => string;
}) {
  const t = useT();
  return (
    <Card title={title} icon={icon} flush>
      {rows.length ? (
        <table className="gh-data-grid gh-admin-grid">
          <thead>
            <tr>
              <th>{head}</th>
              <th className="gh-number">{t('admin.metering.calls')}</th>
              <th className="gh-number">{t('admin.metering.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key || '-'}>
                <td title={row.key}>
                  {label(row)}{' '}
                  {row.unpriced_calls > 0 ? (
                    <Badge tone="warning">{t('admin.metering.unpricedCount', { n: row.unpriced_calls })}</Badge>
                  ) : null}
                </td>
                <td className="gh-number">{row.calls.toLocaleString()}</td>
                <td className="gh-number">{formatUsd(row.cost_usd_micros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="gh-admin-empty-line">{t('admin.metering.noSpend')}</p>
      )}
    </Card>
  );
}

// ─── Prices ──────────────────────────────────────────────

function ServicePriceText({ service, provider }: { service: ServicePrice; provider: ServiceProvider }) {
  const t = useT();
  if (!provider.priced) return <Badge tone="warning">{t('admin.metering.unpriced')}</Badge>;
  const parts: string[] = [];
  if (provider.price !== null && service.unit !== 'token')
    parts.push(t(`admin.metering.perUnit.${service.unit}`, { price: formatUsdPrice(provider.price) }));
  for (const [quality, sizes] of Object.entries(provider.price_by_size ?? {}))
    for (const [size, usd] of Object.entries(sizes)) parts.push(`${quality} ${size} ${formatUsdPrice(usd)}`);
  if (provider.token_price) parts.push(tokenPriceLabel(provider.token_price, t));
  return <>{parts.join(' · ')}</>;
}

function PriceActions({ overridden, edit, reset }: { overridden: boolean; edit: () => void; reset: () => void }) {
  const t = useT();
  return (
    <>
      {overridden ? <Badge tone="accent">{t('admin.metering.source.override')}</Badge> : null}
      <button className="gh-link-button" onClick={edit}>
        {t('admin.metering.setPrice')}
      </button>
      {overridden ? (
        <button className="gh-link-button" onClick={reset}>
          {t('admin.metering.useConfig')}
        </button>
      ) : null}
    </>
  );
}

function PricesTab({ overview, changed }: { overview: MeteringOverview; changed: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState<PriceTarget | null>(null);
  const { run } = useWrite();
  const reset = async (kind: 'model' | 'service', target: string, provider?: string) => {
    if (await run(() => admin.resetPrice(kind, target, provider), t('admin.metering.priceFailed'))) {
      toast(t('admin.metering.priceReset'));
      changed();
    }
  };
  const statusBadge = (enabled: boolean, configured: boolean) =>
    !enabled ? (
      <Badge>{t('admin.metering.notEnabled')}</Badge>
    ) : configured ? (
      <Badge tone="success">{t('admin.metering.configured')}</Badge>
    ) : (
      <Badge>{t('admin.metering.notConfigured')}</Badge>
    );
  return (
    <>
      <p className="gh-hint">{t('admin.metering.pricesHint')}</p>
      <Card title={t('admin.metering.services')} icon="pricing" flush testID="admin-prices-services">
        <table className="gh-data-grid gh-admin-grid">
          <thead>
            <tr>
              <th>{t('admin.metering.serviceCol')}</th>
              <th>{t('admin.metering.provider')}</th>
              <th>{t('admin.metering.status')}</th>
              <th>{t('admin.metering.price')}</th>
              <th aria-label={t('admin.actions')} />
            </tr>
          </thead>
          <tbody>
            {overview.services.flatMap((service) =>
              service.providers.map((provider, index) => (
                <tr key={`${service.service}:${provider.provider}`}>
                  <td>{index === 0 ? serviceName(service.service, t) : ''}</td>
                  <td className="gh-mono">{provider.provider}</td>
                  <td>{statusBadge(service.enabled, provider.configured)}</td>
                  <td>
                    <ServicePriceText service={service} provider={provider} />
                  </td>
                  <td className="gh-admin-actions">
                    <PriceActions
                      overridden={provider.source === 'override'}
                      edit={() => setEditing(serviceTarget(service, provider, serviceName(service.service, t)))}
                      reset={() => void reset('service', service.service, provider.provider)}
                    />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </Card>
      <Card title={t('admin.metering.models')} icon="sparkle" flush testID="admin-prices-models">
        <table className="gh-data-grid gh-admin-grid">
          <thead>
            <tr>
              <th>{t('admin.metering.model')}</th>
              <th>{t('admin.metering.status')}</th>
              <th>{t('admin.metering.price')}</th>
              <th aria-label={t('admin.actions')} />
            </tr>
          </thead>
          <tbody>
            {overview.models.map((model) => (
              <tr key={model.id}>
                <td>
                  {model.name}
                  <span className="gh-admin-sub gh-mono">{model.id}</span>
                </td>
                <td>{statusBadge(true, model.configured)}</td>
                <td>
                  {model.price ? (
                    tokenPriceLabel(model.price, t)
                  ) : (
                    <Badge tone="warning">{t('admin.metering.unpriced')}</Badge>
                  )}
                </td>
                <td className="gh-admin-actions">
                  <PriceActions
                    overridden={model.source === 'override'}
                    edit={() => setEditing(modelTarget(model))}
                    reset={() => void reset('model', model.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing ? <PriceDialog target={editing} close={() => setEditing(null)} saved={changed} /> : null}
    </>
  );
}

function PriceDialog({ target, close, saved }: { target: PriceTarget; close: () => void; saved: () => void }) {
  const t = useT();
  const [typed, setTyped] = useState({
    input: priceText(target.current.input),
    output: priceText(target.current.output),
    cached: priceText(target.current.cached_input),
    unit: priceText(target.current.unit_price),
  });
  const { busy, run } = useWrite();
  const body = priceInput(target, typed);
  const tokens = target.unit === 'token';
  const field = (key: keyof typeof typed, label: string, required = true) => (
    <Field label={label} required={required}>
      {(id) => (
        <input
          id={id}
          inputMode="decimal"
          value={typed[key]}
          onChange={(e) => setTyped((v) => ({ ...v, [key]: e.target.value }))}
        />
      )}
    </Field>
  );
  const save = async () => {
    if (!body) return;
    if (await run(() => admin.savePrice(body), t('admin.metering.priceFailed'))) {
      toast(t('admin.metering.priceSaved'));
      saved();
      close();
    }
  };
  return (
    <AdminDialog
      size="sm"
      title={t('admin.metering.priceTitle', { name: target.name })}
      onClose={close}
      testID="admin-price-dialog"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="admin-price" className="gh-primary" disabled={busy || !body}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        id="admin-price"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="gh-hint">{t('admin.metering.priceHelp')}</p>
        {tokens ? (
          <>
            {field('input', t('admin.metering.inputPrice'))}
            {field('output', t('admin.metering.outputPrice'))}
            {field('cached', t('admin.metering.cachedInputPrice'), false)}
          </>
        ) : (
          field('unit', t('admin.metering.unitPrice', { unit: t(`admin.metering.unit.${target.unit}`) }))
        )}
      </form>
    </AdminDialog>
  );
}

// ─── Budgets ─────────────────────────────────────────────

interface BudgetTarget {
  scope: BudgetScope;
  scopeId?: string;
  name: string;
  limit: number | null;
}

function BudgetsTab({ overview, changed }: { overview: MeteringOverview; changed: () => void }) {
  const t = useT();
  const { budgets } = overview;
  const [editing, setEditing] = useState<BudgetTarget | null>(null);
  const { run } = useWrite();
  const reset = async (target: BudgetTarget) => {
    if (target.scope === 'member') {
      const ok = await confirmAction({
        title: t('admin.metering.resetMemberTitle', { name: target.name }),
        message: t('admin.metering.resetMemberHint'),
        confirmLabel: t('admin.metering.reset'),
      });
      if (!ok) return;
    }
    if (await run(() => admin.resetBudget(target.scope, target.scopeId), t('admin.metering.limitFailed'))) {
      toast(t('admin.metering.limitReset'));
      changed();
    }
  };
  const row = (budget: Budget, name: string, hint?: string, balance = true) => {
    const target: BudgetTarget = {
      scope: budget.scope,
      scopeId: budget.scope === 'organization' || budget.scope === 'member_default' ? undefined : budget.scope_id,
      name,
      limit: budget.limit_usd_micros,
    };
    return (
      <tr key={`${budget.scope}:${budget.scope_id}`}>
        <td>
          {name}
          {hint ? <span className="gh-admin-sub">{hint}</span> : null}
        </td>
        <td className="gh-number">{formatUsd(budget.limit_usd_micros)}</td>
        <td className="gh-number">{balance ? formatUsd(budget.spent_usd_micros) : '—'}</td>
        <td className="gh-number">{balance ? formatUsd(budget.reserved_usd_micros) : '—'}</td>
        <td style={{ width: 140 }}>
          {balance ? (
            <Meter
              spent={budget.spent_usd_micros}
              reserved={budget.reserved_usd_micros}
              limit={budget.limit_usd_micros}
              label={name}
            />
          ) : null}
        </td>
        <td>
          <Badge tone={budget.source === 'override' ? 'accent' : 'neutral'}>
            {t(`admin.metering.source.${budget.source}`)}
          </Badge>
        </td>
        <td className="gh-admin-actions">
          <button className="gh-link-button" onClick={() => setEditing(target)}>
            {t('admin.metering.edit')}
          </button>
          {budget.source === 'override' ? (
            <button className="gh-link-button" onClick={() => void reset(target)}>
              {t('admin.metering.reset')}
            </button>
          ) : null}
        </td>
      </tr>
    );
  };
  const head = (first: string) => (
    <thead>
      <tr>
        <th>{first}</th>
        <th className="gh-number">{t('admin.metering.limit')}</th>
        <th className="gh-number">{t('admin.metering.spent')}</th>
        <th className="gh-number">{t('admin.metering.reserved')}</th>
        <th>{t('admin.metering.used')}</th>
        <th>{t('admin.metering.sourceCol')}</th>
        <th aria-label={t('admin.actions')} />
      </tr>
    </thead>
  );
  return (
    <>
      <p className="gh-hint">{t('admin.metering.limitHelp')}</p>
      <Card title={t('admin.metering.limits')} icon="pricing" flush testID="admin-budgets">
        <table className="gh-data-grid gh-admin-grid">
          {head(t('admin.metering.scope'))}
          <tbody>
            {row(budgets.organization, t('admin.metering.organization'))}
            {row(
              budgets.member_default,
              t('admin.metering.memberDefault'),
              t('admin.metering.memberDefaultHint'),
              false,
            )}
            {budgets.services.map((b) => row(b, serviceName(b.scope_id, t)))}
          </tbody>
        </table>
      </Card>
      <Card
        title={t('admin.metering.memberLimits')}
        icon="users"
        flush
        testID="admin-member-limits"
        actions={
          <button className="gh-secondary-button" onClick={() => setEditing({ scope: 'member', name: '', limit: null })}>
            <Icon name="plus" size={14} />
            {t('admin.metering.addMemberLimit')}
          </button>
        }
      >
        {budgets.members.length ? (
          <table className="gh-data-grid gh-admin-grid">
            {head(t('admin.metering.member'))}
            <tbody>{budgets.members.map((b) => row(b, b.label ?? b.scope_id))}</tbody>
          </table>
        ) : (
          <p className="gh-admin-empty-line">{t('admin.metering.noMemberLimits')}</p>
        )}
      </Card>
      {editing ? <BudgetDialog target={editing} close={() => setEditing(null)} saved={changed} /> : null}
    </>
  );
}

function BudgetDialog({ target, close, saved }: { target: BudgetTarget; close: () => void; saved: () => void }) {
  const t = useT();
  const adding = target.scope === 'member' && !target.scopeId;
  const [member, setMember] = useState('');
  const [value, setValue] = useState(target.limit === null ? '' : String(target.limit / USD_MICROS));
  const { busy, run } = useWrite();
  const micros = parseUsdInput(value);
  const scopeId = adding ? member : target.scopeId;
  const ready = micros !== null && (!adding || !!member);
  const save = async () => {
    if (!ready) return;
    if (await run(() => admin.saveBudget(target.scope, micros!, scopeId), t('admin.metering.limitFailed'))) {
      toast(t('admin.metering.limitSaved'));
      saved();
      close();
    }
  };
  return (
    <AdminDialog
      size="sm"
      title={adding ? t('admin.metering.addMemberLimit') : t('admin.metering.limitTitle', { name: target.name })}
      onClose={close}
      testID="admin-budget-dialog"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="admin-budget" className="gh-primary" disabled={busy || !ready}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        id="admin-budget"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {adding ? (
          <Field label={t('admin.metering.member')} required>
            {(id) => <MemberSelect id={id} value={member} onChange={setMember} />}
          </Field>
        ) : null}
        <Field
          label={t('admin.metering.limitUsd')}
          help={t('admin.metering.limitHelp')}
          error={value && micros === null ? t('admin.metering.invalidAmount') : null}
        >
          {(id) => <input id={id} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
      </form>
    </AdminDialog>
  );
}

/** Team members and supers, by name (the station's user list). */
export function MemberSelect({ id, value, onChange }: { id: string; value: string; onChange: (id: string) => void }) {
  const t = useT();
  const users = useResource(useCallback(() => admin.listUsers(), []));
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{users.loading && !users.data ? t('common.loading') : '—'}</option>
      {(users.data?.users ?? [])
        .filter((u) => u.role === 'team' || u.role === 'super')
        .map((u) => (
          <option key={u.id} value={u.id}>
            {u.nickname || u.email}
          </option>
        ))}
    </select>
  );
}

// ─── Gateway keys ────────────────────────────────────────

function GatewayTab() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const keys = useResource(useCallback(() => admin.gatewayKeys(), []));
  const { busy, run } = useWrite();
  const setSwitch = async (next: boolean | null) => {
    if (await run(() => admin.saveSettings({ 'gateway.enabled': next }), t('admin.saveFailed'))) {
      toast(t('admin.gateway.switchSaved'));
      void keys.refresh();
    }
  };
  const revoke = async (id: string, name: string, owner: string) => {
    const ok = await confirmAction({
      title: t('admin.gateway.revokeTitle', { name }),
      message: t('admin.gateway.revokeHint', { owner }),
      confirmLabel: t('admin.gateway.revoke'),
      destructive: true,
    });
    if (!ok) return;
    if (await run(() => admin.revokeGatewayKey(id), t('admin.gateway.revokeFailed'))) {
      toast(t('admin.gateway.revoked'));
      void keys.refresh();
    }
  };
  if (!keys.data) return <SectionState loading={keys.loading} error={keys.error} retry={() => void keys.refresh()} />;
  return (
    <>
      <Card title={t('admin.gateway.switch')} icon="sparkle">
        <FlagSwitch
          testID="admin-gateway-switch"
          state={keys.data.switch}
          env="GATEWAY_ENABLED"
          label={t('admin.gateway.switch')}
          help={t('admin.gateway.switchHelp')}
          busy={busy}
          onChange={(next) => void setSwitch(next)}
        />
      </Card>
      <Card title={t('admin.metering.tabs.gateway')} icon="key" hint={t('admin.gateway.intro')} flush>
        {keys.data.keys.length ? (
          <table className="gh-data-grid gh-admin-grid" data-testid="admin-gateway-keys">
            <thead>
              <tr>
                <th>{t('admin.gateway.owner')}</th>
                <th>{t('admin.gateway.key')}</th>
                <th>{t('admin.gateway.models')}</th>
                <th>{t('admin.metering.status')}</th>
                <th className="gh-number">{t('admin.gateway.month')}</th>
                <th>{t('admin.gateway.lastUsed')}</th>
                <th aria-label={t('admin.actions')} />
              </tr>
            </thead>
            <tbody>
              {keys.data.keys.map((key) => {
                const owner = key.owner.name ?? key.owner.id;
                return (
                  <tr key={key.id} data-muted={key.status !== 'active' ? '' : undefined}>
                    <td>{owner}</td>
                    <td>
                      {key.name}
                      <span className="gh-admin-sub gh-mono">{key.prefix}…</span>
                    </td>
                    <td>
                      {key.allowed_models ? (
                        <span className="gh-chip-row">
                          {key.allowed_models.slice(0, 3).map((m) => (
                            <Badge key={m}>{m}</Badge>
                          ))}
                          {key.allowed_models.length > 3 ? <Badge>+{key.allowed_models.length - 3}</Badge> : null}
                        </span>
                      ) : (
                        t('admin.gateway.allModels')
                      )}
                    </td>
                    <td>
                      <Badge
                        tone={key.status === 'active' ? 'success' : key.status === 'expired' ? 'warning' : 'neutral'}
                      >
                        {key.status === 'active' || key.status === 'expired' || key.status === 'revoked'
                          ? t(`admin.gateway.status.${key.status as 'active' | 'expired' | 'revoked'}`)
                          : key.status}
                      </Badge>
                    </td>
                    <td className="gh-number">
                      {formatUsd(key.month_spend_usd_micros)}
                      <span className="gh-admin-sub">{t('admin.gateway.calls', { n: key.month_calls })}</span>
                    </td>
                    <td>{dayLabel(key.last_used_at, localeOf(lang)) ?? t('admin.gateway.neverUsed')}</td>
                    <td className="gh-admin-actions">
                      {key.status === 'active' ? (
                        <button
                          className="gh-link-button"
                          disabled={busy}
                          onClick={() => void revoke(key.id, key.name, owner)}
                        >
                          {t('admin.gateway.revoke')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="gh-admin-empty-line">{t('admin.gateway.empty')}</p>
        )}
      </Card>
    </>
  );
}
