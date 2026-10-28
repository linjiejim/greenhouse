/**
 * Global search wire types.
 *
 * The palette asks one endpoint and gets back one group per searchable kind.
 * Entity hits carry the same {@link EntityRef} the Markdown renderer produces;
 * conversation hits carry their session id and open the matching chat;
 * automation hits carry the automation id and open it on the Automations page.
 *
 * See docs/specs/20260804-entity-references-and-peek.md.
 */

import type { EntityKind, EntityRef } from './entity-links.js';

interface SearchHitBase {
  title: string;
  /** One line of disambiguating context — country, owning company, doc space… */
  subtitle?: string;
}

export interface EntitySearchHit extends SearchHitBase {
  ref: EntityRef;
}

export interface SessionSearchHit extends SearchHitBase {
  sessionId: string;
  /**
   * ISO timestamp of the conversation's last activity. Clients format it in
   * the reader's locale; `subtitle` is left empty for conversations (it used to
   * carry this same ISO string raw).
   */
  updatedAt?: string;
}

/** One of the caller's own automations (scheduled tasks), matched by name or prompt. */
export interface AutomationSearchHit extends SearchHitBase {
  automationId: string;
  /** False when the automation is paused. */
  enabled: boolean;
}

export type SearchHit = EntitySearchHit | SessionSearchHit | AutomationSearchHit;
export type SearchKind = EntityKind | 'session' | 'automation';

export interface SearchGroup {
  kind: SearchKind;
  items: SearchHit[];
  /**
   * There are more matches than `items` holds.
   *
   * Deliberately a boolean rather than a total: the underlying domain searches
   * return rows, not counts, and a per-domain `COUNT(*)` on every keystroke buys
   * a number nobody acts on. A badge reading "5+" is true; one reading "5" when
   * there are forty is not, and that is the only failure mode worth avoiding.
   */
  hasMore: boolean;
}

export interface GlobalSearchResponse {
  /** Echoed back so a slow response can be discarded once the query moved on. */
  query: string;
  groups: SearchGroup[];
}

/** Kinds the palette can search, in the order groups are displayed. */
export const SEARCHABLE_KINDS: readonly SearchKind[] = ['session', 'automation', 'kb_doc'];
