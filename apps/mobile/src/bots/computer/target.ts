/**
 * Which computer — one per Agent (spec docs/specs/20261011-agent-first-class.md P3a,
 * D28–D30; server routes apps/api/src/bots/computer/routes.ts). The member's main
 * Agent (Sprouty) has the computer every member had before 2026-10-12; any other
 * Agent has its own. The app names a computer by its Agent, as the routes do
 * (`?bot=`): null = the main Agent's.
 *
 * Pure (root vitest: ./target.test.ts). Same rules as the web's
 * `computerBotFor` / `computerEventMatches` in
 * apps/web/src/components/bots/computer-phase.tsx — a hand port, not a copy.
 */

import { isSproutyBot, type BotRequestView, type BotView, type ComputerStatusView } from '../../shared/bots';

/** The Agent whose computer it is, as the routes name it: null = the main Agent (Sprouty). */
export type ComputerBot = string | null;

type Lookup = (id: string) => Pick<BotView, 'template_key'> | undefined;

/**
 * The computer an Agent works on: null for the main Agent and for no Agent at all,
 * the Agent's own id otherwise. An id the directory does not know (yet) is kept —
 * the server maps Sprouty's id to the main computer either way.
 */
export function computerBotFor(botId: string | null | undefined, lookup: Lookup): ComputerBot {
  if (!botId) return null;
  const bot = lookup(botId);
  return bot && isSproutyBot(bot) ? null : botId;
}

/** The Agent whose computer `bot` names — the main Agent for null; null while the list is not in. */
export function computerAgent(
  s: { bots: readonly BotView[]; byId: Readonly<Record<string, BotView | undefined>> },
  bot: ComputerBot,
): BotView | null {
  return bot ? (s.byId[bot] ?? null) : (s.bots.find(isSproutyBot) ?? null);
}

/** A conversation's computer: its owner Agent's (a task chat's or a DM's; none = the main one). */
export function conversationComputer(
  conversation: { owner_bot_id: string | null } | null | undefined,
  lookup: Lookup,
): ComputerBot {
  return computerBotFor(conversation?.owner_bot_id, lookup);
}

/** A card's computer (sign-in, take-over, human check): the Agent that raised it. */
export function cardComputer(request: Pick<BotRequestView, 'bot_id'>, lookup: Lookup): ComputerBot {
  return computerBotFor(request.bot_id, lookup);
}

type Named = Partial<Pick<ComputerStatusView, 'computer_id' | 'bot_id'>>;

/**
 * Does a `bots:computer` push concern the computer `bot` names? Pushes name their
 * computer (`computer_id` / `bot_id`, null = the main one). Once the view knows
 * its own `computer_id` (`known`, the last status read), that is the exact match;
 * before, the Agent is. Older servers sent neither and had one computer only —
 * the main one, which is what they answered for whatever was asked.
 */
export function computerEventMatches(event: Named, bot: ComputerBot, known: Named | null): boolean {
  if (event.computer_id === undefined && event.bot_id === undefined) {
    return bot === null || (known != null && (known.bot_id ?? null) === null);
  }
  if (event.computer_id && known?.computer_id) return event.computer_id === known.computer_id;
  return (event.bot_id ?? null) === bot;
}

/**
 * Is a status view (a read, an action's answer) about the computer `bot` names?
 * Views from older servers carry no Agent; the main computer comes back as null
 * even when asked for by Sprouty's own id (before the directory said who Sprouty is).
 */
export function viewMatches(view: Named, bot: ComputerBot): boolean {
  return view.bot_id === undefined || view.bot_id === null || view.bot_id === bot;
}

/**
 * The thread bar's 🖥 tint: the computer's state at a glance (the web's status dot) —
 * in the member's hands, running for its Agent, failed, or nothing to say (asleep,
 * starting…: the plain icon).
 */
export function computerButtonTone(
  phase: { kind: string; controller?: 'bot' | 'user' } | null,
): 'accent' | 'green' | 'red' | null {
  if (!phase) return null;
  if (phase.kind === 'running') return phase.controller === 'user' ? 'accent' : 'green';
  if (phase.kind === 'error') return 'red';
  return null;
}
