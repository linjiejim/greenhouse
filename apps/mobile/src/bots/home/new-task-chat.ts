/**
 * "New chat" on the Agents engine (spec docs/specs/20261011-agent-first-class.md §5a, D27): with
 * Agents on, the new-chat screen (app/(drawer)/(main)/index.tsx — the drawer's 新会话, the widget's
 * `?compose=1`, an Agent's "New Chat" `?profile=`) keeps its hero and composer, and its first send
 * creates a task chat — answered by that Agent, Sprouty by default — then continues in the thread
 * (`/?c=`), where the message goes out through the thread's own send path (images included):
 *
 *  1. `POST /api/bots/conversations {kind:'task', bot_id?}` — an Agent that is gone falls back to
 *     the member's Sprouty (as the chat engine does for a stale profile);
 *  2. the thread's in-memory cache is seeded with the new, empty chat (the thread opens at once —
 *     its intro and the message's bubble, no loading spinner);
 *  3. the message waits for the thread in `putFirstSend` (../task-chats.ts), which takes it once.
 *
 * An older server has no task chats (it answers 400 without a code): this station is remembered
 * for the app run and the send — and every later new chat there — stays on the chat engine
 * (`unsupported`), as does an account the Agents routes refuse (403). Existing chat sessions keep
 * opening in the chat screen.
 */

import { useCallback } from 'react';
import { createTaskChat } from '../../api/bots';
import type { ComposerImage } from '../../chat/composer-images';
import { useStations } from '../../store/stations';
import { useBotsEnabled } from '../availability';
import { useBots } from '../store';
import { chatBotId, noteTaskChatsUnsupported, putFirstSend, taskChatFailure, taskChatsSupported } from '../task-chats';
import { threadCache } from '../thread/cache';

export type NewTaskChatOutcome =
  | { kind: 'started'; sessionId: string; title: string }
  /** No task chats here (an older server, Agents refused): send it on the chat engine. */
  | { kind: 'unsupported' }
  /** It could not be created: the draft goes back, with an alert. */
  | { kind: 'failed' }
  /** The account or station changed meanwhile: nothing to do. */
  | { kind: 'stale' };

export function useNewTaskChat(): {
  /** A new chat's first send creates a task chat (Agents on, and this station has them as far as we know). */
  enabled: boolean;
  start(o: { text: string; images: ComposerImage[]; profile?: string }): Promise<NewTaskChatOutcome>;
} {
  const botsOn = useBotsEnabled();
  const stationId = useStations((s) => s.activeId);
  const enabled = botsOn && taskChatsSupported(stationId);

  const start = useCallback(
    async ({ text, images, profile }: { text: string; images: ComposerImage[]; profile?: string }) => {
      const station = useStations.getState().activeId;
      if (!taskChatsSupported(station)) return { kind: 'unsupported' } as const;
      const generation = useBots.getState().generation;
      const botId = chatBotId(profile);
      let result = await createTaskChat(botId ? { bot_id: botId } : {});
      // The chosen Agent is gone: Sprouty answers instead.
      if (!result.ok && botId && taskChatFailure(result) === 'agent_gone') result = await createTaskChat({});
      if (useBots.getState().generation !== generation) return { kind: 'stale' } as const;
      if (!result.ok) {
        if (result.status === 403) {
          // Agents are off for this account: the surfaces close, the chat engine takes the message.
          useBots.getState().noteForbidden();
          return { kind: 'unsupported' } as const;
        }
        if (taskChatFailure(result) === 'unsupported') {
          noteTaskChatsUnsupported(station);
          return { kind: 'unsupported' } as const;
        }
        return { kind: 'failed' } as const;
      }
      const conversation = result.value;
      threadCache.put(conversation.session_id, generation, {
        conversation,
        messages: [],
        hasMore: false,
        memoryStates: {},
      });
      const sent = images.filter((image) => image.status === 'done' && image.remote);
      putFirstSend(conversation.session_id, {
        input: { text, images: sent.map((image) => image.remote!), mentions: [] },
        images: sent,
      });
      void useBots.getState().loadConversations();
      return { kind: 'started', sessionId: conversation.session_id, title: conversation.title ?? '' } as const;
    },
    [],
  );

  return { enabled, start };
}
