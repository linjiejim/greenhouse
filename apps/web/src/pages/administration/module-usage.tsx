/**
 * Administration › Usage › Modules — which modules and clients are actually used.
 *
 * Reads `GET /api/admin/usage/modules`: tool calls by tool × client, page opens
 * by module × client (both from `module_usage_daily`, counted since v1.4) and the
 * prompt-cache hit rate per model from the model usage events.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { ModuleUsageReport, UsageRangeDays } from '@greenhouse/types/usage';
import { Card, EmptyState, SkeletonCard, Tag } from '../../components/ui';
import { KpiCard } from '../../components/usage/usage-widgets';
import { BarChart3 } from '../../lib/icons';
import { formatTokens } from '../../lib/api';
import { fetchModuleUsage } from '../../lib/api/usage';
import { useT, type TranslationKey } from '../../lib/i18n';
import { getNavModule, localizeNavModule } from '../../lib/nav-registry';
import { useExtensionsStore } from '../../stores/extensions-store';
import {
  formatRate,
  overallCacheHitRate,
  sumCounts,
  totalsByClient,
  totalsByKey,
  type KeyTotal,
} from '../../lib/usage/report';

type Translate = ReturnType<typeof useT>;

const CLIENT_LABELS: Record<string, TranslationKey> = {
  mcp: 'usage.modules.clientNames.mcp',
  agent_api: 'usage.modules.clientNames.agent_api',
  web_chat: 'usage.modules.clientNames.web_chat',
  browser: 'usage.modules.clientNames.browser',
  mobile: 'usage.modules.clientNames.mobile',
  feishu: 'usage.modules.clientNames.feishu',
  automation: 'usage.modules.clientNames.automation',
  subagent: 'usage.modules.clientNames.subagent',
  web: 'usage.modules.clientNames.web',
  desktop: 'usage.modules.clientNames.desktop',
};

const MODULE_LABELS: Record<string, TranslationKey> = {
  home: 'usage.modules.moduleNames.home',
  chat: 'usage.modules.moduleNames.chat',
  knowledge: 'usage.modules.moduleNames.knowledge',
  projects: 'usage.modules.moduleNames.projects',
  tables: 'usage.modules.moduleNames.tables',
  automations: 'usage.modules.moduleNames.automations',
  tasks: 'usage.modules.moduleNames.tasks',
  agents: 'usage.modules.moduleNames.agents',
  skillhub: 'usage.modules.moduleNames.skillhub',
  activity: 'usage.modules.moduleNames.activity',
  // Retired in 1.5 (became the Activity log); recorded counts still read back.
  executions: 'usage.modules.moduleNames.executions',
  files: 'usage.modules.moduleNames.files',
  'session-tags': 'usage.modules.moduleNames.sessionTags',
  'session-groups': 'usage.modules.moduleNames.sessionGroups',
};

function clientLabel(client: string, t: Translate): string {
  const key = CLIENT_LABELS[client];
  return key ? t(key) : client;
}

function moduleLabel(key: string, t: Translate, extensionNames: ReadonlyMap<string, string>): string {
  if (key.startsWith('ext.')) {
    const id = key.slice('ext.'.length);
    return extensionNames.get(id) ?? id;
  }
  const labelKey = MODULE_LABELS[key];
  if (labelKey) return t(labelKey);
  const nav = getNavModule(key);
  if (nav && (nav.parent === 'settings' || nav.parent === 'administration')) {
    const section = t(nav.parent === 'settings' ? 'app.settings' : 'app.administration');
    return `${section} › ${localizeNavModule(nav, t).label}`;
  }
  return key;
}

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-semibold text-fg-muted mb-3">{title}</div>
      {children}
    </Card>
  );
}

/** Rows of key → per-client tags → total, with a closing total row. */
function KeyTotalsTable({
  rows,
  keyHeader,
  renderKey,
  emptyLabel,
}: {
  rows: KeyTotal[];
  keyHeader: string;
  renderKey: (key: string) => ReactNode;
  emptyLabel: string;
}) {
  const t = useT();
  if (rows.length === 0) return <div className="text-sm text-fg-faint">{emptyLabel}</div>;
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-[11px]">
        <thead>
          <tr className="text-fg-faint">
            <th className="text-left font-medium pb-2">{keyHeader}</th>
            <th className="text-left font-medium pb-2">{t('usage.modules.client')}</th>
            <th className="text-right font-medium pb-2">{t('usage.modules.total')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="text-fg-secondary border-b border-edge">
              <td className="py-1.5 pr-3">{renderKey(row.key)}</td>
              <td className="py-1.5 pr-3">
                <div className="flex flex-wrap gap-1">
                  {row.clients.map((c) => (
                    <Tag key={c.client} tone="neutral">
                      {clientLabel(c.client, t)} {c.count.toLocaleString()}
                    </Tag>
                  ))}
                </div>
              </td>
              <td className="py-1.5 text-right font-mono">{row.total.toLocaleString()}</td>
            </tr>
          ))}
          <tr className="text-fg font-medium">
            <td className="pt-2" colSpan={2}>
              {t('usage.modules.totalRow')}
            </td>
            <td className="pt-2 text-right font-mono">{total.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function ModuleUsageTab({ days }: { days: UsageRangeDays }) {
  const t = useT();
  const extensions = useExtensionsStore((s) => s.extensions);
  const [report, setReport] = useState<ModuleUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetchModuleUsage(days)
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const note = <p className="text-xs text-fg-faint">{t('usage.modules.sinceNote')}</p>;

  if (loading) {
    return (
      <div className="space-y-4">
        {note}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (failed || !report) {
    return (
      <div className="space-y-4">
        {note}
        <EmptyState icon={BarChart3} tone="danger" title={t('usage.modules.loadFailed')} />
      </div>
    );
  }

  if (report.tool_calls.length === 0 && report.page_opens.length === 0 && report.cache_by_model.length === 0) {
    return (
      <div className="space-y-4">
        {note}
        <EmptyState
          icon={BarChart3}
          tone="neutral"
          title={t('usage.modules.empty')}
          description={t('usage.modules.emptyHint')}
        />
      </div>
    );
  }

  const extensionNames = new Map(extensions.map((ext) => [ext.id, ext.name]));
  const tools = totalsByKey(report.tool_calls);
  const modules = totalsByKey(report.page_opens);
  const clients = totalsByClient(report.tool_calls, report.page_opens);
  const hitRate = overallCacheHitRate(report.cache_by_model);

  return (
    <div className="space-y-4">
      {note}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
        <KpiCard title={t('usage.modules.toolCalls')}>
          <div className="text-2xl font-bold text-fg">{sumCounts(report.tool_calls).toLocaleString()}</div>
        </KpiCard>
        <KpiCard title={t('usage.modules.pageOpens')}>
          <div className="text-2xl font-bold text-fg">{sumCounts(report.page_opens).toLocaleString()}</div>
        </KpiCard>
        <KpiCard title={t('usage.modules.cacheHitRate')}>
          <div className="text-2xl font-bold text-fg">{formatRate(hitRate)}</div>
          <div className="text-[11px] text-fg-faint mt-0.5">{t('usage.modules.cacheHitRateHint')}</div>
        </KpiCard>
      </div>

      {clients.length > 0 && (
        <SectionCard title={t('usage.modules.byClient')}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] text-[11px]">
              <thead>
                <tr className="text-fg-faint">
                  <th className="text-left font-medium pb-2">{t('usage.modules.client')}</th>
                  <th className="text-right font-medium pb-2">{t('usage.modules.toolCalls')}</th>
                  <th className="text-right font-medium pb-2">{t('usage.modules.pageOpens')}</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.client} className="text-fg-secondary border-b border-edge last:border-0">
                    <td className="py-1.5 font-medium text-fg">{clientLabel(c.client, t)}</td>
                    <td className="py-1.5 text-right font-mono">{c.toolCalls.toLocaleString()}</td>
                    <td className="py-1.5 text-right font-mono">{c.pageOpens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <SectionCard title={t('usage.modules.toolCallsByTool')}>
          <KeyTotalsTable
            rows={tools}
            keyHeader={t('usage.modules.tool')}
            renderKey={(key) => <span className="font-mono font-medium text-fg">{key}</span>}
            emptyLabel={t('usage.modules.noToolCalls')}
          />
        </SectionCard>
        <SectionCard title={t('usage.modules.pageOpensByModule')}>
          <KeyTotalsTable
            rows={modules}
            keyHeader={t('usage.modules.module')}
            renderKey={(key) => (
              <span className="font-medium text-fg" title={key}>
                {moduleLabel(key, t, extensionNames)}
              </span>
            )}
            emptyLabel={t('usage.modules.noPageOpens')}
          />
        </SectionCard>
      </div>

      <SectionCard title={t('usage.modules.cacheByModel')}>
        {report.cache_by_model.length === 0 ? (
          <div className="text-sm text-fg-faint">{t('usage.modules.noModelCalls')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-[11px]">
              <thead>
                <tr className="text-fg-faint">
                  <th className="text-left font-medium pb-2">{t('usage.modules.model')}</th>
                  <th className="text-right font-medium pb-2">{t('usage.calls')}</th>
                  <th className="text-right font-medium pb-2">{t('usage.input')}</th>
                  <th className="text-right font-medium pb-2">{t('usage.modules.cachedTokens')}</th>
                  <th className="text-right font-medium pb-2">{t('usage.modules.hitRate')}</th>
                </tr>
              </thead>
              <tbody>
                {report.cache_by_model.map((m) => (
                  <tr key={m.model} className="text-fg-secondary border-b border-edge last:border-0">
                    <td className="py-1.5 font-mono font-medium text-fg">{m.model}</td>
                    <td className="py-1.5 text-right">{m.calls.toLocaleString()}</td>
                    <td className="py-1.5 text-right">{formatTokens(m.input_tokens)}</td>
                    <td className="py-1.5 text-right">{formatTokens(m.cached_tokens)}</td>
                    <td className="py-1.5 text-right font-mono">{formatRate(m.hit_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
