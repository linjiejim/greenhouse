/**
 * 管理 → 公开 Agents (ADM-10): every published Agent with its owner, audience and this month's
 * use by its audience. Pausing stops its audience (not its owner) until it is resumed.
 */

import { Pause, Play, Sparkles } from 'lucide-react';
import { Button, Empty, ErrorBox, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { formatTokens } from '../../shell/usage';

const KEY = ['admin', 'public-agents'] as const;

export function PublicAgentsSection() {
  const { t, locale } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const agents = useQuery({ queryKey: KEY, queryFn: () => api.admin.publicAgents.list({ limit: 200 }) });
  const toggle = (id: string, paused: boolean) =>
    void (paused ? api.admin.publicAgents.resume(id) : api.admin.publicAgents.pause(id))
      .then(() => client.invalidateQueries({ queryKey: KEY }))
      .catch((error: unknown) => notify(error instanceof ApiClientError ? error.message : t('common.error')));
  if (agents.isPending) return <Skeleton lines={4} />;
  if (agents.isError) return <ErrorBox onRetry={() => void agents.refetch()}>{t('common.error')}</ErrorBox>;
  const items = agents.data.items;
  if (!items.length) return <Empty icon={<Sparkles />} title={t('agents.noPublic')} />;
  return (
    <ul className="app-list">
      {items.map((agent) => (
        <li key={agent.id} className="app-list-row is-static">
          <AgentAvatar agent={{ id: agent.id, avatar: agent.avatar, template_key: null }} size={28} />
          <span className="app-list-main">
            <span className="app-list-title">
              {agent.name} · {t('agents.version', { version: agent.published_version })}
            </span>
            <span className="app-list-meta">
              {t('publicAgents.meta', {
                owner: agent.owner.name,
                audience: agent.audience_size,
                people: agent.month.people,
                tokens: formatTokens(agent.month.tokens, locale),
              })}
            </span>
          </span>
          {agent.paused_at && <StatusBadge status={t('publicAgents.paused')} tone="neutral" />}
          <Button size="sm" onClick={() => toggle(agent.id, !!agent.paused_at)}>
            {agent.paused_at ? <Play size={icon.sm} /> : <Pause size={icon.sm} />}
            {agent.paused_at ? t('publicAgents.resume') : t('publicAgents.pause')}
          </Button>
        </li>
      ))}
    </ul>
  );
}
