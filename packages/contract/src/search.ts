import { z } from 'zod';

/** What `⌘K` searches; an item's `kind` is the group it belongs to. */
export const SEARCH_KINDS = ['conversations', 'messages', 'agents', 'members'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  /** Comma separated, in the order to show them; every kind when left out. */
  kinds: z
    .string()
    .optional()
    .transform((value) => (value ? [...new Set(value.split(',').map((kind) => kind.trim()))] : [...SEARCH_KINDS]))
    .pipe(z.array(z.enum(SEARCH_KINDS)).min(1)),
  /** At most this many items of each kind. */
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type SearchQuery = z.input<typeof searchQuerySchema>;

export const searchItemSchema = z.object({
  kind: z.enum(SEARCH_KINDS),
  id: z.string(),
  /** A conversation's title (or its Agent's name), an Agent's or a member's name. */
  title: z.string(),
  /** The text around a match in a message, an Agent's role, a member's email. */
  snippet: z.string().optional(),
  /** Where a conversation or message opens. */
  conversation_id: z.string().optional(),
  /** The message's place in its conversation. */
  seq: z.number().int().optional(),
  /** The Agent of a conversation, or the one that wrote a message. */
  agent_id: z.string().optional(),
});
export type SearchItem = z.infer<typeof searchItemSchema>;

export const searchResultSchema = z.object({ items: z.array(searchItemSchema) });
export type SearchResult = z.infer<typeof searchResultSchema>;
