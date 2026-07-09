/**
 * LlmGatewayAdminPanel — 团队 AI 网关管理（仅 super），on @greenhouse/crud.
 *
 * 三块，各由一个 defineCrud 驱动，放在 CrudTabs 下：
 * - Upstreams 上游池：真实厂商 endpoint + 加密 key
 * - Models 模型目录：对外 public 模型 → 上游映射（default / public 子集 / 启停）
 * - Keys 网关 key 治理：吊销 / 改每日额度 / 查看今日用量
 *
 * 跨块联动：Models 的 upstream 下拉选项与「Upstream」列名解析都依赖 upstreams 列表。
 * 面板持有 upstreams 状态，Upstreams 的增删改后刷新它 → 重建 modelsSchema。CrudTabs
 * 会卸载非当前 tab，切回 Models 时 CrudPage 重新挂载并以最新 upstreams 拉取，故无需额外 key。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { defineCrud, CrudTabs, type CrudDataSource } from '@greenhouse/crud';
import { Cloud, Layers, Key } from '../../lib/icons';
import { Badge } from '../../components/ui';
import { useT } from '../../lib/i18n';
import {
  adminListUpstreams,
  adminCreateUpstream,
  adminUpdateUpstream,
  adminDeleteUpstream,
  adminListModels,
  adminCreateModel,
  adminUpdateModel,
  adminDeleteModel,
  adminListGatewayKeys,
  adminUpdateGatewayKey,
  adminDeleteGatewayKey,
  type GatewayUpstream,
  type GatewayUpstreamKind,
  type GatewayModel,
  type AdminGatewayKey,
} from '../../lib/llm-gateway';

const KINDS: GatewayUpstreamKind[] = ['openai', 'deepseek', 'openai-compatible', 'anthropic'];

// The Upstreams form needs `api_key` (a write-only credential not present on the
// row, which only exposes `has_key`), so widen the row type for that field key.
type UpstreamRow = GatewayUpstream & { api_key?: string };
type KeyRow = AdminGatewayKey;

export function LlmGatewayAdminPanel() {
  const t = useT();
  const [upstreams, setUpstreams] = useState<GatewayUpstream[]>([]);

  const refreshUpstreams = useCallback(async () => {
    try {
      setUpstreams(await adminListUpstreams());
    } catch {
      /* surfaced by the tab's own list load */
    }
  }, []);
  useEffect(() => {
    void refreshUpstreams();
  }, [refreshUpstreams]);

  // ── Upstreams schema ───────────────────────────────────
  const upstreamsSchema = useMemo(() => {
    const dataSource: CrudDataSource<UpstreamRow> = {
      async list() {
        const items = await adminListUpstreams();
        return { items, total: items.length };
      },
      async create(data) {
        const created = await adminCreateUpstream({
          name: String(data.name ?? ''),
          provider_kind: data.provider_kind as GatewayUpstreamKind,
          base_url: String(data.base_url ?? ''),
          api_key: String(data.api_key ?? ''),
          enabled: Boolean(data.enabled),
        });
        await refreshUpstreams();
        return created;
      },
      async update(id, data) {
        // Blank api_key on edit means "keep the existing key" — only send when set.
        const apiKey = String(data.api_key ?? '').trim();
        await adminUpdateUpstream(id, {
          name: String(data.name ?? ''),
          provider_kind: data.provider_kind as GatewayUpstreamKind,
          base_url: String(data.base_url ?? ''),
          enabled: Boolean(data.enabled),
          ...(apiKey ? { api_key: apiKey } : {}),
        });
        await refreshUpstreams();
      },
      async remove(id) {
        await adminDeleteUpstream(id);
        await refreshUpstreams();
      },
    };

    return defineCrud<UpstreamRow>({
      name: t('llmGateway.upstreams'),
      icon: Cloud,
      idField: 'id',
      dataSource,
      emptyMessage: t('llmGateway.noUpstreams'),
      formMode: 'dialog',
      formTitle: (mode) => (mode === 'add' ? t('llmGateway.addUpstream') : t('llmGateway.editUpstream')),
      columns: [
        { key: 'name', label: t('llmGateway.colName') },
        { key: 'provider_kind', label: t('llmGateway.colKind') },
        {
          key: 'base_url',
          label: t('llmGateway.colBaseUrl'),
          type: 'custom',
          render: (row) => (
            <span
              className="font-mono text-fg-faint truncate inline-block max-w-[220px] align-bottom"
              title={row.base_url}
            >
              {row.base_url}
            </span>
          ),
        },
        {
          key: 'has_key',
          label: t('llmGateway.colKey'),
          type: 'custom',
          render: (row) => (
            <Badge variant={row.has_key ? 'success' : 'warning'}>
              {row.has_key ? t('llmGateway.keySet') : t('llmGateway.keyNone')}
            </Badge>
          ),
        },
        {
          key: 'enabled',
          label: t('llmGateway.colStatus'),
          type: 'toggle',
          align: 'center',
          width: '80px',
          onToggle: async (row, next) => {
            await adminUpdateUpstream(row.id, { enabled: next });
            await refreshUpstreams();
          },
        },
      ],
      formFields: [
        { key: 'name', label: t('llmGateway.fieldName'), type: 'text', width: 2, required: true },
        {
          key: 'provider_kind',
          label: t('llmGateway.providerKind'),
          type: 'select',
          width: 2,
          required: true,
          defaultValue: 'openai',
          options: KINDS.map((k) => ({ value: k, label: k })),
        },
        {
          key: 'base_url',
          label: t('llmGateway.baseUrlLabel'),
          type: 'text',
          width: 4,
          required: true,
          defaultValue: 'https://api.openai.com/v1',
        },
        {
          key: 'api_key',
          label: t('llmGateway.apiKeyLabel', { note: '' }),
          type: 'password',
          width: 4,
          placeholder: 'sk-...',
          comment: t('llmGateway.apiKeyKeepNote'),
        },
        { key: 'enabled', label: t('llmGateway.enabledLabel'), type: 'switch', width: 4, defaultValue: true },
        {
          // Anthropic-only hint, reimplemented as a visible-gated note. Keyed on an
          // unused row field; the dataSource builds explicit payloads so it's ignored.
          key: 'created_by',
          label: '',
          type: 'custom',
          visible: (form) => form.provider_kind === 'anthropic',
          render: () => <p className="text-[11px] text-fg-faint">{t('llmGateway.anthropicNote')}</p>,
        },
      ],
      access: { canAdd: true, canEdit: true, canDelete: true },
    });
  }, [t, refreshUpstreams]);

  // ── Models schema (rebuilt when upstreams change) ──────
  const modelsSchema = useMemo(() => {
    const upstreamName = (id: string) => upstreams.find((u) => u.id === id)?.name ?? id;

    const dataSource: CrudDataSource<GatewayModel> = {
      async list() {
        const items = await adminListModels();
        return { items, total: items.length };
      },
      create: (data) =>
        adminCreateModel({
          public_id: String(data.public_id ?? ''),
          display_name: String(data.display_name ?? ''),
          upstream_id: String(data.upstream_id ?? ''),
          upstream_model: String(data.upstream_model ?? ''),
          enabled: Boolean(data.enabled),
          is_default: Boolean(data.is_default),
          is_public: Boolean(data.is_public),
          sort_order: Number(data.sort_order) || 0,
        }),
      // public_id is immutable — the edit form omits it (allows.edit:false), and
      // adminUpdateModel's type forbids it, so we only send the mutable patch.
      update: (id, data) =>
        adminUpdateModel(id, {
          display_name: String(data.display_name ?? ''),
          upstream_id: String(data.upstream_id ?? ''),
          upstream_model: String(data.upstream_model ?? ''),
          enabled: Boolean(data.enabled),
          is_default: Boolean(data.is_default),
          is_public: Boolean(data.is_public),
          sort_order: Number(data.sort_order) || 0,
        }),
      remove: (id) => adminDeleteModel(id),
    };

    return defineCrud<GatewayModel>({
      name: t('llmGateway.models'),
      icon: Layers,
      idField: 'id',
      dataSource,
      emptyMessage: t('llmGateway.noModels'),
      formMode: 'dialog',
      formTitle: (mode) => (mode === 'add' ? t('llmGateway.addModel') : t('llmGateway.editModel')),
      columns: [
        {
          key: 'public_id',
          label: t('llmGateway.colPublicId'),
          type: 'custom',
          render: (row) => <span className="font-mono text-fg">{row.public_id}</span>,
        },
        { key: 'display_name', label: t('llmGateway.colDisplay') },
        {
          key: 'upstream_id',
          label: t('llmGateway.colUpstream'),
          type: 'custom',
          render: (row) => <span className="text-fg-faint">{upstreamName(row.upstream_id)}</span>,
        },
        {
          key: 'upstream_model',
          label: t('llmGateway.colUpstreamModel'),
          type: 'custom',
          render: (row) => <span className="font-mono text-fg-faint">{row.upstream_model}</span>,
        },
        {
          key: 'flags',
          label: t('llmGateway.colFlags'),
          type: 'custom',
          render: (row) => (
            <div className="flex flex-wrap gap-1">
              <Badge variant={row.enabled ? 'success' : 'secondary'}>
                {row.enabled ? t('llmGateway.flagOn') : t('llmGateway.flagOff')}
              </Badge>
              {row.is_default && <Badge variant="default">{t('llmGateway.flagDefault')}</Badge>}
              {row.is_public && <Badge variant="default">{t('llmGateway.flagPublic')}</Badge>}
            </div>
          ),
        },
      ],
      formFields: [
        {
          key: 'public_id',
          label: t('llmGateway.publicIdLabel'),
          type: 'text',
          width: 2,
          required: true,
          allows: { edit: false },
          placeholder: 'claude-sonnet',
        },
        {
          key: 'display_name',
          label: t('llmGateway.displayName'),
          type: 'text',
          width: 2,
          required: true,
          placeholder: 'Claude Sonnet',
        },
        {
          key: 'upstream_id',
          label: t('llmGateway.upstreamLabel'),
          type: 'select',
          width: 2,
          required: true,
          defaultValue: upstreams[0]?.id,
          options: upstreams.map((u) => ({ value: u.id, label: u.name })),
        },
        {
          key: 'upstream_model',
          label: t('llmGateway.upstreamModelId'),
          type: 'text',
          width: 2,
          required: true,
          placeholder: 'claude-sonnet-4-5',
        },
        { key: 'enabled', label: t('llmGateway.enabledLabel'), type: 'switch', width: 1, defaultValue: true },
        { key: 'is_default', label: t('llmGateway.defaultSeamless'), type: 'switch', width: 1, defaultValue: false },
        { key: 'is_public', label: t('llmGateway.publicSubset'), type: 'switch', width: 1, defaultValue: true },
        { key: 'sort_order', label: t('llmGateway.sort'), type: 'number', width: 1, defaultValue: 0 },
      ],
      access: { canAdd: upstreams.length > 0, canEdit: true, canDelete: true },
      slots:
        upstreams.length === 0
          ? { banner: () => <p className="text-xs text-fg-faint">{t('llmGateway.addUpstreamFirst')}</p> }
          : undefined,
    });
  }, [t, upstreams]);

  // ── Keys schema ────────────────────────────────────────
  const keysSchema = useMemo(() => {
    const dataSource: CrudDataSource<KeyRow> = {
      async list() {
        const keys = await adminListGatewayKeys();
        return { items: keys, total: keys.length };
      },
      update: (id, data) =>
        adminUpdateGatewayKey(id, {
          daily_token_limit: Number(data.daily_token_limit) || 0,
          status: data.status as 'active' | 'disabled',
        }),
      remove: (id) => adminDeleteGatewayKey(id),
    };

    return defineCrud<KeyRow>({
      name: t('llmGateway.gatewayKeys'),
      icon: Key,
      idField: 'id',
      dataSource,
      emptyMessage: t('llmGateway.noKeys'),
      formMode: 'dialog',
      columns: [
        {
          key: 'name',
          label: t('llmGateway.colName'),
          type: 'custom',
          render: (row) => (
            <span className="text-fg">
              {row.name} {row.auto && <Badge variant="default">auto</Badge>}
            </span>
          ),
        },
        {
          key: 'user_id',
          label: t('llmGateway.colUser'),
          type: 'custom',
          render: (row) => (
            <span
              className="font-mono text-fg-faint truncate inline-block max-w-[120px] align-bottom"
              title={row.user_id ?? ''}
            >
              {row.user_id ?? '—'}
            </span>
          ),
        },
        {
          key: 'status',
          label: t('llmGateway.colStatus'),
          type: 'toggle',
          align: 'center',
          width: '80px',
          checked: (row) => row.status === 'active',
          onToggle: async (row, next) => {
            await adminUpdateGatewayKey(row.id, { status: next ? 'active' : 'disabled' });
          },
        },
        { key: 'today_tokens', label: t('llmGateway.colTodayTokens'), type: 'number', align: 'right' },
        { key: 'daily_token_limit', label: t('llmGateway.colDailyLimit'), type: 'number', align: 'right' },
      ],
      formFields: [
        { key: 'daily_token_limit', label: t('llmGateway.colDailyLimit'), type: 'number', width: 4, min: 1 },
        {
          key: 'status',
          label: t('llmGateway.colStatus'),
          type: 'select',
          width: 4,
          options: [
            { value: 'active', label: t('llmGateway.enable') },
            { value: 'disabled', label: t('llmGateway.revoke') },
          ],
        },
      ],
      access: { canAdd: false, canEdit: true, canDelete: true },
    });
  }, [t]);

  const tabs = useMemo(
    () => [
      { key: 'upstreams', label: t('llmGateway.upstreams'), icon: Cloud, schema: upstreamsSchema },
      { key: 'models', label: t('llmGateway.models'), icon: Layers, schema: modelsSchema },
      { key: 'keys', label: t('llmGateway.gatewayKeys'), icon: Key, schema: keysSchema },
    ],
    [t, upstreamsSchema, modelsSchema, keysSchema],
  );

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-2 mb-1">
        <Cloud size={18} className="text-primary-fg" />
        <h2 className="text-base font-semibold text-fg">{t('llmGateway.title')}</h2>
      </div>
      <p className="text-xs text-fg-muted mb-5">{t('llmGateway.description')}</p>
      <CrudTabs tabs={tabs} />
    </div>
  );
}
