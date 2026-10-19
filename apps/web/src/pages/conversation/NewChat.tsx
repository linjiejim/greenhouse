/**
 * A new chat (CONV-03, CONV-29): a greeting, three starters and the composer. `@` picks the Agent
 * that answers (the main Agent by default). Starters are my most-used skills for that Agent, else
 * its template's opening lines; a skill's page can open a new chat with it chosen. The chat
 * exists from the first message on.
 */

import { useMemo, useRef, useState } from 'react';
import { AGENT_TEMPLATES, MAIN_AGENT_TEMPLATE } from '@greenhouse/types/agent-templates';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { Composer, type Candidate, type ComposerSend } from '../../conversation/Composer';
import { useAgents } from '../../data/agents';
import { sendMessage } from '../../data/conversations';
import { useSkillStarters, useSkills } from '../../data/skills';
import { addMessage } from '../../data/realtime';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { Page, PageHeader } from '../../shell/Page';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '../../data/query';

export function NewChat({ agentId, skillId }: { agentId?: string; skillId?: string }) {
  const { t, locale } = useI18n();
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
  const [picked, setPicked] = useState<Candidate | null>();
  const preset = agentId ? candidates.find((candidate) => candidate.handle === agentId) : undefined;
  const target = picked === undefined ? (preset ?? null) : picked;
  const selectedAgentId = picked === null ? undefined : (picked?.handle ?? agentId);
  const main = agents.items.find((agent) => agent.is_main);
  const answering = selectedAgentId ? agents.items.find((agent) => agent.id === selectedAgentId) : main;
  // A created chat survives a failed first send. Keep only IDs here; server rows live in QueryClient.
  const pendingChats = useRef(new Map<string, string>());
  const [seed, setSeed] = useState<{ text: string }>();
  const template =
    answering &&
    (answering.is_main ? MAIN_AGENT_TEMPLATE : AGENT_TEMPLATES.find((item) => item.key === answering.template_key));
  const agentKey = answering?.is_main ? undefined : selectedAgentId;
  const skills = useSkills({ agent: agentKey ?? 'main' });
  const suggested = useSkillStarters(agentKey);
  const [skillStart, setSkillStart] = useState<string | undefined>(skillId);
  const skillStarters = suggested.data?.skills ?? [];
  const starters = (suggested.data?.starters ?? template?.copy[locale].starters ?? []).slice(0, 3);

  const start = async (input: ComposerSend) => {
    const targetKey = answering?.is_main ? 'main' : (selectedAgentId ?? 'main');
    let chatId = pendingChats.current.get(targetKey) ?? (answering && pendingChats.current.get(answering.id));
    try {
      if (!chatId) {
        const chat = await api.conversations.create({
          kind: 'chat',
          ...(agentKey ? { agent_id: agentKey } : {}),
        });
        chatId = chat.id;
        pendingChats.current.set(targetKey, chatId);
        if (chat.agent_id) pendingChats.current.set(chat.agent_id, chatId);
        client.setQueryData(keys.conversation(chatId), chat);
      }
      const result = await sendMessage(chatId, input);
      addMessage(client, result.message);
      void client.invalidateQueries({ queryKey: keys.conversations });
      navigate({ page: 'conversation', id: chatId }, { replace: true });
    } catch (error) {
      if (chatId && error instanceof ApiClientError && error.status === 404 && error.code === 'not_found') {
        try {
          // A missing attachment can also fail a send. Forget the chat only when it is itself gone.
          await api.conversations.get(chatId);
        } catch (missing) {
          if (missing instanceof ApiClientError && missing.status === 404 && missing.code === 'not_found') {
            for (const [key, id] of pendingChats.current) {
              if (id === chatId) pendingChats.current.delete(key);
            }
          }
        }
      }
      notify(errorText(error, t));
      throw error;
    }
  };

  return (
    <Page className="app-conversation" scroll={false} header={<PageHeader title={t('chat.newChat')} />}>
      <div className="app-conversation-body">
        <div className="app-new-chat">
          {answering && <AgentAvatar agent={answering} size={72} state="hello" />}
          <h2>{t('chat.greeting', { name: me.name })}</h2>
          {skillStarters.length > 0 ? (
            <div className="app-starters" role="list" aria-label={t('chat.starters')}>
              {skillStarters.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  role="listitem"
                  className="app-starter"
                  onClick={() => setSkillStart(skill.id)}
                >
                  <span className="app-mono">/{skill.name}</span>
                  {skill.display_name ? ` · ${skill.display_name}` : ''}
                </button>
              ))}
            </div>
          ) : (
            starters.length > 0 && (
              <div className="app-starters" role="list" aria-label={t('chat.starters')}>
                {starters.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    role="listitem"
                    className="app-starter"
                    onClick={() => setSeed({ text: starter })}
                  >
                    {starter}
                  </button>
                ))}
              </div>
            )
          )}
        </div>
        <Composer
          placeholder={t('composer.placeholder', { name: answering?.name ?? 'Greeny' })}
          working={false}
          candidates={candidates}
          mode="switch"
          target={target && !answering?.is_main ? target : null}
          onTarget={setPicked}
          seed={seed}
          skills={skills.items}
          initialSkill={skillStart}
          onSend={start}
          onStop={() => undefined}
        />
      </div>
    </Page>
  );
}
