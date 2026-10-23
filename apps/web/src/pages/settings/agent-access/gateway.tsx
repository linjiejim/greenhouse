/**
 * Settings › Agent connections › Model gateway — the member's personal keys
 * for the OpenAI-compatible gateway, through which their own agents use the
 * team's models (metered to the member, like everything else they spend).
 * The secret is shown once, right after creation; only a prefix is kept.
 * While the workspace switch is off nothing can be created and calls are
 * refused; the page says an administrator has to turn it on.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { GatewayKeyView, GatewayOverview } from '@greenhouse/types/agent-access';
import { CrudPage, defineCrud, type CrudDataSource } from '../crud';
import { Button, Card, Dialog, Tag, TagList } from '../../../components/ui';
import { FormActions } from '../../../components/form';
import { AlertTriangle, Check, Copy, Cpu, Key } from '../../../lib/icons';
import { createGatewayKey, fetchGatewayOverview, revokeGatewayKey } from '../../../lib/api/gateway';
import { formatDate } from '../../../lib/utils';
import { formatUsd } from '../../../lib/metering/format';
import { useT } from '../../../lib/i18n';
import type { TagTone } from '../../../lib/utils';

type KeyRow = GatewayKeyView & { expires_in: string };

const EXPIRY_DAYS = ['30', '90', '365'] as const;
const STATUS_TONE: Record<GatewayKeyView['status'], TagTone> = {
  active: 'success',
  revoked: 'neutral',
  expired: 'warning',
};

export function CopyField({ value, testId }: { value: string; testId?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code
        className="flex-1 min-w-0 truncate text-xs font-mono text-fg bg-surface-sunken rounded-lg px-2.5 py-2"
        data-testid={testId}
      >
        {value}
      </code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        aria-label={t('agentAccess.copy')}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? t('agentAccess.copied') : t('agentAccess.copy')}
      </Button>
    </div>
  );
}

function SecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog open={secret !== null} onClose={onClose} size="md" title={t('gateway.secretTitle')}>
      <div className="space-y-3">
        <p className="text-xs leading-5 text-fg-secondary">{t('gateway.secretHelp')}</p>
        {secret && <CopyField value={secret} testId="gateway-secret" />}
        <FormActions>
          <Button onClick={onClose}>{t('gateway.secretDone')}</Button>
        </FormActions>
      </div>
    </Dialog>
  );
}

export function GatewayKeys({ onOpenGuide }: { onOpenGuide: () => void }) {
  const t = useT();
  const [overview, setOverview] = useState<GatewayOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      setOverview(await fetchGatewayOverview());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  const enabled = overview?.enabled ?? false;
  const models = useMemo(() => overview?.models ?? [], [overview]);

  const dataSource = useMemo<CrudDataSource<KeyRow>>(
    () => ({
      async list(params) {
        const rows = (await fetchGatewayOverview()).keys.map((key) => ({ ...key, expires_in: '' }));
        const skip = params.skip ?? 0;
        return { items: rows.slice(skip, skip + (params.limit ?? 50)), total: rows.length };
      },
      async create(data) {
        const days = Number(data.expires_in);
        const models = Array.isArray(data.allowed_models) ? data.allowed_models.map(String) : [];
        const created = await createGatewayKey({
          name: String(data.name ?? ''),
          allowed_models: models.length > 0 ? models : null,
          expires_at: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        });
        setSecret(created.secret);
        return null;
      },
      async remove(id) {
        await revokeGatewayKey(id);
      },
    }),
    [],
  );

  const schema = useMemo(
    () =>
      defineCrud<KeyRow>({
        name: t('gateway.key'),
        icon: Key,
        testId: 'settings-gateway-keys',
        dataSource,
        pageSize: 50,
        storageKey: 'settings-gateway-keys',
        onRowClick: 'none',
        formMode: 'dialog',
        formSize: 'sm',
        formTitle: () => t('gateway.createTitle'),
        columns: [
          {
            key: 'name',
            label: t('gateway.colName'),
            type: 'custom',
            render: (row) => (
              <div className="min-w-0">
                <div className="text-sm font-medium text-fg truncate" title={row.name}>
                  {row.name}
                </div>
                <div className="text-[10px] font-mono text-fg-faint truncate">{row.prefix}…</div>
              </div>
            ),
          },
          {
            key: 'allowed_models',
            label: t('gateway.colModels'),
            type: 'custom',
            render: (row) =>
              row.allowed_models ? (
                <TagList items={row.allowed_models} max={3} />
              ) : (
                <span className="text-xs text-fg-muted">{t('gateway.allModels')}</span>
              ),
          },
          {
            key: 'status',
            label: t('common.status'),
            type: 'custom',
            width: '6rem',
            render: (row) => <Tag tone={STATUS_TONE[row.status]}>{t(`gateway.status_${row.status}`)}</Tag>,
          },
          {
            key: 'expires_at',
            label: t('gateway.colExpires'),
            type: 'custom',
            width: '8rem',
            render: (row) => (
              <span className="text-xs text-fg-muted">
                {row.expires_at ? formatDate(row.expires_at) : t('gateway.never')}
              </span>
            ),
          },
          {
            key: 'month_spend_usd_micros',
            label: t('gateway.colSpend'),
            type: 'custom',
            align: 'right',
            width: '8rem',
            render: (row) => (
              <div className="text-right">
                <div className="font-mono tabular-nums text-xs text-fg">{formatUsd(row.month_spend_usd_micros)}</div>
                <div className="text-[10px] text-fg-faint">{t('gateway.callsCount', { count: row.month_calls })}</div>
              </div>
            ),
          },
          {
            key: 'last_used_at',
            label: t('gateway.colLastUsed'),
            type: 'custom',
            width: '9rem',
            render: (row) => (
              <span className="text-xs text-fg-muted">
                {row.last_used_at ? formatDate(row.last_used_at) : t('gateway.neverUsed')}
              </span>
            ),
          },
        ],
        formFields: [
          {
            key: 'name',
            label: t('gateway.fieldName'),
            type: 'text',
            required: true,
            maxLength: 80,
            placeholder: t('gateway.fieldNamePlaceholder'),
          },
          {
            key: 'allowed_models',
            label: t('gateway.fieldModels'),
            type: 'multi-select',
            help: t('gateway.fieldModelsHelp'),
            options: models.map((model) => ({ value: model.id, label: `${model.name} (${model.id})` })),
          },
          {
            key: 'expires_in',
            label: t('gateway.fieldExpiry'),
            type: 'select',
            defaultValue: '90',
            options: [
              ...EXPIRY_DAYS.map((days) => ({ value: days, label: t('gateway.expiryDays', { days }) })),
              { value: '0', label: t('gateway.never') },
            ],
          },
        ],
        access: {
          canView: false,
          canAdd: enabled,
          canEdit: false,
          canDelete: true,
          canDeleteRow: (row) => row.status === 'active',
        },
        deleteConfirm: (row) => ({
          title: t('gateway.revokeTitle', { name: row.name }),
          description: t('gateway.revokeDescription'),
        }),
        slots: {
          empty: (
            <div className="text-center py-12">
              <Key size={22} className="mx-auto text-fg-faint mb-2" />
              <p className="text-sm text-fg-muted">{t('gateway.empty')}</p>
            </div>
          ),
        },
      }),
    [dataSource, enabled, models, t],
  );

  return (
    <div className="space-y-4">
      {!enabled && overview && (
        <div
          className="rounded-lg border border-edge bg-warning-subtle p-3 flex items-start gap-2"
          data-testid="gateway-disabled"
        >
          <AlertTriangle size={15} className="text-warning flex-shrink-0 mt-0.5" />
          <p className="text-xs text-fg-secondary leading-relaxed">{t('gateway.disabledNotice')}</p>
        </div>
      )}
      {failed && <p className="text-xs text-danger">{t('gateway.loadFailed')}</p>}
      <Card className="p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Cpu size={16} className="text-primary-fg mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg">{t('gateway.title')}</h3>
            <p className="text-xs text-fg-muted mt-1 leading-relaxed">{t('gateway.intro')}</p>
          </div>
        </div>
        {overview && (
          <div>
            <div className="text-xs font-medium text-fg-secondary mb-1">{t('gateway.baseUrl')}</div>
            <CopyField value={overview.base_url} testId="gateway-base-url" />
          </div>
        )}
        {overview?.models.some((model) => model.anthropic) && (
          <div>
            <div className="text-xs font-medium text-fg-secondary mb-1">{t('gateway.anthropicBaseUrl')}</div>
            <CopyField value={overview.anthropic_base_url} testId="gateway-anthropic-base-url" />
          </div>
        )}
        <Button size="sm" variant="secondary" onClick={onOpenGuide}>
          {t('gateway.openGuide')}
        </Button>
      </Card>
      <CrudPage key={`${version}:${enabled}`} schema={schema} />
      <SecretDialog
        secret={secret}
        onClose={() => {
          setSecret(null);
          setVersion((v) => v + 1);
        }}
      />
    </div>
  );
}
