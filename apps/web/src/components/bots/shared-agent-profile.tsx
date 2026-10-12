/**
 * Someone else's public Agent in the profile drawer (spec 20261011-agent-first-class P4): only its
 * public face — who it is, whose it is, whether it still answers — and the way into the member's own
 * conversation with it. No instructions, tools, memories, files, versions or usage: those are its
 * owner's (D35).
 */

import type { SharedBotView } from '@greenhouse/types/bots';
import { Button, IconButton, Tag, toast } from '../ui';
import { MessageCircle, X } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { openPublicAgent } from '../../lib/api/bots';
import { BotAvatar } from './bot-avatar';
import { PanelSection } from './bots-side-panel';
import { openBotsConversation } from './navigation';
import { useBotsStore } from './bots-store';

export function SharedAgentProfile({ bot, onClose }: { bot: SharedBotView; onClose: () => void }) {
  const t = useT();
  const loadBots = useBotsStore((state) => state.loadBots);
  const loadConversations = useBotsStore((state) => state.loadConversations);

  const message = async () => {
    try {
      const sessionId = bot.dm_session_id ?? (await openPublicAgent(bot.id)).conversation_id;
      if (!bot.dm_session_id) {
        void loadBots().catch(() => {});
        void loadConversations().catch(() => {});
      }
      onClose();
      openBotsConversation(sessionId);
    } catch {
      toast(t('bots.directory.openFailed'), 'error');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-shared-profile">
      <div className="flex items-start gap-3 border-b border-edge px-4 py-4">
        <BotAvatar bot={bot} size="lg" state={bot.available ? 'idle' : 'sleep'} />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-base font-semibold text-fg" title={bot.name}>
            {bot.name}
          </h2>
          {bot.role && <p className="truncate text-xs text-fg-muted">{bot.role}</p>}
          <p className="mt-1 truncate text-[11px] text-fg-faint" title={bot.owner.nickname}>
            {t('bots.shared.profileBy', { name: bot.owner.nickname })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {bot.available ? (
              <Button size="sm" onClick={() => void message()} data-testid="bots-shared-profile-message">
                <MessageCircle size={13} className="mr-1" />
                {t('bots.profile.message')}
              </Button>
            ) : (
              <Tag tone="warning">{t('bots.shared.profileUnavailable')}</Tag>
            )}
          </div>
        </div>
        <IconButton label={t('common.close')} onClick={onClose} size="compact">
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {bot.description && (
          <PanelSection title={t('bots.profile.description')}>
            <p className="text-xs leading-5 text-fg-secondary">{bot.description}</p>
          </PanelSection>
        )}
        <div className="px-4 py-4">
          <p className="text-[11px] leading-4 text-fg-faint">{t('bots.shared.profileHint')}</p>
        </div>
      </div>
    </div>
  );
}
