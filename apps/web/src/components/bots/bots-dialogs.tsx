/**
 * The create dialog and the profile drawer, driven by the Bots store so the
 * sidebar, the Bots page and Settings → My Bots all open the same things.
 * Mounted wherever Bots are managed: a dialog left open when the member
 * navigated away must not reappear on the next visit (the store outlives the
 * page), so the drawer is reset on unmount.
 */

import { useCallback, useEffect } from 'react';
import type { BotView } from '@greenhouse/types/bots';
import * as botsApi from '../../lib/api/bots';
import { BotProfileDrawer } from './bot-profile-drawer';
import { NewBotDialog } from './new-bot-dialog';
import { useBotsStore } from './bots-store';
import { openBotsConversation } from './navigation';

export function BotsDialogs({
  threadsEnabled,
  onInvited,
}: {
  /** Whether this member has Bots threads (the `bots` flag): groups and DMs exist only then. */
  threadsEnabled: boolean;
  onInvited?: () => void;
}) {
  const dialog = useBotsStore((state) => state.dialog);
  const openDialog = useBotsStore((state) => state.openDialog);
  const openProfile = useBotsStore((state) => state.openProfile);
  const loadConversations = useBotsStore((state) => state.loadConversations);

  useEffect(() => () => openProfile(null), [openProfile]);

  const openDm = useCallback(
    async (bot: BotView) => {
      openProfile(null);
      if (bot.dm_session_id) {
        openBotsConversation(bot.dm_session_id);
        return;
      }
      const { conversation: dm } = await botsApi.createConversation({ bot_ids: [bot.id] });
      openBotsConversation(dm.session_id);
    },
    [openProfile],
  );

  return (
    <>
      <BotProfileDrawer onOpenDm={(bot) => void openDm(bot).catch(() => {})} />
      <NewBotDialog
        open={dialog?.kind === 'new-bot' || dialog?.kind === 'new-group'}
        initialTab={dialog?.kind === 'new-group' ? 'group' : 'bot'}
        groupEnabled={threadsEnabled}
        inviteTo={dialog?.kind === 'new-bot' ? dialog.inviteTo : undefined}
        onClose={() => openDialog(null)}
        onCreated={({ dmSessionId, invitedTo, inviteFailed }) => {
          openDialog(null);
          if (threadsEnabled) void loadConversations().catch(() => {});
          // Created from Invite: stay in the group either way (a failed join
          // was explained by the dialog); otherwise meet the new Bot.
          if (invitedTo || inviteFailed) onInvited?.();
          else if (dmSessionId && threadsEnabled) openBotsConversation(dmSessionId);
        }}
        onGroupCreated={(created) => {
          openDialog(null);
          void loadConversations().catch(() => {});
          openBotsConversation(created.session_id);
        }}
      />
    </>
  );
}
