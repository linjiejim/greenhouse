/**
 * Invite an existing Bot into a conversation, or create a new one for it.
 * In a DM the invitee joins as a guest — it speaks when @-mentioned or asked,
 * and the DM stays the owner Bot's thread.
 */

import { useState } from 'react';
import type { BotConversationDetail } from '@greenhouse/types/bots';
import { Button, Dialog, toast } from '../ui';
import { Plus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import * as botsApi from '../../lib/api/bots';
import { useBotsStore } from './bots-store';
import { BotAvatar } from './bot-avatar';

const MAX_MEMBERS = 6;

export function InviteDialog({
  conversation,
  onClose,
  onChanged,
  onCreateNew,
}: {
  conversation: BotConversationDetail | null;
  onClose: () => void;
  onChanged: (conversation: BotConversationDetail) => void;
  onCreateNew: () => void;
}) {
  const t = useT();
  const bots = useBotsStore((state) => state.bots);
  const [adding, setAdding] = useState<string | null>(null);
  const memberIds = new Set(conversation?.members.map((member) => member.bot_id) ?? []);
  const candidates = bots.filter((bot) => !memberIds.has(bot.id));
  const full = memberIds.size >= MAX_MEMBERS;

  const add = async (botId: string, name: string) => {
    if (!conversation) return;
    setAdding(botId);
    try {
      const { conversation: next } = await botsApi.addConversationMember(conversation.session_id, botId);
      onChanged(next);
      toast(t('bots.invite.added', { name }), 'success');
      onClose();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.invite.failed'), 'error');
    } finally {
      setAdding(null);
    }
  };

  return (
    <Dialog open={conversation !== null} onClose={onClose} title={t('bots.invite.title')} size="md">
      <div className="space-y-3" data-testid="bots-invite-dialog">
        <p className="text-sm text-fg-muted">
          {conversation?.kind === 'group' ? t('bots.invite.hintGroup') : t('bots.invite.hint')}
        </p>
        {full ? (
          <p className="text-sm text-fg-faint">{t('bots.invite.full')}</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-fg-faint">{t('bots.invite.noneLeft')}</p>
        ) : (
          <ul className="space-y-1">
            {candidates.map((bot) => (
              <li key={bot.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-muted">
                <BotAvatar bot={bot} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{bot.name}</span>
                  {bot.role && <span className="block truncate text-[11px] text-fg-faint">{bot.role}</span>}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={adding !== null}
                  onClick={() => void add(bot.id, bot.name)}
                >
                  {t('bots.invite.add')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!full && (
          <Button variant="ghost" size="sm" onClick={onCreateNew}>
            <Plus size={13} className="mr-1" />
            {t('bots.invite.createNew')}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
