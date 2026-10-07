// VENDORED from apps/web/src/components/bots/bot-name.ts — verbatim below the imports (apps/mobile
// cannot import the web app; see apps/mobile/AGENTS.md). Only the import path differs. Do not edit
// here: change the canonical file, re-copy it, and run src/bots/vendor/vendor.parity.test.ts.

/**
 * Bot name rules on the client — the same rules the API enforces
 * (apps/api/src/bots/AGENTS.md → HTTP contract), checked while typing so the member
 * learns them before pressing Create. The server stays authoritative.
 *
 * Why these rules: a Bot's name is a speaker tag in every other Bot's
 * transcript (`[Sage（Bot）]: …`) and the handle the member types after `@`.
 * Brackets and colons would forge speaker tags; reserved words and the
 * member's own nickname would impersonate the member or the system.
 */

import { BOT_NAME_MAX, BOT_RESERVED_NAMES } from '../../shared/bots';

export type BotNameIssue = 'required' | 'too_long' | 'chars' | 'reserved' | 'is_you' | 'taken';

const FORBIDDEN = /[[\]:：\r\n]/;

function fold(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function validateBotName(
  raw: string,
  context: { otherNames: readonly string[]; nickname?: string | null },
): BotNameIssue | null {
  const name = raw.trim();
  if (!name) return 'required';
  if ([...name].length > BOT_NAME_MAX) return 'too_long';
  if (FORBIDDEN.test(name)) return 'chars';
  const folded = fold(name);
  if ((BOT_RESERVED_NAMES as readonly string[]).some((reserved) => fold(reserved) === folded)) return 'reserved';
  if (context.nickname && fold(context.nickname) === folded) return 'is_you';
  if (context.otherNames.some((other) => fold(other) === folded)) return 'taken';
  return null;
}

/** API error code → the same issue vocabulary, so server refusals read like client ones. */
export function botNameIssueFromCode(code: string | null): BotNameIssue | 'limit' | null {
  if (code === 'bot_name_taken') return 'taken';
  if (code === 'bot_name_invalid') return 'chars';
  if (code === 'bot_limit') return 'limit';
  return null;
}
