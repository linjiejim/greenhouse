/**
 * LlmGatewayAdminPanel — 团队 AI 网关（仅 super）。
 *
 * 两块：
 * - Catalog 模型目录：**只读**。模型与 provider 链声明在 apps/api/config/models.yaml，
 *   密钥在 env；这里只回报配了什么、通不通，不回显任何密钥。
 * - Keys 网关 key 治理：吊销 / 改每日额度 / 查看今日用量（授权，不是配置）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Trash2 } from '../../lib/icons';
import { Badge, Button, Input, Tabs } from '../../components/ui';
import { ModulePage } from '../../components/app/module-page';
import { useT } from '../../lib/i18n';
import {
  adminGetCatalog,
  adminListGatewayKeys,
  adminUpdateGatewayKey,
  adminDeleteGatewayKey,
  type CatalogModel,
  type CatalogProvider,
  type AdminGatewayKey,
} from '../../lib/llm-gateway';

// ════════════════ Model catalog (read-only) ════════════════

function ProviderCell({ p, index }: { p: CatalogProvider; index: number }) {
  const t = useT();
  const usable = p.api_key_configured && p.relay_capable;
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-xs">
      <Badge variant={index === 0 ? 'default' : 'secondary'} className="flex-shrink-0">
        {index === 0 ? t('llmGateway.primary') : t('llmGateway.fallback')}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex-shrink-0 font-mono text-fg">{p.provider}</span>
          <span className="truncate font-mono text-fg-muted" title={p.model}>
            {p.model}
          </span>
        </div>
        {p.base_url && (
          <div className="truncate font-mono text-[10px] text-fg-faint" title={p.base_url}>
            {p.base_url}
          </div>
        )}
      </div>
      <span className="flex flex-shrink-0 items-center gap-2">
        <code className="rounded bg-surface-muted px-1 py-px text-[10px] text-fg-secondary">{p.api_key_env}</code>
        <Badge variant={usable ? 'success' : 'secondary'}>
          {p.api_key_configured ? t('llmGateway.keySet') : t('llmGateway.keyMissing')}
        </Badge>
      </span>
    </div>
  );
}

function CatalogCard() {
  const t = useT();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await adminGetCatalog();
        setModels(data.models);
        setSource(data.source);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load catalog');
      }
    })();
  }, []);

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">{t('llmGateway.catalogTitle')}</h3>
        {source && <code className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-fg-muted">{source}</code>}
      </div>
      <p className="mb-3 text-xs text-fg-muted">{t('llmGateway.catalogHint')}</p>

      {error && <div className="text-xs text-danger">{error}</div>}
      <div className="overflow-x-auto rounded-lg border border-edge bg-surface-raised">
        <table className="w-full min-w-[860px] text-xs">
          <thead className="bg-surface-sunken text-fg-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colModel')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colFlags')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('llmGateway.colProviders')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('llmGateway.colStatus')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {models.map((m) => (
              <tr key={m.id} className="align-top transition-colors hover:bg-surface-sunken">
                <td className="px-3 py-2.5">
                  <div className="font-mono text-sm font-medium text-fg">{m.id}</div>
                  <div className="mt-0.5 text-xs text-fg-muted">{m.name}</div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {m.is_default && <Badge variant="default">{t('llmGateway.defaultModel')}</Badge>}
                    {m.is_public && <Badge variant="secondary">{t('llmGateway.publicModel')}</Badge>}
                    {!m.is_default && !m.is_public && <span className="text-fg-faint">—</span>}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <div className="divide-y divide-edge">
                    {m.providers.map((p, i) => (
                      <ProviderCell key={`${p.provider}-${p.model}-${i}`} p={p} index={i} />
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Badge variant={m.ready ? 'success' : 'destructive'}>
                    {m.ready ? t('llmGateway.ready') : t('llmGateway.notReady')}
                  </Badge>
                </td>
              </tr>
            ))}
            {models.length === 0 && !error && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-fg-faint">
                  {t('llmGateway.noModels')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
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
                  {k.name} {k.auto && <Badge variant="default">{t('llmGateway.auto')}</Badge>}
                </td>
                <td className="px-3 py-2 font-mono text-fg-faint truncate max-w-[120px]" title={k.user_id}>
                  {k.user_id}
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
  const [activeTab, setActiveTab] = useState('models');
  return (
    <ModulePage
      moduleId="admin.llm-gateway"
      layout="list"
      tabs={
        <Tabs
          tabs={[
            { key: 'models', label: t('llmGateway.modelTab') },
            { key: 'keys', label: t('llmGateway.gatewayKeys') },
          ]}
          active={activeTab}
          onChange={setActiveTab}
          ariaLabel={t('llmGateway.tabsLabel')}
        />
      }
    >
      <div role="tabpanel" aria-label={activeTab === 'models' ? t('llmGateway.modelTab') : t('llmGateway.gatewayKeys')}>
        {activeTab === 'models' ? <CatalogCard /> : <KeysCard />}
      </div>
    </ModulePage>
  );
}
