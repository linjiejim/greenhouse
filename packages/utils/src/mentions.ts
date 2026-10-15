/** Resolve exact, unique @ names. The caller supplies only candidates the member may address. */

export interface MentionCandidate {
  id: string;
  name: string;
}

/** Punctuation that ends an `@Name` token (ASCII + CJK). */
const TOKEN_END = /^$|^[\s,.;:!?，。；：！？、)）\]】"'”’]/;
/** Mention ids in text order. Longer names claim a position before their prefixes. */
export function parseMentions(text: string, candidates: readonly MentionCandidate[]): string[] {
  const names = [...new Set(candidates.map((candidate) => candidate.name))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const hits: Array<{ index: number; id: string }> = [];
  for (let index = text.indexOf('@'); index !== -1; index = text.indexOf('@', index + 1)) {
    if (index > 0 && !/\s|[(（[【"“'‘]/.test(text[index - 1]!)) continue;
    const rest = text.slice(index + 1);
    const name = names.find((name) => rest.startsWith(name) && TOKEN_END.test(rest.slice(name.length)));
    if (!name) continue;
    const same = candidates.filter((candidate) => candidate.name === name);
    if (same.length === 1) hits.push({ index, id: same[0]!.id });
  }
  return [...new Set(hits.map((hit) => hit.id))];
}

/** Composer insertion for a picked member: the visible `@Name ` token. */
export function mentionToken(name: string): string {
  return `@${name} `;
}

/** An explicit but stale/unknown @ target still makes a message directed. Ignore email addresses. */
export function hasExplicitMention(text: string): boolean {
  return /(?:^|[\s(（[【"“'‘])@[^\s@,.;:!?，。；：！？、)）\]】"'”’]+/u.test(text);
}
