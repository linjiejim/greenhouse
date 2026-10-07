/**
 * What a Bots thread is doing right now, as the member would say it — the
 * second line of the title view ("Browsing github.com", "Waiting for your
 * approval", the Bot's role when idle) and the pose of the avatar beside it.
 * Pure and React-free (tested in ./status-line.test.ts).
 *
 * A rewrite of the web's `useStatusLine`
 * (apps/web/src/components/bots/conversation-header.tsx — a pinned-text
 * tripwire in ../vendor/vendor.parity.test.ts goes red when it changes), with
 * what the phone adds on top (spec §2.5.3 a), highest first:
 *
 *   read-only (archived DM / no one left to reply)
 *   > the newest pending card (approval / sign-in / hand the computer back /
 *     human check / anything else: "your go-ahead")
 *   > a stop on its way ("Stopping after this step…" / "Stopping…")
 *   > the segment being typed out: a running tool call (browsing {host} /
 *     the computer / handing off / working), else replying (text on screen)
 *     or thinking — named in a group, and in a DM when a guest is speaking
 *   > busy without a segment (between turns, another API slot): "Working…"
 *   > idle: a DM shows the Bot's role, a group its size and lead.
 *
 * "Busy" only ever comes from real signals (`snap.runActive` — D14); the web
 * header's computer-phase branch ("you're in control") has no phone
 * equivalent (no computer view in v1).
 */

import type { TranslationKey } from '../../lib/i18n';
import type { BotConversationDetail, BotRequestView, BotView } from '../../shared/bots';
import type { BotStreamSegment } from '../../shared/bots-wire';
import type { PlantState } from '../../ui/plant-avatar/plant-ids';
import type { ThreadSnapshot } from '../contract';
import { speakingSegment } from '../vendor/transcript';
import { hostFromInput, humanCheckTakeover, implicitTakeover } from '../vendor/web-helpers';

export interface StatusLine {
  key: TranslationKey;
  vars?: Record<string, string | number>;
}

export interface StatusInput {
  snap: Pick<ThreadSnapshot, 'conversation' | 'readOnly' | 'requests' | 'stopPhase' | 'run' | 'runActive'>;
  /** The full directory (active and archived Bots). */
  byId: Record<string, BotView>;
  kind: 'direct' | 'group';
}

/**
 * Why nobody here can reply, or null. The server's answer to a send (`snap.readOnly`)
 * wins; otherwise the directory decides — but only for Bots it knows: an id it has
 * not heard of yet is "not loaded", never "archived".
 */
export function threadReadOnly(
  snap: Pick<ThreadSnapshot, 'conversation' | 'readOnly'>,
  byId: Record<string, BotView>,
): 'bot_archived' | 'no_active_members' | null {
  if (snap.readOnly) return snap.readOnly;
  const conversation = snap.conversation;
  if (!conversation) return null;
  if (conversation.kind === 'direct') {
    const owner = conversation.owner_bot_id ? byId[conversation.owner_bot_id] : undefined;
    return owner && owner.status !== 'active' ? 'bot_archived' : null;
  }
  const known = conversation.members.map((member) => byId[member.bot_id]);
  if (known.length === 0 || known.some((bot) => !bot)) return null;
  return known.some((bot) => bot?.status === 'active') ? null : 'no_active_members';
}

/** The newest card still waiting for the member. */
export function latestPending(requests: ReadonlyMap<string, BotRequestView>): BotRequestView | null {
  let latest: BotRequestView | null = null;
  for (const request of requests.values()) {
    if (request.status !== 'pending') continue;
    if (!latest || Date.parse(request.created_at) >= Date.parse(latest.created_at)) latest = request;
  }
  return latest;
}

/**
 * The segment on screen as "the one talking": the one being typed out (the reveal
 * front — later segments still read as thinking), else the last one streaming.
 */
export function talkingSegment(run: ThreadSnapshot['run']): BotStreamSegment | null {
  if (!run) return null;
  const typing = run.revealing >= 0 ? run.segments[run.revealing] : undefined;
  return typing ?? speakingSegment(run.segments);
}

function waitingKey(request: BotRequestView): TranslationKey {
  if (request.kind === 'approval') return 'bots.status.waitApproval';
  if (request.kind === 'login') return 'bots.status.waitLogin';
  if (request.kind === 'takeover') {
    if (implicitTakeover(request.payload)) return 'bots.status.waitHandback';
    if (humanCheckTakeover(request.payload)) return 'bots.status.waitHuman';
  }
  return 'bots.status.waitConfirm';
}

function activeMembers(conversation: BotConversationDetail, byId: Record<string, BotView>): number {
  const known = conversation.members.filter((member) => byId[member.bot_id]);
  // Before the directory answers, every member counts.
  if (known.length === 0) return conversation.members.length;
  return known.filter((member) => byId[member.bot_id]?.status === 'active').length;
}

export function statusLine({ snap, byId, kind }: StatusInput): StatusLine {
  const readOnly = threadReadOnly(snap, byId);
  if (readOnly) return { key: readOnly === 'bot_archived' ? 'bots.status.archived' : 'bots.status.noReplier' };

  const pending = latestPending(snap.requests);
  if (pending) return { key: waitingKey(pending) };

  if (snap.stopPhase === 'hard') return { key: 'bots.status.stoppingNow' };
  if (snap.stopPhase === 'soft' || snap.run?.interrupting) return { key: 'bots.status.stopping' };

  const conversation = snap.conversation;
  const segment = talkingSegment(snap.run);
  if (segment) {
    const calling = [...segment.toolCalls].reverse().find((call) => call.status === 'calling');
    if (calling) {
      if (calling.name === 'browser') {
        const host = hostFromInput(calling.input);
        return host ? { key: 'bots.status.browsing', vars: { host } } : { key: 'bots.status.computer' };
      }
      if (calling.name === 'computer') return { key: 'bots.status.computer' };
      if (calling.name === 'team') return { key: 'bots.status.handoff' };
      return { key: 'bots.status.working' };
    }
    const replying = segment.text.length > 0;
    // A DM's owner speaks under its own title; anyone else (a group, a DM guest) is named.
    const name = byId[segment.botId]?.name;
    const named = !!name && (kind === 'group' || segment.botId !== conversation?.owner_bot_id);
    if (named) return { key: replying ? 'bots.status.replying' : 'bots.status.thinking', vars: { name } };
    return { key: replying ? 'bots.status.replyingDm' : 'bots.status.thinkingDm' };
  }

  if (snap.runActive) return { key: 'bots.status.working' };

  if (!conversation) return { key: 'bots.status.idle' };
  if (kind === 'group') {
    const n = activeMembers(conversation, byId);
    const lead = conversation.lead_bot_id ? byId[conversation.lead_bot_id] : undefined;
    return lead
      ? { key: 'bots.status.group', vars: { n, name: lead.name } }
      : { key: 'bots.status.groupCount', vars: { n } };
  }
  const owner = conversation.owner_bot_id ? byId[conversation.owner_bot_id] : undefined;
  return owner?.role.trim()
    ? { key: 'bots.status.role', vars: { role: owner.role.trim() } }
    : { key: 'bots.status.idle' };
}

/**
 * The title avatar's pose, by the same priority: archived → asleep, a card
 * waiting → waiting, a Bot typing → speaking, a Bot (or the run) at work
 * without words yet → thinking (the only pose that moves), else idle.
 */
export function titlePose({ snap, byId }: StatusInput): PlantState {
  if (threadReadOnly(snap, byId)) return 'sleep';
  if (latestPending(snap.requests)) return 'waiting';
  const segment = talkingSegment(snap.run);
  if (segment) return segment.text.length > 0 ? 'speaking' : 'thinking';
  // Busy with nothing to show (another API slot, between turns): a still pose, not a fake "typing".
  return snap.runActive ? 'speaking' : 'idle';
}
