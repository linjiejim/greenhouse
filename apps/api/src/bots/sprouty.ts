/**
 * Sprouty — every member's built-in main Bot, as an identity.
 *
 * The Bot row is the one source of "who is Sprouty for this member": the Chat
 * page's default identity, the Bots page's pinned conversation and every
 * headless run that resolves `sprouty` for a known user all read it. The row
 * is created on first use by whichever surface gets there first; the Bots
 * page additionally creates its DM and greeting (`POST /api/bots/bootstrap`).
 */

import { BotsDomainError, botNameKey, type BotRow, type DatabaseProvider } from '@greenhouse/db';
import { SPROUTY_BOT_TEMPLATE, isSproutyBot } from '@greenhouse/types/bots';
import { botsLocale, type BotsLocale } from './engine/copy.js';
import { nextFreeName } from './engine/naming.js';

/** The member's Sprouty Bot, created from the template when missing. Idempotent and race-safe. */
export async function ensureSproutyBot(db: DatabaseProvider, userId: string): Promise<BotRow> {
  const find = async () => (await db.bots.listBots(userId)).find((bot) => isSproutyBot(bot));
  const existing = await find();
  if (existing) return existing;

  const user = await db.users.getById(userId);
  const locale = botsLocale(user?.locale);
  const copy = SPROUTY_BOT_TEMPLATE.copy[locale];
  const active = await db.bots.listBots(userId);
  const taken = new Set(
    [...active.map((bot) => bot.name_key), user?.nickname ? botNameKey(user.nickname) : ''].filter(Boolean),
  );
  try {
    return await db.bots.createBot({
      user_id: userId,
      name: nextFreeName(copy.name, taken),
      role: copy.role,
      instructions: copy.instructions,
      avatar: JSON.stringify(SPROUTY_BOT_TEMPLATE.avatar),
      template_key: SPROUTY_BOT_TEMPLATE.key,
      builtIn: true,
      change_log: 'Built-in main Bot',
    });
  } catch (error) {
    // A concurrent visit created it: return that one.
    if (!(error instanceof BotsDomainError)) throw error;
    const raced = await find();
    if (!raced) throw error;
    return raced;
  }
}

/**
 * The member's language changed: Sprouty's built-in role and instructions follow it, as a
 * new version — only while they are still the template's words in some language (a member
 * who rewrote them keeps theirs). True when Sprouty changed.
 */
export async function relocalizeSprouty(db: DatabaseProvider, userId: string, locale: BotsLocale): Promise<boolean> {
  const bot = (await db.bots.listBots(userId)).find((row) => isSproutyBot(row));
  if (!bot) return false;
  const untouched = Object.values(SPROUTY_BOT_TEMPLATE.copy).some(
    (copy) => copy.role === bot.role && copy.instructions === bot.instructions,
  );
  const target = SPROUTY_BOT_TEMPLATE.copy[locale];
  if (!untouched || (bot.role === target.role && bot.instructions === target.instructions)) return false;
  const updated = await db.bots.updateBot(userId, bot.id, {
    role: target.role,
    instructions: target.instructions,
    change_log: `Language: ${locale}`,
  });
  return !!updated;
}
