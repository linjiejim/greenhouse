/**
 * Where a reply's facts came from (CONV-19). A source a tool read (a fetched page) always shows
 * under the reply; one a tool only listed (a search result) shows when the reply links to it.
 */

import type { MessageCitation } from '@greenhouse/db';

const MAX_CITATIONS = 8;

export type CiteHow = 'read' | 'seen';

export function createSources() {
  const read = new Map<string, MessageCitation>();
  const seen = new Map<string, MessageCitation>();
  const keyOf = (source: MessageCitation) => source.url ?? `${source.kind}:${source.id}`;
  return {
    cite(source: MessageCitation, how: CiteHow) {
      const key = keyOf(source);
      if (how === 'read') {
        read.set(key, source);
        seen.delete(key);
      } else if (!read.has(key)) {
        seen.set(key, source);
      }
    },
    /** What was read, then the listed sources the reply links to (a trailing slash does not matter). */
    citations(text: string): MessageCitation[] {
      const linked = [...seen.values()].filter(
        (source) => source.url && (text.includes(source.url) || text.includes(source.url.replace(/\/$/, ''))),
      );
      return [...read.values(), ...linked].slice(0, MAX_CITATIONS);
    },
  };
}
