/**
 * Which tool results taint a Bot turn (spec §8, design review R1).
 *
 * A tainted turn has read untrusted outside content: from then on its memory
 * writes default to the Bot's private scope and a vault fill asks first. The
 * browser and computer tools mark the turn themselves for every action that
 * reads something; this list is the engine's fail-closed backstop on top.
 */

import { noteTurnObservation } from '../vault/turn-observations.js';

/**
 * Tools whose results are untrusted outside content: reading one taints the turn.
 * `mcp_call` taints on every action, `list` and `describe` included: a remote
 * tool's description and schema are the remote server's own words (spec
 * 20261009-mcp-connectors D8).
 */
export const TAINTING_TOOLS: ReadonlySet<string> = new Set([
  'browser',
  'computer',
  'external_search',
  'email_query',
  'read_attachment',
  'analyze_image',
  'mcp_call',
]);

/**
 * Computer actions that read nothing back. `import_attachment` copies a file
 * the member attached into ~/work without showing the Bot a byte: the
 * vault ledger notes member-provided content, but the turn is not tainted by
 * the copy itself — reading the file afterwards is.
 */
const NON_READING_COMPUTER_ACTIONS: ReadonlySet<string> = new Set(['import_attachment']);

/** Whether a finished tool call taints the turn. */
export function resultTaintsTurn(toolName: string, input: unknown): boolean {
  if (!TAINTING_TOOLS.has(toolName)) return false;
  if (toolName !== 'computer') return true;
  const action = input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  return !(typeof action === 'string' && NON_READING_COMPUTER_ACTIONS.has(action));
}

/**
 * Account for a finished tool call: whether it taints the turn and, for an
 * outside source other than the browser/computer (which record their own
 * origins), outside content with no origin in the vault's foreign-read ledger.
 * Without that note a turn whose ledger already held only the entry's own
 * sign-in page would look clean to a later fill after reading a search
 * result or an email that could be steering it.
 */
export function observeToolResult(turn: object, toolName: string, input: unknown, taintedBefore: boolean): boolean {
  if (!resultTaintsTurn(toolName, input)) return false;
  if (toolName !== 'browser' && toolName !== 'computer') noteTurnObservation(turn, null, taintedBefore);
  return true;
}
