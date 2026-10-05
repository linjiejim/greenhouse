/**
 * Conversation info — everything about a conversation that is not the talk
 * itself: what the Bots remember of it (the rolling summary, verbatim), the
 * group's name/rules/lead, who is here, the shared notes, and — tucked under
 * "Advanced" — how close the next summary is. No percentage chip in the
 * header: context management is our job, not the member's.
 */

import { useEffect, useState } from 'react';
import type { BotConversationDetail, BotMemberRole, BotView } from '@greenhouse/types/bots';
import { Button, ConfirmDialog, IconButton, Input, Select, Spinner, Tag, Textarea, Toggle, toast } from '../ui';
import { ChevronDown, ChevronRight, LogOut, RefreshCw } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { timeAgo, formatTokens } from '../../lib/utils';
import { RichMarkdown } from '../rich-markdown';
import * as botsApi from '../../lib/api/bots';
import { BotAvatar } from './bot-avatar';
import { PanelSection } from './bots-side-panel';
import { SharedNotes } from './shared-notes';
import type { BotLookup } from './transcript-rows';

const ROLE_KEY: Record<BotMemberRole, TranslationKey> = {
  owner: 'bots.roleOwner',
  lead: 'bots.roleLead',
  member: 'bots.roleMember',
  guest: 'bots.roleGuest',
};

export function InfoPanel({
  conversation,
  onConversationChange,
  members,
  lookup,
  busy,
  onOpenProfile,
}: {
  conversation: BotConversationDetail;
  onConversationChange: (next: BotConversationDetail) => void;
  members: BotView[];
  lookup: BotLookup;
  /** A run is streaming (summarizing now would 409). */
  busy: boolean;
  onOpenProfile: (botId: string) => void;
}) {
  const t = useT();
  const sessionId = conversation.session_id;
  const isGroup = conversation.kind === 'group';
  const [title, setTitle] = useState(conversation.title ?? '');
  const [rules, setRules] = useState(conversation.description);
  const [saving, setSaving] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [removing, setRemoving] = useState<BotView | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    setTitle(conversation.title ?? '');
    setRules(conversation.description);
  }, [conversation.session_id, conversation.title, conversation.description]);

  const patch = async (change: Parameters<typeof botsApi.updateConversation>[1]) => {
    setSaving(true);
    try {
      const { conversation: next } = await botsApi.updateConversation(sessionId, change);
      onConversationChange(next);
      return true;
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.info.saveFailed'), 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

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
    try {
      const { conversation: next } = await botsApi.removeConversationMember(sessionId, bot.id);
      onConversationChange(next);
      toast(t('bots.info.removed', { name: bot.name }), 'success');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.info.saveFailed'), 'error');
    }
  };

  const rulesDirty = rules !== conversation.description || (isGroup && title !== (conversation.title ?? ''));
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

      {isGroup && (
        <PanelSection title={t('bots.info.rules')} hint={t('bots.info.rulesHint')}>
          <div className="space-y-2">
            <Input
              size="sm"
              value={title}
              maxLength={80}
              aria-label={t('bots.info.groupName')}
              placeholder={t('bots.info.groupName')}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
              value={rules}
              maxLength={2000}
              rows={4}
              aria-label={t('bots.info.rules')}
              placeholder={t('bots.info.rulesPlaceholder')}
              onChange={(event) => setRules(event.target.value)}
            />
            {rulesDirty && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() =>
                    void patch({ title: title.trim(), description: rules }).then(
                      (ok) => ok && toast(t('bots.info.saved'), 'success'),
                    )
                  }
                >
                  {t('bots.info.save')}
                </Button>
              </div>
            )}
          </div>
        </PanelSection>
      )}

      <PanelSection title={t('bots.info.members')}>
        {isGroup && (
          <div className="mb-3 space-y-1">
            <label className="block text-[11px] font-medium text-fg-secondary" htmlFor={`lead-${sessionId}`}>
              {t('bots.info.lead')}
            </label>
            <Select
              id={`lead-${sessionId}`}
              size="sm"
              value={members.some((bot) => bot.id === conversation.lead_bot_id) ? (conversation.lead_bot_id ?? '') : ''}
              disabled={saving}
              onChange={(event) => {
                if (event.target.value) void patch({ lead_bot_id: event.target.value });
              }}
            >
              {/* No (active) lead — e.g. it was archived: say so instead of letting the
                  browser show the first member as if it led, which would also make
                  picking that member a no-op. */}
              {!members.some((bot) => bot.id === conversation.lead_bot_id) && (
                <option value="" disabled>
                  {t('bots.info.noLead')}
                </option>
              )}
              {members.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </Select>
            <p className="text-[10px] text-fg-faint">{t('bots.info.leadHint')}</p>
          </div>
        )}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium text-fg-secondary">{t('bots.info.allowBotChat')}</p>
            <p className="text-[10px] text-fg-faint">{t('bots.info.allowBotChatHint')}</p>
          </div>
          <Toggle
            size="sm"
            checked={conversation.allow_bot_chat}
            disabled={saving}
            label={t('bots.info.allowBotChat')}
            onChange={(checked) => void patch({ allow_bot_chat: checked })}
          />
        </div>
        <ul className="space-y-0.5">
          {conversation.members.map((member) => {
            const bot = lookup(member.bot_id);
            const removable = isGroup
              ? conversation.members.length > 2 && member.bot_id !== conversation.lead_bot_id
              : member.role === 'guest';
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
    </div>
  );
}
