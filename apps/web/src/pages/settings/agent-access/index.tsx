/**
 * Settings › Agent connections — the member's own external agents:
 * approvals waiting on them, connected agents, standing grants, the write
 * history, and how to connect. Deep links:
 *   #/settings/agent-connections/<tab>
 *   #/settings/agent-connections/requests/<request id>   (from the agent / inbox)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentWritePendingView } from '@greenhouse/types/agent-access';
import { ModulePage } from '../../../components/app/module-page';
import { Tabs } from '../../../components/ui';
import { AlertTriangle, Info } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import {
  fetchAgentAccessOverview,
  fetchPendingAgentWrites,
  type AgentAccessOverview,
} from '../../../lib/api/agent-access';
import { PendingApprovals } from './pending';
import { ConnectedAgents } from './connected';
import { StandingGrants } from './grants';
import { AgentActivity } from './activity';
import { ConnectGuide } from './connect';

const TABS = ['pending', 'connected', 'grants', 'activity', 'connect'] as const;
type TabKey = (typeof TABS)[number];
const BASE_HASH = '#/settings/agent-connections';
const PENDING_POLL_MS = 20_000;

function parseSubPath(subPath: string): { tab: TabKey | null; requestId: string | null } {
  const [, second, third] = subPath.split('/').filter(Boolean);
  if (second === 'requests' && third) return { tab: 'pending', requestId: decodeURIComponent(third) };
  return { tab: (TABS as readonly string[]).includes(second ?? '') ? (second as TabKey) : null, requestId: null };
}

export function AgentAccessPanel({ subPath }: { subPath: string }) {
  const t = useT();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const [overview, setOverview] = useState<AgentAccessOverview | null>(null);
  const [pending, setPending] = useState<AgentWritePendingView[]>([]);
  const [loadingPending, setLoadingPending] = useState(true);
  const [missingRequest, setMissingRequest] = useState(false);
  const [tab, setTab] = useState<TabKey | null>(route.tab);

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, nextPending] = await Promise.all([fetchAgentAccessOverview(), fetchPendingAgentWrites()]);
      setOverview(nextOverview);
      setPending(nextPending);
      return nextPending;
    } finally {
      setLoadingPending(false);
    }
  }, []);

  // First load decides the default tab: approvals when something waits, else the agent list.
  useEffect(() => {
    let cancelled = false;
    void refresh()
      .then((rows) => {
        if (cancelled) return;
        if (route.requestId && !rows.some((row) => row.request_id === route.requestId)) setMissingRequest(true);
        setTab((current) => current ?? (rows.length > 0 ? 'pending' : 'connected'));
      })
      .catch(() => {
        if (!cancelled) setTab((current) => current ?? 'connected');
      });
    return () => {
      cancelled = true;
    };
  }, [refresh, route.requestId]);

  useEffect(() => {
    if (route.tab) setTab(route.tab);
  }, [route.tab]);

  // New requests arrive while the member is looking at the list.
  useEffect(() => {
    if (tab !== 'pending') return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [tab, refresh]);

  const changeTab = (key: string) => {
    setMissingRequest(false);
    setTab(key as TabKey);
    window.history.replaceState(null, '', `${BASE_HASH}/${key}`);
  };

  const active = tab ?? 'pending';
  const notice = (
    <div className="space-y-2">
      <p className="flex items-start gap-2 text-xs text-fg-secondary leading-relaxed">
        <Info size={14} className="text-info flex-shrink-0 mt-0.5" />
        {t('agentAccess.intro')}
      </p>
      {overview?.legacy_confirm && (
        <p className="flex items-start gap-2 text-xs text-warning-fg bg-warning-subtle rounded-lg px-2.5 py-2 leading-relaxed">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          {t('agentAccess.legacyOn')}
        </p>
      )}
      {missingRequest && active === 'pending' && (
        <p className="text-xs text-fg-muted bg-surface-sunken rounded-lg px-2.5 py-2">
          {t('agentAccess.requestNotFound')}
        </p>
      )}
    </div>
  );

  return (
    <ModulePage
      moduleId="settings.agent-connections"
      layout="list"
      notice={notice}
      tabs={
        <Tabs
          ariaLabel={t('navigation.agentConnections')}
          active={active}
          onChange={changeTab}
          tabs={[
            { key: 'pending', label: t('agentAccess.tabPending'), count: pending.length || undefined },
            { key: 'connected', label: t('agentAccess.tabConnected') },
            { key: 'grants', label: t('agentAccess.tabGrants') },
            { key: 'activity', label: t('agentAccess.tabActivity') },
            { key: 'connect', label: t('agentAccess.tabConnect') },
          ]}
        />
      }
    >
      {active === 'pending' && (
        <PendingApprovals
          requests={pending}
          loading={loadingPending}
          highlightId={route.requestId}
          onChanged={() => void refresh().catch(() => undefined)}
        />
      )}
      {active === 'connected' && <ConnectedAgents onConnect={() => changeTab('connect')} />}
      {active === 'grants' && <StandingGrants />}
      {active === 'activity' && <AgentActivity />}
      {active === 'connect' && <ConnectGuide mcpUrl={overview?.mcp_url ?? `${window.location.origin}/api/mcp`} />}
    </ModulePage>
  );
}
