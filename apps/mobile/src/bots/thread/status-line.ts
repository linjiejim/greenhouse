/**
 * What a Bots thread is doing right now, as the member would say it — the
 * second line of the title view ("Browsing github.com", "Waiting for your
 * approval"; nothing when idle) and the pose of the avatar beside it.
 * Pure and React-free (tested in ./status-line.test.ts).
 *
 * A rewrite of the web's `useStatusLine`
 * (apps/web/src/components/bots/conversation-header.tsx — a pinned-text
 * tripwire in ../vendor/vendor.parity.test.ts goes red when it changes), with
 * what the phone adds on top (spec §2.5.3 a), highest first:
 *
 *   read-only (an old group chat — groups are retired and kept as closed
 *     records — a DM whose Bot was archived, or a DM with someone else's
 *     public Agent that is no longer offered)
 *   > the newest pending card (approval / sign-in / hand the computer back /
 *     human check / anything else: "your go-ahead")
 *   > a stop on its way ("Stopping after this step…" / "Stopping…")
 *   > the segment being typed out: a running tool call (browsing {host} /
 *     the computer / handing off / working), else replying (text on screen)
 *     or thinking — named when a guest is speaking
 *   > busy without a segment (between turns, another API slot): "Working…"
 *   > idle: no line at all — the title alone (the role lives in the
 *     profile, one tap away); a task chat's title is its own, so its line
 *     says who answers there ("Chat with Sage" — the web's header too); a DM
 *     with someone else's public Agent says whose it is ("by Jim" — the web
 *     adds the role, the phone keeps that in the profile).
 *
 * "Busy" only ever comes from real signals (`snap.runActive` — D14); the web
 * header's computer-phase branch ("you're in control") has no phone
 * equivalent (no computer view in v1).
 */

import type { TranslationKey } from '../../lib/i18n';
import type { BotRequestView, BotView } from '../../shared/bots';
import { sharedOwnerOf, sharedReadOnly, type SharedBots } from '../public-agents';
import type { BotStreamSegment } from '../../shared/bots-wire';
import type { PlantState } from '../../ui/plant-avatar/plant-ids';
import type { BotsReadOnly, ThreadSnapshot } from '../contract';
import { speakingSegment } from '../vendor/transcript';
import { hostFromInput, humanCheckTakeover, implicitTakeover } from '../vendor/web-helpers';

export interface StatusLine {
  key: TranslationKey;
  vars?: Record<string, string | number>;
}

export interface StatusInput {
  snap: Pick<ThreadSnapshot, 'conversation' | 'readOnly' | 'requests' | 'stopPhase' | 'run' | 'runActive' | 'runError'>;
  /** The full directory (active and archived Bots). */
  byId: Record<string, BotView>;
  /** A task chat reads like a DM: its Agent speaks under the title, guests are named. */
  kind: 'direct' | 'task' | 'group';
  /** Other members' public Agents in the member's DMs (P4): one no longer offered turns its DM read-only. */
  shared?: SharedBots;
}

/**
 * Why nobody here can reply, or null. The server's answer to a send (`snap.readOnly`)
 * wins; otherwise the directory decides — but only for Bots it knows: an id it has
 * not heard of yet is "not loaded", never "archived". Someone else's public Agent
 * (`shared`) that is no longer offered: `agent_unavailable`.
 */
export function threadReadOnly(
  snap: Pick<ThreadSnapshot, 'conversation' | 'readOnly'>,
  byId: Record<string, BotView>,
  shared?: SharedBots,
): BotsReadOnly | null {
  // A group chat is a closed record (group chats were retired), whoever is in it.
  if (snap.conversation?.kind === 'group') return 'group_closed';
  if (snap.readOnly) return snap.readOnly;
  const conversation = snap.conversation;
  if (!conversation) return null;
  const unavailable = sharedReadOnly(conversation, shared);
  if (unavailable) return unavailable;
  const owner = conversation.owner_bot_id ? byId[conversation.owner_bot_id] : undefined;
  return owner && owner.status !== 'active' ? 'bot_archived' : null;
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

/** The status line of a thread nobody can reply in. */
const READ_ONLY_STATUS = {
  group_closed: 'bots.status.groupClosed',
  bot_archived: 'bots.status.archived',
  agent_unavailable: 'bots.status.unavailable',
} as const satisfies Record<BotsReadOnly, TranslationKey>;

export function statusLine({ snap, byId, kind, shared }: StatusInput): StatusLine | null {
  const readOnly = threadReadOnly(snap, byId, shared);
  if (readOnly) return { key: READ_ONLY_STATUS[readOnly] ?? 'bots.status.archived' };

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
    // A DM's (or task chat's) owner speaks under its own title; anyone else (a group, a guest) is named.
    const name = byId[segment.botId]?.name;
    const named = !!name && (kind === 'group' || segment.botId !== conversation?.owner_bot_id);
    if (named) return { key: replying ? 'bots.status.replying' : 'bots.status.thinking', vars: { name } };
    return { key: replying ? 'bots.status.replyingDm' : 'bots.status.thinkingDm' };
  }

  if (snap.runActive) return { key: 'bots.status.working' };
  const owner = conversation?.owner_bot_id ? byId[conversation.owner_bot_id] : undefined;
  if (kind === 'task' && owner) return { key: 'bots.status.taskWith', vars: { name: owner.name } };
  const publishedBy = kind === 'direct' ? sharedOwnerOf(conversation, shared)?.owner.nickname : undefined;
  if (publishedBy) return { key: 'bots.status.sharedBy', vars: { name: publishedBy } };
  return null;
}

/**
 * The title avatar's pose (its face and motion), by the same priority:
 * archived → asleep, a card waiting → waiting, a Bot typing → speaking, a Bot
 * (or the run) at work without words yet → thinking, a run that failed →
 * error (until the next one), else idle. The screen adds a brief `done` smile
 * when a reply finishes (`cheerPose`).
 */
export function titlePose({ snap, byId, shared }: StatusInput): PlantState {
  if (threadReadOnly(snap, byId, shared)) return 'sleep';
  if (latestPending(snap.requests)) return 'waiting';
  const segment = talkingSegment(snap.run);
  if (segment) return segment.text.length > 0 ? 'speaking' : 'thinking';
  if (snap.runActive) return 'thinking';
  return snap.runError ? 'error' : 'idle';
}

/** How long the title smiles after a reply. */
export const CHEER_MS = 2400;

/** The `done` smile replaces only the idle pose: anything with something to say keeps its own. */
export function cheerPose(pose: PlantState, cheering: boolean): PlantState {
  return cheering && pose === 'idle' ? 'done' : pose;
}
