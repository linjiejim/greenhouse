/**
 * The conversations sidebar (spec 20261011-agent-first-class §3.1): ONE list for every place the
 * member talks, under one search box —
 *
 *   Agents       the larger main Agent first, then the other Agents by activity (archived ones folded under "Archived")
 *   People       conversations with other members
 *   Background   the background tasks those Agents run, live first (a row opens its thread)
 *   Chats        the member's independent chats, with their scope tabs, folders, tags and dates —
 *                separate Agent chats among them (they open at `#/bots?c=`, spec §5a D21)
 *
 * Shown on both conversation routes — an Agent thread (`#/bots?c=`) and a chat (`#/chat`) — so
 * moving between them never swaps the list. Without Agent threads (the `bots` feature off) it is
 * just the chats, exactly as before.
 */

import { useState } from 'react';
import { useT } from '../../../lib/i18n';
import { canUseFeature } from '../../../lib/features';
import { useAuthStore } from '../../../stores';
import { BotsDialogs } from '../../bots/bots-dialogs';
import { BotsThreadsSection } from '../../bots/bots-sidebar-panel';
import { BackgroundTasksSection } from '../../bots/background-tasks-section';
import { openBotsConversation, useCurrentBotsConversation } from '../../bots/navigation';
import { ChatHistoryPanel } from './chat-history-panel';

export function ConversationsSidebarPanel({
  currentSessionId,
  onSelectSession,
  onNavigate,
  hostDialogs = false,
}: {
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  /** Called after any row opens something (the phone drawer closes itself). */
  onNavigate?: () => void;
  /** Mount the "new Agent" dialog here — on the chats route; the Agent threads page mounts its own. */
  hostDialogs?: boolean;
}) {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const threads = canUseFeature(currentUser, 'bots');
  const [query, setQuery] = useState('');
  const currentAgentChat = useCurrentBotsConversation();

  return (
    <>
      <ChatHistoryPanel
        currentSessionId={currentSessionId}
        onSelectSession={(sessionId) => {
          onSelectSession(sessionId);
          onNavigate?.();
        }}
        onQueryChange={setQuery}
        {...(threads
          ? {
              searchPlaceholder: t('bots.sidebar.searchAll'),
              leading: (
                <>
                  <BotsThreadsSection query={query} onNavigate={onNavigate} />
                  <BackgroundTasksSection query={query} onNavigate={onNavigate} />
                </>
              ),
              chatsTitle: t('bots.sidebar.chats'),
              agentChats: {
                currentId: currentAgentChat,
                onOpen: (sessionId: string) => {
                  openBotsConversation(sessionId);
                  onNavigate?.();
                },
              },
            }
          : {})}
      />
      {threads && hostDialogs && <BotsDialogs threadsEnabled />}
    </>
  );
}
