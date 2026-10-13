/** The side panel's info view (CONV-22): who is here and the summary of older messages. */

import { Overlay } from '@greenhouse/ui/kit';
import type { Conversation, ConversationDetail } from '@greenhouse/contract';
import { usePeople } from '../../data/people';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { MemberAvatar } from '../../shell/MemberAvatar';

export function InfoDrawer({
  conversation,
  detail,
  onClose,
}: {
  conversation: Conversation;
  detail: ConversationDetail | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const people = usePeople();
  const agentIds = [conversation.agent_id, ...(detail?.agent_ids ?? [])].filter(
    (id, index, all): id is string => !!id && all.indexOf(id) === index,
  );
  return (
    <Overlay title={t('chat.info')} onClose={onClose}>
      <section className="app-info-section">
        <h3>{t('chat.inThisConversation')}</h3>
        <ul className="app-info-people">
          {agentIds.map((id) => {
            const agent = people.agentById.get(id);
            return (
              <li key={id}>
                {agent ? <AgentAvatar agent={agent} size={28} /> : null}
                {agent ? (
                  <a href={href({ page: 'agent', id: agent.is_main ? 'main' : agent.id, tab: 'profile' })}>
                    {agent.name}
                  </a>
                ) : (
                  'Agent'
                )}
                <span className="app-info-hint">{agent?.role}</span>
              </li>
            );
          })}
          {(detail?.members ?? []).map((member) => {
            const person = people.memberById.get(member.member_id);
            return (
              <li key={member.member_id}>
                <MemberAvatar name={person?.name ?? '—'} url={person?.avatar_url} size={28} />
                <span>{person?.name ?? '—'}</span>
                {member.role === 'owner' && <span className="app-info-hint">{t('chat.owner')}</span>}
              </li>
            );
          })}
        </ul>
      </section>
      {detail?.digest && (
        <section className="app-info-section">
          <h3>{t('chat.summary')}</h3>
          <p className="app-info-summary">{detail.digest}</p>
        </section>
      )}
    </Overlay>
  );
}
