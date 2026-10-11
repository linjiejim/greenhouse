/**
 * @-mentions in Markdown — the one wire format every comment surface shares:
 * `[@Name](user:<id>)` (knowledge-base comments, Tables record comments).
 *
 * The id is the truth; the name is only what the writer saw when they picked
 * the person, so readers resolve the id again and never trust the label. Zero
 * dependencies — the web composer and the API notifier both import it.
 */

const MENTION_TARGET = /\(user:([^)]+)\)/g;
const MENTION_LINK = /\[@([^\]]*)\]\(user:([^)\s]+)\)/g;
/** Characters that would end the link label or the link early. */
const LABEL_BREAKERS = /[[\]()\r\n]/g;

/** Mentioned user ids from `[@nickname](user:<id>)` links, first occurrence order, no duplicates. */
export function extractMentionIds(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(MENTION_TARGET)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The Markdown for one mention. The label is cleaned so a nickname cannot break out of the link. */
export function mentionMarkdown(name: string, userId: string): string {
  const label = name.replace(LABEL_BREAKERS, '').trim() || userId;
  return `[@${label}](user:${userId})`;
}

/** A comment as plain text (notification bodies, previews): every mention link becomes `@Name`. */
export function mentionsToPlainText(markdown: string): string {
  return markdown.replace(MENTION_LINK, (_link, label: string) => `@${label}`);
}

export interface MentionLink {
  /** Offset of the link in the Markdown. */
  index: number;
  /** The whole `[@Name](user:id)` text. */
  text: string;
  name: string;
  userId: string;
}

/** Every well-formed mention link, in order (for editors that turn links back into `@Name` tokens). */
export function findMentionLinks(markdown: string): MentionLink[] {
  return [...markdown.matchAll(MENTION_LINK)].map((match) => ({
    index: match.index ?? 0,
    text: match[0],
    name: match[1] ?? '',
    userId: match[2] ?? '',
  }));
}
