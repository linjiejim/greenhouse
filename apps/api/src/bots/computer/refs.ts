/**
 * Which computer an Agent uses (spec 20261011-agent-first-class P3a): its own — the main
 * computer (id = the member's id) for Sprouty, `<userId>.<botId>` for any other. The pure
 * id rules live in namespace.ts; this module reads the Bot when only its id is at hand.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import { computerRef, computerRefForBot, type ComputerRef } from './namespace.js';

/**
 * The computer `botId` uses for this member (null = the member's main computer): their own Bot's,
 * or — someone else's public Agent (P4) — the member's own copy of it (`<member>.<bot>`).
 */
export async function computerForBot(db: DatabaseProvider, userId: string, botId: string | null): Promise<ComputerRef> {
  if (!botId) return computerRef(userId, null);
  const bot = (await db.bots.getBot(userId, botId)) ?? (await db.bots.getBotById(botId));
  return bot ? computerRefForBot(userId, bot) : computerRef(userId, null);
}
