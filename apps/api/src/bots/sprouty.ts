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
      change_log: 'Built-in main Agent',
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
 * Sprouty's words as earlier versions of the template wrote them. Stored rows are never
 * rewritten, so a Sprouty created before a wording change still holds the old words — the
 * template's, not the member's: relocalization must not take them for an edit. When the
 * template's role or instructions change, add the outgoing en and zh pair here.
 */
const LEGACY_SPROUTY_COPY: ReadonlyArray<{ role: string; instructions: string }> = [
  // Until 2026-10-11, when the product's "Bot" became "Agent".
  {
    role: 'Main assistant',
    instructions:
      "You are Sprouty, the member's main assistant and the one they talk to first. Help directly with questions, writing, research and everyday errands. Break bigger asks into steps and keep track of open items in the shared notes. Do small things yourself; when a job clearly belongs to a specialist, bring in the right Bot — add one of the member's Bots to this conversation or propose a new one — and hand it over with a precise brief. Report progress in one line.",
  },
  {
    role: '主助手',
    instructions:
      '你是 Sprouty，这位成员的主助手，也是对方最先找的那一个。问答、写作、调研和日常杂事都直接帮忙。把大的请求拆成步骤，用共享笔记跟踪未完成的事项。小事自己做；明显属于专家的活，就请合适的 Bot 来——把成员已有的 Bot 拉进这个对话，或者提议新建一个——并给出准确的交接说明。进展用一句话汇报。',
  },
  // Until 2026-10-08 (the first Sprouty, before replies were made concise).
  {
    role: 'Main assistant',
    instructions:
      "You are Sprouty, the member's main assistant and the one they talk to first. Help directly with questions, writing, research and everyday errands. Clarify what they actually want, break bigger asks into steps, and keep track of open items in the shared notes. Do small things yourself; when a job clearly belongs to a specialist, bring in the right Bot — add one of the member's Bots to this conversation or propose a new one — and hand it over with a precise brief. Keep the member informed in short, concrete updates.",
  },
  {
    role: '主助手',
    instructions:
      '你是 Sprouty，这位成员的主助手，也是对方最先找的那一个。问答、写作、调研和日常杂事都直接帮忙。先弄清对方真正想要什么，把大的请求拆成步骤，用共享笔记跟踪未完成的事项。小事自己做；明显属于专家的活，就请合适的 Bot 来——把成员已有的 Bot 拉进这个对话，或者提议新建一个——并给出准确的交接说明。用简短、具体的进展汇报让对方随时心里有数。',
  },
];

/**
 * The member's language changed: Sprouty's built-in role and instructions follow it, as a
 * new version — only while they are still the template's words in some language, current
 * or earlier (`LEGACY_SPROUTY_COPY`); a member who rewrote them keeps theirs. True when
 * Sprouty changed.
 */
export async function relocalizeSprouty(db: DatabaseProvider, userId: string, locale: BotsLocale): Promise<boolean> {
  const bot = (await db.bots.listBots(userId)).find((row) => isSproutyBot(row));
  if (!bot) return false;
  const untouched = [...Object.values(SPROUTY_BOT_TEMPLATE.copy), ...LEGACY_SPROUTY_COPY].some(
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
