/**
 * Who a member message addresses.
 *
 * Two ways to call on a Bot, both plain text so the transcript reads the same
 * later: `@Name` anywhere, or opening the message with the name and a comma /
 * colon ("Fern, tighten this" · "小文：润色一下"). The server re-validates the
 * ids against the member list; this only turns what the member typed into ids.
 */

export interface MentionCandidate {
  id: string;
  name: string;
}

/** Punctuation that ends an `@Name` token (ASCII + CJK). */
const TOKEN_END = /^$|^[\s,.;:!?，。；：！？、)）\]】"'”’]/;
/** Separators that turn a leading name into an address. */
const LEADING_SEPARATOR = /^\s*[,，:：]/;

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/** Mentioned Bot ids, in the order they first appear, without duplicates. */
export function parseMentions(text: string, members: readonly MentionCandidate[]): string[] {
  if (!text || members.length === 0) return [];
  // Longest names first so "Sage" never shadows "Sage Two".
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const hits: Array<{ index: number; id: string }> = [];

  const leading = text.replace(/^\s+/, '');
  const offset = text.length - leading.length;
  for (const member of byLength) {
    const head = leading.slice(0, member.name.length);
    if (head && sameName(head, member.name) && LEADING_SEPARATOR.test(leading.slice(member.name.length))) {
      hits.push({ index: offset, id: member.id });
      break;
    }
  }

  for (let index = text.indexOf('@'); index !== -1; index = text.indexOf('@', index + 1)) {
    // `a@b` is an e-mail address, not a mention.
    if (index > 0 && !/\s|[(（[【"“'‘]/.test(text[index - 1])) continue;
    const rest = text.slice(index + 1);
    const member = byLength.find(
      (candidate) =>
        sameName(rest.slice(0, candidate.name.length), candidate.name) &&
        TOKEN_END.test(rest.slice(candidate.name.length)),
    );
    if (member) hits.push({ index, id: member.id });
  }

  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.index - b.index)
    .flatMap((hit) => {
      if (seen.has(hit.id)) return [];
      seen.add(hit.id);
      return [hit.id];
    });
}

/** Composer insertion for a picked member: the visible `@Name ` token. */
export function mentionToken(name: string): string {
  return `@${name} `;
}
