/**
 * The comment composer's mention model. The textarea shows readable `@Name`
 * tokens; what is sent and stored is Markdown with `[@Name](user:<id>)` links
 * (`@greenhouse/utils/mentions`, the format the server parses and notifies
 * from). A token becomes a link only when the writer picked that person from
 * the list — typing "@Ann" by hand stays plain text, so nobody is mentioned
 * by accident or by a lookalike name.
 */

import { findMentionLinks, mentionMarkdown } from '@greenhouse/utils/mentions';

export interface PickedMention {
  id: string;
  name: string;
}

export interface MentionCandidateUser {
  id: string;
  nickname: string;
  email: string;
}

/** Punctuation (ASCII + CJK) or whitespace that ends an `@Name` token. */
const TOKEN_END = /^$|^[\s,.;:!?，。；：！？、)）\]】"'”’]/;
/** Characters of an e-mail's local part: `@` right after one is an address (`mail@Ann`), not a mention. */
const ADDRESS_CHAR = /[A-Za-z0-9._%+-]/;

/** Stored Markdown → the composer's text and the people its tokens stand for (editing a comment). */
export function commentToDraft(markdown: string): { text: string; picked: PickedMention[] } {
  const picked = new Map<string, PickedMention>();
  let text = '';
  let offset = 0;
  for (const link of findMentionLinks(markdown)) {
    text += `${markdown.slice(offset, link.index)}@${link.name}`;
    offset = link.index + link.text.length;
    if (!picked.has(link.userId)) picked.set(link.userId, { id: link.userId, name: link.name });
  }
  return { text: text + markdown.slice(offset), picked: [...picked.values()] };
}

/** Composer text → Markdown: every `@Name` of a picked person becomes a mention link. */
export function draftToComment(text: string, picked: readonly PickedMention[]): string {
  if (picked.length === 0) return text;
  // Longest names first so "Ann" never shadows "Ann Lee".
  const byLength = [...picked].sort((left, right) => right.name.length - left.name.length);
  let out = '';
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at === -1) break;
    out += text.slice(index, at);
    const startsToken = at === 0 || !ADDRESS_CHAR.test(text[at - 1] ?? '');
    const rest = text.slice(at + 1);
    const person = startsToken
      ? byLength.find(
          (candidate) => rest.startsWith(candidate.name) && TOKEN_END.test(rest.slice(candidate.name.length)),
        )
      : undefined;
    if (person) {
      out += mentionMarkdown(person.name, person.id);
      index = at + 1 + person.name.length;
    } else {
      out += '@';
      index = at + 1;
    }
  }
  return out + text.slice(index);
}

/** The people the `@` list offers for `query` (nickname or e-mail, case-insensitive), best matches first. */
export function mentionCandidates(
  users: readonly MentionCandidateUser[],
  query: string,
  limit = 8,
): MentionCandidateUser[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return users.slice(0, limit);
  const scored = users.flatMap((user) => {
    const name = user.nickname.toLocaleLowerCase();
    const email = user.email.toLocaleLowerCase();
    if (name.startsWith(q)) return [{ user, score: 0 }];
    if (name.includes(q)) return [{ user, score: 1 }];
    if (email.includes(q)) return [{ user, score: 2 }];
    return [];
  });
  return scored
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map((entry) => entry.user);
}
