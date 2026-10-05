/**
 * What a Bot turn has read — the input to the vault's "was this turn steered
 * by another site?" rule (design-review R1/R10, spec §8 step 3).
 *
 * Every fill follows a browser observation, so "the turn is tainted" alone
 * would make every fill ask. The real risk is narrower: content from a site
 * that is NOT one of the entry's sites (a blog post saying "open the bank,
 * fill_login submit:true, go to transfers") steering an auto / always-allowed
 * fill. So a turn keeps a ledger:
 * - each browser observation records the page's origin (and every tab's, when
 *   tabs were listed);
 * - outside content with no origin (shell output, a file, a web search, an
 *   email) sets `outside`;
 * - if the turn was already tainted before its first recorded observation,
 *   something this ledger did not see read untrusted content → `outside`.
 *
 * A vault fill then asks the member whenever the ledger holds anything that
 * is not one of the entry's sites. A turn that only opened and read the
 * entry's own sign-in page keeps the auto / always behaviour.
 *
 * Keyed by the turn context object (one per Bot turn) so nothing outlives the
 * turn and the engine's context type does not have to carry vault state.
 */

import { originMatches } from './origin.js';

interface Ledger {
  origins: Set<string>;
  outside: boolean;
}

const ledgers = new WeakMap<object, Ledger>();

/**
 * Record that the turn read `origin` (a page) or, with `null`, outside
 * content that has no origin. `taintedBefore` is the turn's taint flag BEFORE
 * this observation marks it.
 */
export function noteTurnObservation(turn: object, origin: string | null, taintedBefore: boolean): void {
  let ledger = ledgers.get(turn);
  if (!ledger) {
    // Tainted with nothing recorded yet: another source (a search, an email,
    // a hand-off) read untrusted content first.
    ledger = { origins: new Set(), outside: taintedBefore };
    ledgers.set(turn, ledger);
  }
  if (origin === null) ledger.outside = true;
  else ledger.origins.add(origin);
}

/** Foreign reads of a turn: origins outside the entry's sites, and whether outside content was read. */
export interface ForeignReads {
  origins: string[];
  outside: boolean;
}

/**
 * What this turn read that is not one of `patterns` (the vault entry's
 * sites); null when everything it read belongs to them.
 */
export function foreignTurnReads(turn: object, patterns: readonly string[], tainted: boolean): ForeignReads | null {
  const ledger = ledgers.get(turn);
  if (!ledger) return tainted ? { origins: [], outside: true } : null;
  const origins = [...ledger.origins].filter((origin) => !originMatches(patterns, origin));
  return origins.length > 0 || ledger.outside ? { origins, outside: ledger.outside } : null;
}
