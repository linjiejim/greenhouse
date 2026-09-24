/**
 * The inline tool face of a browser-extension conversation
 * (`sessions.channel = 'browser'`).
 *
 * The Greenhouse Bridge side panel puts the web page the user is reading into
 * the turn (their selection, or the page text for "summarize"), and its browser
 * actions read more pages while the agent works. That page content is
 * untrusted input sitting next to the user's own data, so the model gets no
 * inline way to change anything. The face is fail-closed: declared reads
 * (`surface.proxy: 'read'`) plus the output-only tools below. A writer the
 * catalog gains later stays out until someone decides otherwise here.
 *
 * The panel's one write path is its `save_to_knowledge` Client Action, which
 * shows a confirm card before it calls the confirm-gated agent proxy
 * (apps/browser/src/lib/knowledge-tools.ts). Client Actions are registered by
 * the chat route after this filter runs, so they are unaffected by it.
 *
 * Keyed on the session's server-recorded channel, never on a per-request flag:
 * it holds for every turn of the conversation, including when the web app
 * continues it, because the history still carries page-derived text. (The
 * extension used to send `omit_write_tools: true` per turn; a server that
 * stopped reading that flag silently handed every writer back.)
 */

import { getToolMeta } from '../tools/registry.js';

/** Not proxy reads, but they only produce output for the user: a question back, or a download of their own data. */
const OUTPUT_ONLY_TOOL_IDS: ReadonlySet<string> = new Set(['ask_user', 'export_data']);

export function filterBrowserSessionToolIds(toolIds: readonly string[]): string[] {
  return toolIds.filter((id) => getToolMeta(id)?.surface?.proxy === 'read' || OUTPUT_ONLY_TOOL_IDS.has(id));
}
