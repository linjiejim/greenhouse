/**
 * "Hand to Agent" on a project task, as pure rules (root vitest: ./agent-handoff.test.ts).
 * Spec docs/specs/20261011-agent-first-class.md P3e / D32: handing a task to one of the
 * member's Agents opens a task chat whose first message is the task; the task records the
 * Agent and the chat (`agent_id`, `agent_session_id`) while the assignee stays responsible.
 */

import type { TranslationKey } from '../lib/i18n';
import { isSproutyBot, type BotView } from '../shared/bots';
import type { ProjectTask } from '../shared/greenhouse-types';

/** The Agents a task can go to: the active ones, the main Agent (Sprouty) first. */
export function handoffAgents(bots: readonly BotView[]): BotView[] {
  const active = bots.filter((bot) => bot.status === 'active');
  return [...active.filter(isSproutyBot), ...active.filter((bot) => !isSproutyBot(bot))];
}

/**
 * Who works on the task, as this member sees it — null when it was never handed. `name` is
 * null for an Agent that is not this member's (another member handed it: Agents are private)
 * or not loaded yet; only the member's own Agent's chat can be opened (`sessionId`).
 */
export function taskAgent(
  task: Pick<ProjectTask, 'agent_id' | 'agent_session_id'>,
  byId: Readonly<Record<string, Pick<BotView, 'name'> | undefined>>,
): { name: string | null; sessionId: string | null } | null {
  if (!task.agent_id) return null;
  const mine = byId[task.agent_id];
  return { name: mine?.name ?? null, sessionId: mine ? (task.agent_session_id ?? null) : null };
}

/** Why the hand-off was refused, in the member's words (the alert's message); null = say only the title. */
export function handoffErrorKey(status: number): TranslationKey | null {
  if (status === 403) return 'projects.handOff';
  if (status === 404) return 'projects.handGone';
  return null;
}
