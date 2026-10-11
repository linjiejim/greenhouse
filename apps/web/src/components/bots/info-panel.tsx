/**
 * Conversation info — everything about a conversation that is not the talk
 * itself: what the Bots remember of it (the rolling summary, verbatim), who is
 * here (the DM's Bot and the guests it — or the member — brought in; a guest
 * can be sent away), the shared notes, and — tucked under "Advanced" — how
 * close the next summary is. No percentage chip in the header: context
 * management is our job, not the member's. Nothing to configure: Bots hand
 * work to each other whenever it helps, and a retired group chat lists who was
 * in it, read-only. A room (P5) lists its people first (its owner may remove
 * someone) and each Agent with whose it is (the member may take out their own,
 * or any as the room's owner).
 */

import { useState } from 'react';
import type { BotConversationDetail, BotMemberRole, BotView } from '@greenhouse/types/bots';
import { Button, ConfirmDialog, IconButton, Spinner, Tag, toast } from '../ui';
import { ChevronDown, ChevronRight, LogOut, RefreshCw } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { timeAgo, formatTokens } from '../../lib/utils';
import { RichMarkdown } from '../rich-markdown';
import * as botsApi from '../../lib/api/bots';
import { BotAvatar } from './bot-avatar';
import { PanelSection } from './bots-side-panel';
import { PersonAvatar } from './person-avatar';
import { roomErrorMessage } from './room-dialogs';
import { SharedNotes } from './shared-notes';
import type { BotLookup } from './transcript-rows';
import type { RoomView } from './use-room';

const ROLE_KEY: Record<BotMemberRole, TranslationKey> = {
  owner: 'bots.roleOwner',
  lead: 'bots.roleLead',
  member: 'bots.roleMember',
  guest: 'bots.roleGuest',
};

export function InfoPanel({
  conversation,
  onConversationChange,
  lookup,
  busy,
  onOpenProfile,
  room,
  onStale,
}: {
  conversation: BotConversationDetail;
  onConversationChange: (next: BotConversationDetail) => void;
  lookup: BotLookup;
  /** A run is streaming (summarizing now would 409). */
  busy: boolean;
  onOpenProfile: (botId: string) => void;
  /** A room (P5): its people and Agents as the member sees them. */
  room?: RoomView | null;
  /** Something changed that only a re-read shows (someone or an Agent taken out of a room). */
  onStale?: () => void;
}) {
  const t = useT();
  const sessionId = conversation.session_id;
  const [compacting, setCompacting] = useState(false);
  const [removing, setRemoving] = useState<BotView | null>(null);
  const [removingPerson, setRemovingPerson] = useState<{ id: string; name: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const compact = async () => {
    setCompacting(true);
    try {
      const { digest } = await botsApi.compactConversation(sessionId);
      onConversationChange({ ...conversation, digest });
      toast(t('bots.info.tidyDone'), 'success');
    } catch (err) {
      toast(
        err instanceof botsApi.BotsApiError && err.status === 409 ? t('bots.info.tidyBusy') : t('bots.info.tidyFailed'),
        'error',
      );
    } finally {
      setCompacting(false);
    }
  };

  const confirmRemove = async () => {
    const bot = removing;
    setRemoving(null);
    if (!bot) return;
    if (room) {
      try {
        await botsApi.removeRoomAgent(sessionId, bot.id);
        onStale?.();
        toast(t('bots.info.removed', { name: bot.name }), 'success');
      } catch (err) {
        toast(roomErrorMessage(err, t, 'bots.room.errors.removeFailed'), 'error');
      }
      return;
    }
    try {
      const { conversation: next } = await botsApi.removeConversationMember(sessionId, bot.id);
      onConversationChange(next);
      toast(t('bots.info.removed', { name: bot.name }), 'success');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.info.saveFailed'), 'error');
    }
  };

  const confirmRemovePerson = async () => {
    const person = removingPerson;
    setRemovingPerson(null);
    if (!person) return;
    try {
      await botsApi.removeRoomPerson(sessionId, person.id);
      onStale?.();
      toast(t('bots.room.personRemoved', { name: person.name }), 'success');
    } catch (err) {
      toast(roomErrorMessage(err, t, 'bots.room.errors.removePersonFailed'), 'error');
    }
  };

  const { estimated_tokens: used, threshold } = conversation.context;
  const usage = threshold > 0 ? Math.min(1, used / threshold) : 0;

  return (
    <div data-testid="bots-info-panel">
      <PanelSection
        title={t('bots.info.remembers')}
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || compacting}
            onClick={() => void compact()}
            title={busy ? t('bots.info.tidyBusy') : undefined}
          >
            {compacting ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw size={12} className="mr-1" />}
            {t('bots.info.tidyUp')}
          </Button>
        }
      >
        {conversation.digest?.text ? (
          <div className="space-y-1">
            <div className="max-h-72 overflow-y-auto rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-xs">
              <RichMarkdown content={conversation.digest.text} compact linkTarget="new-window" />
            </div>
            {conversation.digest.updated_at && (
              <p className="text-[10px] text-fg-faint">
                {t('bots.info.updated', { time: timeAgo(conversation.digest.updated_at) })}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-fg-faint">{t('bots.info.remembersEmpty')}</p>
        )}
      </PanelSection>

      {room && (
        <PanelSection title={t('bots.room.people')}>
          <ul className="space-y-0.5" data-testid="room-info-people">
            {room.participants.map((person) => {
              const isMe = person.user_id === room.me;
              return (
                <li
                  key={person.user_id}
                  className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-muted"
                  data-testid="room-info-person"
                >
                  <PersonAvatar name={person.nickname} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                    {isMe ? t('bots.room.youName', { name: person.nickname }) : person.nickname}
                  </span>
                  {person.role === 'owner' && <Tag tone="primary">{t('bots.roleOwner')}</Tag>}
                  {room.isOwner && !isMe && (
                    <IconButton
                      size="compact"
                      variant="destructive"
                      label={t('bots.room.removePerson', { name: person.nickname })}
                      onClick={() => setRemovingPerson({ id: person.user_id, name: person.nickname })}
                      wrapperClassName="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 touch-visible"
                    >
                      <LogOut size={13} />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        </PanelSection>
      )}

      {room ? (
        <PanelSection title={t('bots.room.agentsHere')}>
          {room.agents.length === 0 ? (
            <p className="text-xs text-fg-faint">{t('bots.room.noAgentsHere')}</p>
          ) : (
            <ul className="space-y-0.5" data-testid="room-info-agents">
              {room.agents.map((agent) => (
                <li
                  key={agent.bot.id}
                  className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-muted"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => onOpenProfile(agent.bot.id)}
                    title={t('bots.info.viewProfile')}
                  >
                    <BotAvatar bot={agent.bot} size="xs" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-fg">{agent.bot.name}</span>
                      <span className="block truncate text-[10px] text-fg-faint">
                        {agent.mine
                          ? t('bots.room.yours')
                          : t('bots.room.ownedBy', { name: room.personName(agent.member.owner_user_id) })}
                      </span>
                    </span>
                  </button>
                  {agent.removable && (
                    <IconButton
                      size="compact"
                      variant="destructive"
                      label={t('bots.info.remove')}
                      onClick={() => setRemoving(agent.bot)}
                      wrapperClassName="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 touch-visible"
                    >
                      <LogOut size={13} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      ) : (
        <PanelSection title={t('bots.info.members')}>
          <ul className="space-y-0.5">
            {conversation.members.map((member) => {
              const bot = lookup(member.bot_id);
              // Only a DM has guests, and only a guest can be sent away (the DM's own Bot cannot).
              const removable = member.role === 'guest';
              return (
                <li
                  key={member.bot_id}
                  className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-muted"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => onOpenProfile(member.bot_id)}
                    title={t('bots.info.viewProfile')}
                  >
                    <BotAvatar bot={bot} size="xs" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-fg">
                        {bot?.name ?? t('bots.deletedBot')}
                      </span>
                      {bot?.role && <span className="block truncate text-[10px] text-fg-faint">{bot.role}</span>}
                    </span>
                  </button>
                  {bot?.status === 'archived' ? (
                    // Still a member on paper, but it no longer replies.
                    <Tag tone="neutral">{t('bots.sidebar.archived')}</Tag>
                  ) : (
                    <Tag tone={member.role === 'guest' ? 'neutral' : 'primary'}>{t(ROLE_KEY[member.role])}</Tag>
                  )}
                  {removable && bot && (
                    <IconButton
                      size="compact"
                      variant="destructive"
                      label={t('bots.info.remove')}
                      onClick={() => setRemoving(bot)}
                      wrapperClassName="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 touch-visible"
                    >
                      <LogOut size={13} />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        </PanelSection>
      )}

      <PanelSection title={t('bots.info.notes')} hint={t('bots.info.notesHint')}>
        <SharedNotes sessionId={sessionId} initial={conversation.notes} lookup={lookup} />
      </PanelSection>

      <section className="px-4 py-3">
        <button
          type="button"
          onClick={() => setAdvanced((value) => !value)}
          aria-expanded={advanced}
          className="flex items-center gap-1 text-[11px] font-medium text-fg-muted hover:text-fg-secondary"
        >
          {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {t('bots.info.advanced')}
        </button>
        {advanced && (
          <div className="mt-2 space-y-1.5">
            <p className="text-[11px] font-medium text-fg-secondary">{t('bots.info.context')}</p>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={threshold}
              aria-valuenow={used}
            >
              <div className="h-full rounded-full bg-primary-500" style={{ width: `${Math.round(usage * 100)}%` }} />
            </div>
            <p className="text-[10px] text-fg-faint">
              {t('bots.info.contextUsage', { used: formatTokens(used), threshold: formatTokens(threshold) })}
            </p>
            <p className="text-[10px] text-fg-faint">{t('bots.info.contextHint')}</p>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
        title={t('bots.info.removeConfirm', { name: removing?.name ?? '' })}
        confirmLabel={t('bots.info.remove')}
        confirmVariant="destructive"
      />
      <ConfirmDialog
        open={removingPerson !== null}
        onClose={() => setRemovingPerson(null)}
        onConfirm={() => void confirmRemovePerson()}
        title={t('bots.room.removePersonConfirm', { name: removingPerson?.name ?? '' })}
        description={t('bots.room.removePersonDescription')}
        confirmLabel={t('bots.room.removePersonShort')}
        confirmVariant="destructive"
      />
    </div>
  );
}
