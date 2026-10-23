/**
 * Settings › Agent connections — the member's own external agents: which are
 * connected, what they wrote, and how to connect one. Agents act with the
 * member's permissions; nothing waits for approval here. Deep links:
 *   #/settings/agent-connections/<tab>
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ModulePage } from '../../../components/app/module-page';
import { Tabs } from '../../../components/ui';
import { Info } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import { fetchAgentAccessOverview, type AgentAccessOverview } from '../../../lib/api/agent-access';
import { ConnectedAgents } from './connected';
import { AgentActivity } from './activity';
import { ConnectGuide } from './connect';

const TABS = ['connected', 'activity', 'connect'] as const;
type TabKey = (typeof TABS)[number];
const BASE_HASH = '#/settings/agent-connections';

function tabFromSubPath(subPath: string): TabKey | null {
  const [, second] = subPath.split('/').filter(Boolean);
  return (TABS as readonly string[]).includes(second ?? '') ? (second as TabKey) : null;
}

export function AgentAccessPanel({ subPath }: { subPath: string }) {
  const t = useT();
  const routeTab = useMemo(() => tabFromSubPath(subPath), [subPath]);
  const [overview, setOverview] = useState<AgentAccessOverview | null>(null);
  const [tab, setTab] = useState<TabKey>(routeTab ?? 'connected');

  useEffect(() => {
    let cancelled = false;
    void fetchAgentAccessOverview()
      .then((next) => {
        if (!cancelled) setOverview(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (routeTab) setTab(routeTab);
  }, [routeTab]);

  const changeTab = (key: string) => {
    setTab(key as TabKey);
    window.history.replaceState(null, '', `${BASE_HASH}/${key}`);
  };

  return (
    <ModulePage
      moduleId="settings.agent-connections"
      layout="list"
      notice={
        <p className="flex items-start gap-2 text-xs text-fg-secondary leading-relaxed">
          <Info size={14} className="text-info flex-shrink-0 mt-0.5" />
          {t('agentAccess.intro')}
        </p>
      }
      tabs={
        <Tabs
          ariaLabel={t('navigation.agentConnections')}
          active={tab}
          onChange={changeTab}
          tabs={[
            { key: 'connected', label: t('agentAccess.tabConnected') },
            { key: 'activity', label: t('agentAccess.tabActivity') },
            { key: 'connect', label: t('agentAccess.tabConnect') },
          ]}
        />
      }
    >
      {tab === 'connected' && <ConnectedAgents onConnect={() => changeTab('connect')} />}
      {tab === 'activity' && <AgentActivity />}
      {tab === 'connect' && <ConnectGuide mcpUrl={overview?.mcp_url ?? `${window.location.origin}/api/mcp`} />}
    </ModulePage>
  );
}
