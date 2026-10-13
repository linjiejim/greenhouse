/**
 * A new chat (CONV-03, CONV-29): a greeting and the composer. `@` picks the Agent that answers
 * (the main Agent by default). The chat exists from the first message on.
 */

import { useMemo, useState } from 'react';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { Composer, type Candidate, type ComposerSend } from '../../conversation/Composer';
import { useAgents } from '../../data/agents';
import { addMessage } from '../../data/realtime';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { Page, PageHeader } from '../../shell/Page';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '../../data/query';

export function NewChat({ agentId }: { agentId?: string }) {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const agents = useAgents('mine');
  const candidates: Candidate[] = useMemo(
    () =>
      agents.items.map((agent) => ({
        handle: agent.id,
        name: agent.name,
        hint: agent.role,
        leading: <AgentAvatar agent={agent} size={20} />,
      })),
    [agents.items],
  );
  const [picked, setPicked] = useState<Candidate | null>(null);
  const preset = agentId ? candidates.find((candidate) => candidate.handle === agentId) : undefined;
  const target = picked ?? preset ?? null;
  const main = agents.items.find((agent) => agent.is_main);
  const answering = target ? agents.items.find((agent) => agent.id === target.handle) : main;

  const start = async (input: ComposerSend) => {
    try {
      const chat = await api.conversations.create({
        kind: 'chat',
        ...(answering && !answering.is_main ? { agent_id: answering.id } : {}),
      });
      const result = await api.conversations.send(chat.id, input);
      client.setQueryData(keys.conversation(chat.id), chat);
      addMessage(client, result.message);
      void client.invalidateQueries({ queryKey: keys.conversations });
      navigate({ page: 'conversation', id: chat.id }, { replace: true });
    } catch (error) {
      notify(error instanceof ApiClientError ? error.message : t('common.error'));
      throw error;
    }
  };

  return (
    <Page className="app-conversation" scroll={false} header={<PageHeader title={t('chat.newChat')} />}>
      <div className="app-conversation-body">
        <div className="app-new-chat">
          {answering && <AgentAvatar agent={answering} size={72} />}
          <h2>{t('chat.greeting', { name: me.name })}</h2>
        </div>
        <Composer
          placeholder={t('composer.placeholder', { name: answering?.name ?? 'Greeny' })}
          working={false}
          candidates={candidates}
          mode="switch"
          target={target && !answering?.is_main ? target : null}
          onTarget={setPicked}
          onSend={start}
          onStop={() => undefined}
        />
      </div>
    </Page>
  );
}
