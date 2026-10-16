import { errorText } from '../../lib/errors';
/**
 * The Agent directory (AGNT-16): mine, public, archived. A card per Agent with its plant, name,
 * role and when it last worked; opening it goes to the profile.
 */

import { Archive, Plus, Sparkles } from 'lucide-react';
import { Button, Empty, ErrorBox, Skeleton } from '@greenhouse/ui/kit';
import { useQuery } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useCreateConversation } from '../../data/conversations';
import { api } from '../../lib/api';
import { icon } from '@greenhouse/ui/tokens';
import { useMe } from '../../app/session';
import { useAgents } from '../../data/agents';
import { useI18n } from '../../lib/i18n';
import { href, navigate, type AgentScope } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { useOpenOverlay } from '../../shell/overlays';
import { Page, PageHeader } from '../../shell/Page';

/** Other members' public Agents shared with me (AGNT-14): talk to one in its own thread. */
function PublicAgents() {
  const { t } = useI18n();
  const notify = useNotify();
  const create = useCreateConversation();
  const shared = useQuery({ queryKey: ['agents', 'list', 'public'], queryFn: () => api.publication.shared() });
  if (shared.isPending) return <Skeleton lines={4} />;
  if (shared.isError) return <ErrorBox onRetry={() => void shared.refetch()}>{errorText(shared.error, t)}</ErrorBox>;
  if (!shared.data.items.length) return <Empty icon={<Sparkles />} title={t('agents.noPublic')} />;
  return (
    <ul className="app-card-grid" aria-label={t('agents.public')}>
      {shared.data.items.map((agent) => (
        <li key={agent.id}>
          <button
            type="button"
            className="app-agent-card"
            onClick={() =>
              create.mutate(
                { kind: 'direct', agent_id: agent.id },
                {
                  onSuccess: (conversation) => navigate({ page: 'conversation', id: conversation.id }),
                  onError: (error) => notify(errorText(error, t)),
                },
              )
            }
          >
            <AgentAvatar agent={agent} size={48} />
            <span className="app-agent-card-text">
              <strong>{agent.name}</strong>
              <span>{agent.role}</span>
              <span className="app-agent-card-meta">{t('agents.byOwner', { name: agent.owner.name })}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

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
    body = <PublicAgents />;
  } else if (agents.isPending) {
    body = <Skeleton lines={4} />;
  } else if (agents.isError) {
    body = <ErrorBox onRetry={() => void agents.refetch()}>{errorText(agents.error, t)}</ErrorBox>;
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
    <Page
      header={
        <PageHeader
          title={t(`agents.${scope}`)}
          primary={
            scope === 'mine' && (agents.items.length > 0 || agents.isPending || agents.isError) ? newAgent : undefined
          }
        />
      }
    >
      {body}
    </Page>
  );
}
