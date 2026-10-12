/**
 * Managing a room from its page (spec 20261011-agent-first-class P5): the header's manage menu
 * (add people, bring or remove Agents, leave — "Rename" is the header's own, it edits the title in
 * place), the rename itself, and the dialogs those open. Leaving asks first; the member's Agents
 * leave with them, and the last one out deletes the room — then the page goes back to the main
 * thread.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { BotConversationDetail } from '@greenhouse/types/bots';
import { ConfirmDialog, toast } from '../ui';
import { Bot, LogOut, UserPlus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import * as botsApi from '../../lib/api/bots';
import type { ContextMenuItem } from '../app/context-menu';
import { useBotsStore } from './bots-store';
import { AddPeopleDialog, RoomAgentsDialog, roomErrorMessage } from './room-dialogs';
import type { RoomView } from './use-room';

export interface RoomManage {
  /** The manage menu's entries after "Rename". */
  menu: ContextMenuItem[];
  rename: (title: string) => Promise<void>;
  openAgents: () => void;
  dialogs: ReactNode;
}

export function useRoomManage({
  conversation,
  room,
  title,
  onChanged,
  onStale,
}: {
  conversation: BotConversationDetail | null;
  room: RoomView | null;
  title: string;
  /** The route returned the room as it is now. */
  onChanged: (next: BotConversationDetail) => void;
  /** Something changed that only a re-read shows (an Agent taken out). */
  onStale: () => void;
}): RoomManage {
  const t = useT();
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const [open, setOpen] = useState<'people' | 'agents' | 'leave' | null>(null);
  const sessionId = conversation?.session_id ?? null;

  const changed = useCallback(
    (next: BotConversationDetail) => {
      onChanged(next);
      void loadConversations().catch(() => {});
    },
    [loadConversations, onChanged],
  );

  const rename = useCallback(
    async (next: string) => {
      if (!sessionId) return;
      try {
        changed(await botsApi.renameRoom(sessionId, next));
      } catch (err) {
        toast(roomErrorMessage(err, t, 'bots.room.errors.renameFailed'), 'error');
        throw err;
      }
    },
    [changed, sessionId, t],
  );

  const leave = useCallback(async () => {
    setOpen(null);
    if (!sessionId || !room?.me) return;
    try {
      await botsApi.removeRoomPerson(sessionId, room.me);
      toast(t('bots.room.left', { name: title }), 'success');
      void loadConversations().catch(() => {});
      window.location.hash = '#/bots';
    } catch (err) {
      toast(roomErrorMessage(err, t, 'bots.room.errors.leaveFailed'), 'error');
    }
  }, [loadConversations, room?.me, sessionId, t, title]);

  const menu = useMemo<ContextMenuItem[]>(
    () =>
      room
        ? [
            { label: t('bots.room.addPeople'), icon: UserPlus, onClick: () => setOpen('people') },
            { label: t('bots.room.agentsMenu'), icon: Bot, onClick: () => setOpen('agents') },
            { label: t('bots.room.leave'), icon: LogOut, danger: true, onClick: () => setOpen('leave') },
          ]
        : [],
    [room, t],
  );

  const onlyOneLeft = (room?.participants.length ?? 0) <= 1;
  const dialogs =
    conversation && room ? (
      <>
        <AddPeopleDialog
          open={open === 'people'}
          conversation={conversation}
          onClose={() => setOpen(null)}
          onChanged={changed}
        />
        <RoomAgentsDialog
          open={open === 'agents'}
          conversation={conversation}
          room={room}
          onClose={() => setOpen(null)}
          onChanged={(next) => {
            if (next) changed(next);
            else {
              onStale();
              void loadConversations().catch(() => {});
            }
          }}
        />
        <ConfirmDialog
          open={open === 'leave'}
          onClose={() => setOpen(null)}
          onConfirm={() => void leave()}
          title={t('bots.room.leaveConfirm', { name: title })}
          description={onlyOneLeft ? t('bots.room.leaveLastDescription') : t('bots.room.leaveDescription')}
          confirmLabel={t('bots.room.leave')}
          confirmVariant="destructive"
        />
      </>
    ) : null;

  return { menu, rename, openAgents: () => setOpen('agents'), dialogs };
}
