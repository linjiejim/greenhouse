/**
 * Bots conversation header: who is here (only the speaking Bot animates),
 * what they are doing right now in one line, and the three doors — invite,
 * the computer (with a live state dot) and conversation info.
 *
 * The Bots page has no TopBar (an immersive workspace like Chat), so on
 * phones this row also carries the navigation drawer button.
 */

import type { BotConversationDetail, BotRequestView, BotView } from '@greenhouse/types/bots';
import { IconButton, StatusDot } from '../ui';
import { Info, Menu, Monitor, UserPlus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { useUIStore } from '../../stores';
import type { BotStreamSegment } from '../../lib/session-manager';
import { BotAvatar, BotAvatarStack } from './bot-avatar';
import { ComputerStatusDot, phaseLabelKey, type ComputerPhase } from './computer-phase';
import { implicitTakeover } from './request-decision';

/** What the conversation is doing, as the member would say it. */
export function useStatusLine({
  conversation,
  members,
  speaking,
  pendingRequests,
  computerPhase = null,
  readOnly = false,
}: {
  conversation: BotConversationDetail;
  members: BotView[];
  speaking: BotStreamSegment | null;
  pendingRequests: BotRequestView[];
  /** A take-over the member already took reads "you're in control", not "waiting for you". */
  computerPhase?: ComputerPhase | null;
  /** Nobody here can reply any more (archived). */
  readOnly?: boolean;
}): { text: string; tone: 'idle' | 'active' | 'waiting' } {
  const t = useT();
  if (readOnly) return { text: t('bots.header.readOnly'), tone: 'idle' };
  const latestPending = pendingRequests[pendingRequests.length - 1];
  if (latestPending?.kind === 'takeover' && computerPhase?.kind === 'running' && computerPhase.controller === 'user') {
    return { text: t('bots.header.inControl'), tone: 'active' };
  }
  if (latestPending) {
    // A take-over the computer raised itself waits for a hand-back, not for the member to take over.
    const implicit = latestPending.kind === 'takeover' && implicitTakeover(latestPending.payload) !== null;
    const key = implicit
      ? 'bots.header.waitingContinue'
      : latestPending.kind === 'login'
        ? 'bots.header.waitingLogin'
        : latestPending.kind === 'approval'
          ? 'bots.header.waitingApproval'
          : latestPending.kind === 'takeover'
            ? 'bots.header.waitingTakeover'
            : 'bots.header.waitingConfirm';
    return { text: t(key), tone: 'waiting' };
  }
  if (speaking) {
    const name = members.find((bot) => bot.id === speaking.botId)?.name ?? t('bots.deletedBot');
    const calling = [...speaking.toolCalls].reverse().find((call) => call.status === 'calling');
    if (calling) {
      if (calling.name === 'browser') {
        const host = hostFromInput(calling.input);
        return {
          text: host ? t('bots.header.browsing', { name, host }) : t('bots.header.usingComputer', { name }),
          tone: 'active',
        };
      }
      if (calling.name === 'computer') return { text: t('bots.header.usingComputer', { name }), tone: 'active' };
      if (calling.name === 'team') return { text: t('bots.header.handingOff', { name }), tone: 'active' };
      return { text: t('bots.header.working', { name }), tone: 'active' };
    }
    return {
      text: speaking.text ? t('bots.header.replying', { name }) : t('bots.header.thinking', { name }),
      tone: 'active',
    };
  }
  if (conversation.kind === 'group') {
    const lead = members.find((bot) => bot.id === conversation.lead_bot_id);
    const count = t('bots.header.botCount', { count: members.length });
    return { text: lead ? `${count} · ${t('bots.header.lead', { name: lead.name })}` : count, tone: 'idle' };
  }
  const owner = members.find((bot) => bot.id === conversation.owner_bot_id);
  return { text: owner?.role || t('bots.header.idle'), tone: 'idle' };
}

function hostFromInput(input: string): string | null {
  // Tool input streams in as partial JSON; only a complete `url` is worth showing.
  const match = /"url"\s*:\s*"([^"]+)"/.exec(input);
  if (!match) return null;
  try {
    return new URL(match[1]).host || null;
  } catch {
    return null;
  }
}

/**
 * The phone's way to the navigation drawer on the Bots page. The TopBar is
 * hidden on `#/bots` at every width, so every Bots screen — loading, failed,
 * not found, no access — must carry this itself or a phone (and the installed
 * PWA, which has no back button) is stuck there.
 */
export function BotsMobileNavButton() {
  const t = useT();
  const setNavOpen = useUIStore((state) => state.setNavOpen);
  return (
    <IconButton onClick={() => setNavOpen(true)} label={t('navigation.mobile')} wrapperClassName="md:hidden">
      <Menu size={20} />
    </IconButton>
  );
}

/** Phone-only header for Bots screens that have no conversation to head (loading, errors, no access). */
export function BotsBareHeader({ title }: { title: string }) {
  return (
    <header
      className="flex min-h-12 flex-shrink-0 items-center gap-2 border-b border-edge bg-surface-raised px-2 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] md:hidden"
      data-testid="bots-bare-header"
    >
      <BotsMobileNavButton />
      <h2 className="truncate text-sm font-semibold text-fg">{title}</h2>
    </header>
  );
}

export function ConversationHeader({
  title,
  conversation,
  owner,
  members,
  speakingId,
  status,
  computerPhase,
  activePane,
  canInvite,
  onInvite,
  onOpenComputer,
  onOpenInfo,
  onOpenProfile,
}: {
  title: string;
  conversation: BotConversationDetail;
  /** A DM's Bot (from the full directory, so an archived one keeps its face). */
  owner: BotView | undefined;
  members: BotView[];
  speakingId: string | null;
  status: { text: string; tone: 'idle' | 'active' | 'waiting' };
  /** The computer UI's own phase (useComputerStatus) — one vocabulary for the dot and the pane. */
  computerPhase: ComputerPhase | null;
  activePane: 'info' | 'computer' | null;
  canInvite: boolean;
  onInvite: () => void;
  onOpenComputer: () => void;
  onOpenInfo: () => void;
  /** The DM's Bot face + name open its profile; a group's open the info panel (members, rules). */
  onOpenProfile: (botId: string) => void;
}) {
  const t = useT();
  const isDm = conversation.kind === 'direct';
  const openIdentity = () => (isDm && owner ? onOpenProfile(owner.id) : onOpenInfo());
  const identityLabel = isDm && owner ? t('bots.profile.open', { name: owner.name }) : t('bots.header.info');
  const computerLabel = computerPhase
    ? `${t('bots.header.computer')} · ${t(phaseLabelKey(computerPhase))}`
    : t('bots.header.computer');
  return (
    <header
      className="flex min-h-12 flex-shrink-0 items-center gap-2 border-b border-edge bg-surface-raised px-2 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] md:px-4 md:py-1.5"
      data-testid="bots-conversation-header"
    >
      <BotsMobileNavButton />
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <button
          type="button"
          onClick={openIdentity}
          aria-label={identityLabel}
          className="flex-shrink-0 rounded-full transition-opacity hover:opacity-80"
        >
          {isDm && owner ? (
            <BotAvatar bot={owner} size="sm" speaking={speakingId === owner.id} />
          ) : (
            <BotAvatarStack bots={members} max={4} size="xs" speakingId={speakingId} />
          )}
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg" title={title}>
            <button
              type="button"
              onClick={openIdentity}
              aria-label={identityLabel}
              className="max-w-full truncate rounded text-left hover:underline"
            >
              {title}
            </button>
          </h2>
          <p
            className={`flex items-center gap-1.5 truncate text-[11px] ${
              status.tone === 'waiting'
                ? 'text-warning'
                : status.tone === 'active'
                  ? 'text-primary-fg-strong'
                  : 'text-fg-faint'
            }`}
            title={status.text}
            data-testid="bots-status-line"
          >
            {status.tone !== 'idle' && (
              <StatusDot color={status.tone === 'waiting' ? 'warning' : 'primary'} size="sm" pulse />
            )}
            <span className="truncate">{status.text}</span>
          </p>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-0.5">
        {canInvite && (
          <IconButton label={t('bots.header.invite')} onClick={onInvite}>
            <UserPlus size={16} />
          </IconButton>
        )}
        <IconButton
          label={computerLabel}
          onClick={onOpenComputer}
          className={activePane === 'computer' ? 'bg-surface-muted text-fg' : ''}
          aria-pressed={activePane === 'computer'}
          data-testid="bots-computer-button"
        >
          <span className="relative inline-flex">
            <Monitor size={16} />
            {computerPhase && (
              <ComputerStatusDot
                phase={computerPhase}
                className="absolute -bottom-0.5 -right-0.5 ring-2 ring-surface-raised"
              />
            )}
          </span>
        </IconButton>
        <IconButton
          label={t('bots.header.info')}
          onClick={onOpenInfo}
          className={activePane === 'info' ? 'bg-surface-muted text-fg' : ''}
          aria-pressed={activePane === 'info'}
          data-testid="bots-info-button"
        >
          <Info size={16} />
        </IconButton>
      </div>
    </header>
  );
}
