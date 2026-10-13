/**
 * The Agent directory (AGNT-16): mine, public, archived. A card per Agent with its plant, name,
 * role and when it last worked; opening it goes to the profile.
 */

import { Archive, Plus, Sparkles } from 'lucide-react';
import { Button, Empty, ErrorBox, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useMe } from '../../app/session';
import { useAgents } from '../../data/agents';
import { useI18n } from '../../lib/i18n';
import { href, type AgentScope } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { useOpenOverlay } from '../../shell/overlays';
import { Page, PageHeader } from '../../shell/Page';

export function AgentsPage({ scope }: { scope: AgentScope }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const openOverlay = useOpenOverlay();
  const agents = useAgents(scope === 'archived' ? 'archived' : 'mine');
  const newAgent = (
    <Button kind="primary" onClick={() => openOverlay({ type: 'new-agent' })}>
      <Plus size={icon.md} />
      {t('agents.new')}
    </Button>
  );

  let body;
  if (scope === 'public') {
    body = <Empty icon={<Sparkles />} title={t('agents.noPublic')} />;
  } else if (agents.isPending) {
    body = <Skeleton lines={4} />;
  } else if (agents.isError) {
    body = <ErrorBox onRetry={() => void agents.refetch()}>{t('common.error')}</ErrorBox>;
  } else if (!agents.items.length) {
    body =
      scope === 'archived' ? (
        <Empty icon={<Archive />} title={t('agents.noArchived')} />
      ) : (
        <Empty icon={<Sparkles />} title={t('agents.none')} action={newAgent} />
      );
  } else {
    body = (
      <ul className="app-card-grid" aria-label={t(`agents.${scope}`)}>
        {agents.items.map((agent) => (
          <li key={agent.id}>
            <a
              className="app-agent-card"
              href={href({ page: 'agent', id: agent.is_main ? 'main' : agent.id, tab: 'profile' })}
            >
              <AgentAvatar agent={agent} size={48} />
              <span className="app-agent-card-text">
                <strong>{agent.name}</strong>
                <span>{agent.role || (agent.is_main ? t('agents.mainRole') : '')}</span>
                {agent.last_active_at && (
                  <span className="app-agent-card-meta">
                    {t('agents.lastActive', {
                      time: relativeTime(agent.last_active_at, { locale, timeZone: me.timezone }),
                    })}
                  </span>
                )}
              </span>
            </a>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Page header={<PageHeader title={t(`agents.${scope}`)} primary={scope === 'mine' ? newAgent : undefined} />}>
      {body}
    </Page>
  );
}
