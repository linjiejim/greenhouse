/**
 * "Browse Agents" (spec 20261011-agent-first-class P4): the Agents other members published to this
 * member (`GET /api/agents` — never their own). Each shows its face, name, role, one line and whose it
 * is; "Talk" opens the member's own conversation with it (`POST /api/agents/:id/conversation`, made
 * with its greeting on first use) at `#/bots?c=`. Opened from the conversations sidebar toolbar and
 * Settings → My Agents through the Bots store (`dialog.kind === 'directory'`).
 */

import { useEffect, useMemo, useState } from 'react';
import type { SharedBotView } from '@greenhouse/types/bots';
import { Button, Dialog, EmptyState, SearchInput, Skeleton, toast } from '../ui';
import { AlertTriangle, MessageCircle, Search, Users } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { isBotsApiError, listPublicAgents, openPublicAgent } from '../../lib/api/bots';
import { BotAvatar } from './bot-avatar';
import { useBotsStore } from './bots-store';
import { openBotsConversation } from './navigation';

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; agents: SharedBotView[] };

export function AgentDirectoryDialog({
  open,
  onClose,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  /** After the conversation opened (the phone drawer closes itself). */
  onOpened?: () => void;
}) {
  const t = useT();
  const upsertShared = useBotsStore((state) => state.upsertShared);
  const loadBots = useBotsStore((state) => state.loadBots);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoad({ state: 'loading' });
    setQuery('');
    listPublicAgents().then(
      (agents) => !cancelled && setLoad({ state: 'ready', agents }),
      () => !cancelled && setLoad({ state: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  const shown = useMemo(() => {
    if (load.state !== 'ready') return [];
    const needle = query.trim().toLocaleLowerCase();
    const agents = [...load.agents].sort((a, b) => a.name.localeCompare(b.name));
    if (!needle) return agents;
    return agents.filter((agent) =>
      [agent.name, agent.role, agent.description, agent.owner.nickname].some((text) =>
        text.toLocaleLowerCase().includes(needle),
      ),
    );
  }, [load, query]);

  const talk = async (agent: SharedBotView) => {
    setOpening(agent.id);
    try {
      const sessionId = agent.dm_session_id ?? (await openPublicAgent(agent.id)).conversation_id;
      // Its name and face for the thread right away; the next list read confirms it.
      upsertShared({ ...agent, dm_session_id: sessionId, available: true });
      void loadBots().catch(() => {});
      void loadConversations().catch(() => {});
      onClose();
      onOpened?.();
      openBotsConversation(sessionId);
    } catch (err) {
      toast(
        isBotsApiError(err) && err.status === 404 ? t('bots.directory.gone') : t('bots.directory.openFailed'),
        'error',
      );
      if (isBotsApiError(err) && err.status === 404) setAttempt((value) => value + 1);
    } finally {
      setOpening(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('bots.directory.title')} size="lg">
      <div className="space-y-3" data-testid="bots-directory">
        <p className="text-xs leading-5 text-fg-muted">{t('bots.directory.hint')}</p>
        {load.state === 'loading' ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : load.state === 'failed' ? (
          <EmptyState
            variant="compact"
            tone="danger"
            icon={AlertTriangle}
            title={t('bots.directory.failed')}
            action={
              <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                {t('bots.retry')}
              </Button>
            }
          />
        ) : load.agents.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={Users}
            title={t('bots.directory.emptyTitle')}
            description={t('bots.directory.emptyDescription')}
          />
        ) : (
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t('bots.directory.search')}
              aria-label={t('bots.directory.search')}
            />
            {shown.length === 0 ? (
              <EmptyState
                variant="compact"
                tone="neutral"
                icon={Search}
                title={t('bots.directory.noMatch', { query: query.trim() })}
              />
            ) : (
              <ul className="divide-y divide-edge" data-testid="bots-directory-list">
                {shown.map((agent) => (
                  <li
                    key={agent.id}
                    className="flex items-start gap-3 py-2.5"
                    data-testid="bots-directory-row"
                    data-bot-id={agent.id}
                  >
                    <BotAvatar bot={agent} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium text-fg" title={agent.name}>
                          {agent.name}
                        </span>
                        {agent.role && (
                          <span className="truncate text-xs text-fg-faint" title={agent.role}>
                            {agent.role}
                          </span>
                        )}
                      </div>
                      {agent.description && (
                        <p className="line-clamp-2 text-xs text-fg-secondary" title={agent.description}>
                          {agent.description}
                        </p>
                      )}
                      <p className="mt-0.5 truncate text-[11px] text-fg-faint" title={agent.owner.nickname}>
                        {t('bots.shared.by', { name: agent.owner.nickname })}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={agent.dm_session_id ? 'outline' : 'default'}
                      disabled={opening !== null}
                      onClick={() => void talk(agent)}
                      data-testid="bots-directory-talk"
                    >
                      <MessageCircle size={13} className="mr-1" />
                      {agent.dm_session_id ? t('bots.directory.open') : t('bots.directory.talk')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
