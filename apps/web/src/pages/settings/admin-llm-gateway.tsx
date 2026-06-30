/**
 * LlmGatewayAdminPanel — 团队 AI 网关管理（仅 super）。
 *
 * 三块：
 * - Upstreams 上游池：真实厂商 endpoint + 加密 key
 * - Models 模型目录：对外 public 模型 → 上游映射（default / public 子集 / 启停）
 * - Keys 网关 key 治理：吊销 / 改每日额度 / 查看今日用量
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Cloud, Plus, Pencil, Trash2, Check } from '../../lib/icons';
import { Button, Input, Select, Badge, Dialog, ConfirmDialog } from '../../components/ui';
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-fg-secondary mb-1">{label}</label>
      {children}
    </div>
  );
}

// ════════════════ Upstreams ════════════════

interface UpstreamDraft {
  id?: string;
  name: string;
  provider_kind: GatewayUpstreamKind;
  base_url: string;
  api_key: string;
  enabled: boolean;
}

function emptyUpstream(): UpstreamDraft {
  return { name: '', provider_kind: 'openai', base_url: 'https://api.openai.com/v1', api_key: '', enabled: true };
}

function UpstreamsCard({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<GatewayUpstream[]>([]);
  const [editing, setEditing] = useState<UpstreamDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GatewayUpstream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await adminListUpstreams());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const onSave = useCallback(async () => {
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) {
        await adminUpdateUpstream(editing.id, {
          name: editing.name,
          provider_kind: editing.provider_kind,
          base_url: editing.base_url,
          enabled: editing.enabled,
          ...(editing.api_key ? { api_key: editing.api_key } : {}),
        });
      } else {
        await adminCreateUpstream(editing);
      }
      setEditing(null);
      await reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [editing, reload, onChanged]);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-fg">{t('llmGateway.upstreams')}</h3>
        <Button size="sm" onClick={() => setEditing(emptyUpstream())}>
          <Plus size={12} /> {t('llmGateway.addUpstream')}
        </Button>
      </div>
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
        <table className="min-w-[720px] w-full text-xs">
          <thead className="bg-surface-sunken text-fg-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colName')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colKind')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colBaseUrl')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colKey')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colStatus')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('llmGateway.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {rows.map((u) => (
              <tr key={u.id} className="hover:bg-surface-sunken">
                <td className="px-3 py-2 font-medium text-fg">{u.name}</td>
                <td className="px-3 py-2 text-fg-secondary">{u.provider_kind}</td>
                <td className="px-3 py-2 font-mono text-fg-faint truncate max-w-[220px]" title={u.base_url}>
                  {u.base_url}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={u.has_key ? 'success' : 'warning'}>
                    {u.has_key ? t('llmGateway.keySet') : t('llmGateway.keyNone')}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge variant={u.enabled ? 'success' : 'secondary'}>
                    {u.enabled ? t('llmGateway.enabled') : t('llmGateway.off')}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditing({
                        id: u.id,
                        name: u.name,
                        provider_kind: u.provider_kind,
                        base_url: u.base_url,
                        api_key: '',
                        enabled: u.enabled,
                      })
                    }
                  >
                    <Pencil size={12} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(u)}>
                    <Trash2 size={12} />
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-fg-faint">
                  {t('llmGateway.noUpstreams')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? t('llmGateway.editUpstream') : t('llmGateway.addUpstream')}
        size="lg"
      >
        {editing && (
          <div className="space-y-3 px-1 pb-1">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('llmGateway.fieldName')}>
                <Input
                  size="sm"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </Field>
              <Field label={t('llmGateway.providerKind')}>
                <Select
                  size="sm"
                  value={editing.provider_kind}
                  onChange={(e) => setEditing({ ...editing, provider_kind: e.target.value as GatewayUpstreamKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t('llmGateway.baseUrlLabel')}>
              <Input
                size="sm"
                value={editing.base_url}
                onChange={(e) => setEditing({ ...editing, base_url: e.target.value })}
              />
            </Field>
            <Field label={t('llmGateway.apiKeyLabel', { note: editing.id ? t('llmGateway.apiKeyKeepNote') : '' })}>
              <Input
                size="sm"
                type="password"
                value={editing.api_key}
                onChange={(e) => setEditing({ ...editing, api_key: e.target.value })}
                placeholder={editing.id ? '••••••••' : 'sk-...'}
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-fg-secondary">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              />
              {t('llmGateway.enabledLabel')}
            </label>
            {editing.provider_kind === 'anthropic' && (
              <p className="text-[11px] text-fg-faint">{t('llmGateway.anthropicNote')}</p>
            )}
            <div className="flex justify-end gap-2 pt-2 border-t border-edge">
              <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={() => void onSave()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await adminDeleteUpstream(deleteTarget.id);
            setDeleteTarget(null);
            await reload();
            onChanged();
          }
        }}
        title={t('llmGateway.deleteUpstreamTitle')}
        description={deleteTarget ? t('llmGateway.deleteUpstreamDesc', { name: deleteTarget.name }) : undefined}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}

// ════════════════ Models ════════════════

interface ModelDraft {
  id?: string;
  public_id: string;
  display_name: string;
  upstream_id: string;
  upstream_model: string;
  enabled: boolean;
  is_default: boolean;
  is_public: boolean;
  sort_order: number;
}

function emptyModel(upstreamId: string): ModelDraft {
  return {
    public_id: '',
    display_name: '',
    upstream_id: upstreamId,
    upstream_model: '',
    enabled: true,
    is_default: false,
    is_public: true,
    sort_order: 0,
  };
}

function ModelsCard({ upstreams, reloadKey }: { upstreams: GatewayUpstream[]; reloadKey: number }) {
  const t = useT();
  const [rows, setRows] = useState<GatewayModel[]>([]);
  const [editing, setEditing] = useState<ModelDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GatewayModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await adminListModels());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const upstreamName = (id: string) => upstreams.find((u) => u.id === id)?.name ?? id;

  const onSave = useCallback(async () => {
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) {
        const { public_id: _omit, ...patch } = editing;
        await adminUpdateModel(editing.id, patch);
      } else {
        await adminCreateModel(editing);
      }
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [editing, reload]);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-fg">{t('llmGateway.models')}</h3>
        <Button
          size="sm"
          disabled={upstreams.length === 0}
          onClick={() => setEditing(emptyModel(upstreams[0]?.id ?? ''))}
        >
          <Plus size={12} /> {t('llmGateway.addModel')}
        </Button>
      </div>
      {upstreams.length === 0 && <p className="text-xs text-fg-faint mb-2">{t('llmGateway.addUpstreamFirst')}</p>}
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
        <table className="min-w-[820px] w-full text-xs">
          <thead className="bg-surface-sunken text-fg-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colPublicId')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colDisplay')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colUpstream')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colUpstreamModel')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colFlags')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('llmGateway.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {rows.map((m) => (
              <tr key={m.id} className="hover:bg-surface-sunken">
                <td className="px-3 py-2 font-mono text-fg">{m.public_id}</td>
                <td className="px-3 py-2 text-fg-secondary">{m.display_name}</td>
                <td className="px-3 py-2 text-fg-faint">{upstreamName(m.upstream_id)}</td>
                <td className="px-3 py-2 font-mono text-fg-faint">{m.upstream_model}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={m.enabled ? 'success' : 'secondary'}>
                      {m.enabled ? t('llmGateway.flagOn') : t('llmGateway.flagOff')}
                    </Badge>
                    {m.is_default && <Badge variant="default">{t('llmGateway.flagDefault')}</Badge>}
                    {m.is_public && <Badge variant="default">{t('llmGateway.flagPublic')}</Badge>}
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ ...m })}>
                    <Pencil size={12} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(m)}>
                    <Trash2 size={12} />
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-fg-faint">
                  {t('llmGateway.noModels')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? t('llmGateway.editModel') : t('llmGateway.addModel')}
        size="lg"
      >
        {editing && (
          <div className="space-y-3 px-1 pb-1">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('llmGateway.publicIdLabel')}>
                <Input
                  size="sm"
                  value={editing.public_id}
                  disabled={!!editing.id}
                  onChange={(e) => setEditing({ ...editing, public_id: e.target.value })}
                  placeholder="claude-sonnet"
                />
              </Field>
              <Field label={t('llmGateway.displayName')}>
                <Input
                  size="sm"
                  value={editing.display_name}
                  onChange={(e) => setEditing({ ...editing, display_name: e.target.value })}
                  placeholder="Claude Sonnet"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('llmGateway.upstreamLabel')}>
                <Select
                  size="sm"
                  value={editing.upstream_id}
                  onChange={(e) => setEditing({ ...editing, upstream_id: e.target.value })}
                >
                  {upstreams.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('llmGateway.upstreamModelId')}>
                <Input
                  size="sm"
                  value={editing.upstream_model}
                  onChange={(e) => setEditing({ ...editing, upstream_model: e.target.value })}
                  placeholder="claude-sonnet-4-5"
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs text-fg-secondary">
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                />
                {t('llmGateway.enabledLabel')}
              </label>
              <label className="flex items-center gap-2 text-xs text-fg-secondary">
                <input
                  type="checkbox"
                  checked={editing.is_default}
                  onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
                />
                {t('llmGateway.defaultSeamless')}
              </label>
              <label className="flex items-center gap-2 text-xs text-fg-secondary">
                <input
                  type="checkbox"
                  checked={editing.is_public}
                  onChange={(e) => setEditing({ ...editing, is_public: e.target.checked })}
                />
                {t('llmGateway.publicSubset')}
              </label>
              <Field label={t('llmGateway.sort')}>
                <Input
                  size="sm"
                  type="number"
                  value={String(editing.sort_order)}
                  onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) || 0 })}
                  className="w-20"
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-edge">
              <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={() => void onSave()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await adminDeleteModel(deleteTarget.id);
            setDeleteTarget(null);
            await reload();
          }
        }}
        title={t('llmGateway.deleteModelTitle')}
        description={deleteTarget ? t('llmGateway.deleteModelDesc', { name: deleteTarget.public_id }) : undefined}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}

// ════════════════ Keys ════════════════

function KeysCard() {
  const t = useT();
  const [rows, setRows] = useState<AdminGatewayKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await adminListGatewayKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleStatus = useCallback(
    async (k: AdminGatewayKey) => {
      await adminUpdateGatewayKey(k.id, { status: k.status === 'active' ? 'disabled' : 'active' });
      await reload();
    },
    [reload],
  );

  const setLimit = useCallback(
    async (k: AdminGatewayKey, value: number) => {
      await adminUpdateGatewayKey(k.id, { daily_token_limit: value });
      setSavedId(k.id);
      setTimeout(() => setSavedId(null), 1500);
      await reload();
    },
    [reload],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-fg">{t('llmGateway.gatewayKeys')}</h3>
        <Button size="sm" variant="ghost" onClick={() => void reload()}>
          {t('common.refresh')}
        </Button>
      </div>
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
        <table className="min-w-[860px] w-full text-xs">
          <thead className="bg-surface-sunken text-fg-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colName')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colUser')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colStatus')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colTodayTokens')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colDailyLimit')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('llmGateway.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {rows.map((k) => (
              <tr key={k.id} className="hover:bg-surface-sunken">
                <td className="px-3 py-2 text-fg">
                  {k.name} {k.auto && <Badge variant="default">auto</Badge>}
                </td>
                <td className="px-3 py-2 font-mono text-fg-faint truncate max-w-[120px]" title={k.user_id ?? ''}>
                  {k.user_id ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={k.status === 'active' ? 'success' : 'destructive'}>{k.status}</Badge>
                </td>
                <td className="px-3 py-2 text-fg-secondary">{k.today_tokens.toLocaleString()}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Input
                      size="sm"
                      type="number"
                      defaultValue={String(k.daily_token_limit)}
                      className="w-28"
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v && v !== k.daily_token_limit) void setLimit(k, v);
                      }}
                    />
                    {savedId === k.id && <Check size={12} className="text-success" />}
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => void toggleStatus(k)}>
                    {k.status === 'active' ? t('llmGateway.revoke') : t('llmGateway.enable')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await adminDeleteGatewayKey(k.id);
                      await reload();
                    }}
                  >
                    <Trash2 size={12} />
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-fg-faint">
                  {t('llmGateway.noKeys')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════ Panel ════════════════

export function LlmGatewayAdminPanel() {
  const t = useT();
  const [upstreams, setUpstreams] = useState<GatewayUpstream[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const refreshUpstreams = useCallback(async () => {
    try {
      setUpstreams(await adminListUpstreams());
    } catch {
      /* surfaced inside cards */
    }
  }, []);
  useEffect(() => {
    void refreshUpstreams();
  }, [refreshUpstreams]);

  const onUpstreamsChanged = useCallback(() => {
    void refreshUpstreams();
    setReloadKey((k) => k + 1);
  }, [refreshUpstreams]);

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-2 mb-1">
        <Cloud size={18} className="text-primary-fg" />
        <h2 className="text-base font-semibold text-fg">{t('llmGateway.title')}</h2>
      </div>
      <p className="text-xs text-fg-muted mb-5">{t('llmGateway.description')}</p>
      <UpstreamsCard onChanged={onUpstreamsChanged} />
      <ModelsCard upstreams={upstreams} reloadKey={reloadKey} />
      <KeysCard />
    </div>
  );
}
