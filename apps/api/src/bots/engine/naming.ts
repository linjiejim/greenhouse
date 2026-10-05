/**
 * Bot identity rules, shared by the HTTP routes and the `team.create` tool.
 *
 * A Bot's name doubles as a speaker tag in every other Bot's context
 * (`[小研（Bot）]:`), so the rules are a security boundary, not cosmetics: no
 * brackets or colons (a name must not be able to close or forge a tag), no
 * reserved words (用户/系统/事件/…), never the member's own nickname. Unique
 * among the member's active Bots (case and full/half width folded) — the DB
 * enforces that part.
 */

import { BOT_INSTRUCTIONS_MAX, BOT_NAME_MAX, BOT_RESERVED_NAMES, BOT_ROLE_MAX } from '@greenhouse/types/bots';
import { botNameKey } from '@greenhouse/db';

export type BotFieldError = { ok: false; code: 'bot_name_invalid'; error: string };

/** Tag delimiters and any control character (line breaks included). */
const FORBIDDEN = /[[\]:：]|\p{Cc}/u;
const RESERVED = new Set(BOT_RESERVED_NAMES.map((word) => botNameKey(word)));

export function validateBotName(raw: unknown, nickname: string): { ok: true; name: string } | BotFieldError {
  if (typeof raw !== 'string') return { ok: false, code: 'bot_name_invalid', error: 'A Bot needs a name' };
  const name = raw.normalize('NFC').trim();
  const length = [...name].length;
  if (length === 0) return { ok: false, code: 'bot_name_invalid', error: 'A Bot needs a name' };
  if (length > BOT_NAME_MAX) {
    return { ok: false, code: 'bot_name_invalid', error: `A Bot name has at most ${BOT_NAME_MAX} characters` };
  }
  // NFKC folds full-width look-alikes (［ ］ ：) onto the ASCII delimiters first.
  if (FORBIDDEN.test(name.normalize('NFKC'))) {
    return { ok: false, code: 'bot_name_invalid', error: 'A Bot name cannot contain [ ] : ： or line breaks' };
  }
  const key = botNameKey(name);
  if (RESERVED.has(key)) return { ok: false, code: 'bot_name_invalid', error: `“${name}” is reserved` };
  if (nickname && key === botNameKey(nickname)) {
    return { ok: false, code: 'bot_name_invalid', error: 'A Bot cannot have your own name' };
  }
  return { ok: true, name };
}

export function validateBotRole(raw: unknown): { ok: true; role: string } | BotFieldError {
  if (raw === undefined || raw === null) return { ok: true, role: '' };
  if (typeof raw !== 'string') return { ok: false, code: 'bot_name_invalid', error: 'role must be text' };
  const role = raw.replace(/[\r\n]+/g, ' ').trim();
  if ([...role].length > BOT_ROLE_MAX) {
    return { ok: false, code: 'bot_name_invalid', error: `A role has at most ${BOT_ROLE_MAX} characters` };
  }
  return { ok: true, role };
}

export function validateBotInstructions(raw: unknown): { ok: true; instructions: string } | BotFieldError {
  if (raw === undefined || raw === null) return { ok: true, instructions: '' };
  if (typeof raw !== 'string') return { ok: false, code: 'bot_name_invalid', error: 'instructions must be text' };
  const instructions = raw.trim();
  if (instructions.length > BOT_INSTRUCTIONS_MAX) {
    return {
      ok: false,
      code: 'bot_name_invalid',
      error: `Instructions have at most ${BOT_INSTRUCTIONS_MAX} characters`,
    };
  }
  return { ok: true, instructions };
}

/** First free "<base>", "<base> 2", "<base> 3"… among taken name keys (template copies). */
export function nextFreeName(base: string, takenKeys: ReadonlySet<string>): string {
  if (!takenKeys.has(botNameKey(base))) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} ${n}`;
    if (!takenKeys.has(botNameKey(candidate)) && [...candidate].length <= BOT_NAME_MAX) return candidate;
  }
  return base;
}
