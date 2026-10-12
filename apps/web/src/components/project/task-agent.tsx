/**
 * A project task handed to an Agent (spec 20261011-agent-first-class P3e, D32).
 *
 * "Hand to Agent" opens a task chat answered by one of the member's active
 * Agents, starting from the task (`POST /api/projects/tasks/:id/agent`). The
 * assignee stays the person responsible; the task records the Agent and the
 * chat (`agent_id` / `agent_session_id`), shown as "Agent: X · Open chat".
 * Only with Agents on (`bots`); the server refuses otherwise (403).
 */

import { useEffect, useMemo, useState } from 'react';
import type { BotView } from '@greenhouse/types/bots';
import { Button, Dialog, Select, toast } from '../ui';
import { FormActions, FormField } from '../form';
import { ArrowUpRight, Bot } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { canUseFeature } from '../../lib/features';
import { handTaskToAgent, ProjectsApiError } from '../../lib/api/projects';
import { useAuthStore } from '../../stores/auth-store';
import { useBotsStore } from '../bots/bots-store';
import { BotAvatar } from '../bots/bot-avatar';
import { botsConversationHash, openBotsConversation } from '../bots/navigation';
import type { Task } from './types';

/** Agents are on for the member: the hand-to-Agent controls show, and the Agent list is loaded once. */
export function useTaskAgents(): { enabled: boolean; agents: BotView[]; directory: ReadonlyMap<string, BotView> } {
  const enabled = useAuthStore((state) => canUseFeature(state.currentUser, 'bots'));
  const agents = useBotsStore((state) => state.bots);
  const archived = useBotsStore((state) => state.archivedBots);
  const botsLoaded = useBotsStore((state) => state.botsLoaded);
  const loadBots = useBotsStore((state) => state.loadBots);
  useEffect(() => {
    if (enabled && !botsLoaded) void loadBots().catch(() => {});
  }, [enabled, botsLoaded, loadBots]);
  const directory = useMemo(() => new Map([...archived, ...agents].map((bot) => [bot.id, bot])), [agents, archived]);
  return { enabled, agents, directory };
}

/** "Agent: Sage · Open chat" — the chat link only for the member's own Agent (another member's chat is theirs). */
export function TaskAgentRow({ task, directory }: { task: Task; directory: ReadonlyMap<string, BotView> }) {
  const t = useT();
  if (!task.agent_id) return null;
  const agent = directory.get(task.agent_id);
  const name = agent
    ? agent.status === 'active'
      ? agent.name
      : t('bots.archivedName', { name: agent.name })
    : t('task.agent.otherMember');
  return (
    <div className="flex items-center gap-2 text-fg-muted" data-testid="task-agent-row">
      <Bot size={12} />
      <span className="text-fg-faint w-12">{t('task.agent.label')}</span>
      {agent && <BotAvatar bot={agent} size="xs" />}
      <span className="min-w-0 truncate text-fg-secondary" title={name}>
        {name}
      </span>
      {agent && task.agent_session_id && (
        <>
          <span className="text-fg-faint">·</span>
          <a
            href={botsConversationHash(task.agent_session_id)}
            className="inline-flex flex-shrink-0 items-center gap-0.5 text-primary-fg hover:underline"
            data-testid="task-agent-open-chat"
          >
            {t('task.agent.openChat')}
            <ArrowUpRight size={10} aria-hidden="true" />
          </a>
        </>
      )}
    </div>
  );
}

/** Pick one of the member's active Agents and hand the task to it. */
export function HandToAgentDialog({
  task,
  agents,
  open,
  onClose,
  onHanded,
}: {
  task: Task;
  agents: readonly BotView[];
  open: boolean;
  onClose: () => void;
  /** The task now names the Agent and its chat: re-read it. */
  onHanded: () => void;
}) {
  const t = useT();
  const [botId, setBotId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setBotId((current) => current || agents[0]?.id || '');
  }, [open, agents]);

  const submit = async () => {
    const agent = agents.find((candidate) => candidate.id === botId);
    if (!agent) return;
    setBusy(true);
    try {
      const { session_id } = await handTaskToAgent(task.id, agent.id);
      onClose();
      onHanded();
      toast(t('task.agent.started', { name: agent.name }), 'success', {
        action: { label: t('task.agent.openChat'), onClick: () => openBotsConversation(session_id) },
      });
    } catch (err) {
      const status = err instanceof ProjectsApiError ? err.status : 0;
      toast(
        t(status === 403 ? 'task.agent.disabled' : status === 404 ? 'task.agent.notFound' : 'task.agent.failed'),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('task.agent.title', { title: task.title })} size="md">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        data-testid="task-hand-to-agent-dialog"
      >
        <p className="text-xs leading-5 text-fg-muted">{t('task.agent.description')}</p>
        {agents.length === 0 ? (
          <p className="text-xs text-fg-faint">{t('task.agent.none')}</p>
        ) : (
          <FormField label={t('task.agent.pick')}>
            <Select
              id="task-agent-pick"
              value={botId}
              onChange={(event) => setBotId(event.target.value)}
              data-testid="task-agent-pick"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormActions>
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" type="submit" disabled={busy || !botId} data-testid="task-agent-start">
            {busy ? t('task.agent.starting') : t('task.agent.start')}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
