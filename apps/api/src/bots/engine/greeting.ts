/**
 * A Bot's first words — a fixed, server-written greeting (no model call).
 *
 * Written when a Bot's DM is created (bootstrap, "New Bot", a confirmed
 * proposal). One or two sentences: hello, the Bot's role, its one-line pitch.
 * No capability list and no closing question — the client shows the
 * template's starters (chips) right under it. It must be instant and must
 * never promise what this deployment cannot do, so a computer-bound template
 * without a ready computer opens with its `pitchNoComputer`.
 *
 * Stored greetings are never rewritten: a wording change here only affects
 * Bots created from now on.
 */

import type { BotRow, DatabaseProvider } from '@greenhouse/db';
import { botTemplate } from '@greenhouse/types/bots';
import type { MessageRow } from '@greenhouse/types/session';
import { getComputerRuntime } from '../computer/index.js';
import { botsLocale, type BotsLocale } from './copy.js';

export interface GreetingFacts {
  locale: BotsLocale;
  /** A Bot computer is ready on this deployment right now. */
  computerReady: boolean;
}

export function buildGreeting(bot: Pick<BotRow, 'name' | 'role' | 'template_key'>, facts: GreetingFacts): string {
  const template = botTemplate(bot.template_key);
  const copy = template?.copy[facts.locale];
  // A computer-bound template without a computer opens with what it CAN do here.
  const pitch = ((template?.needsComputer && !facts.computerReady ? copy?.pitchNoComputer : copy?.pitch) ?? '').trim();
  const role = bot.role.trim();
  const hello =
    facts.locale === 'zh'
      ? `你好，我是 **${bot.name}**${role ? `，你的${role}` : ''}。`
      : `Hi, I'm **${bot.name}**${role ? `, your ${role.toLowerCase()}` : ''}.`;
  return pitch ? `${hello}${facts.locale === 'zh' ? '' : ' '}${pitch}` : hello;
}

export async function greetingFacts(db: DatabaseProvider, userId: string): Promise<GreetingFacts> {
  const user = await db.users.getById(userId);
  return { locale: botsLocale(user?.locale), computerReady: getComputerRuntime().state === 'ready' };
}

/** Append the greeting as the Bot's first DM message (idempotent per Bot). */
export async function writeGreeting(
  db: DatabaseProvider,
  dmSessionId: string,
  bot: Pick<BotRow, 'id' | 'name' | 'role' | 'template_key' | 'user_id'>,
  facts?: GreetingFacts,
): Promise<MessageRow> {
  const resolved = facts ?? (await greetingFacts(db, bot.user_id));
  return db.sessions.addMessageOnce(`bot-greeting:${bot.id}`, {
    session_id: dmSessionId,
    role: 'assistant',
    content: buildGreeting(bot, resolved),
    bot_id: bot.id,
    bot_event: JSON.stringify({ kind: 'greeting', bot_id: bot.id }),
  });
}
