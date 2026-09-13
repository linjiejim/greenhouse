/**
 * The one sentence every tool that returns in-app `url` fields appends to its
 * description.
 *
 * Display rules belong in tool descriptions rather than profile prompts (they
 * ride the function definition, so chat / `/api/agent` / `/api/mcp` all get
 * them) — but five hand-written copies of the same instruction is how wording
 * drifts, so it is written once here.
 *
 * "verbatim" is the load-bearing word: the model's job is to copy a url it was
 * given, never to assemble one from an id. A fabricated link looks identical to
 * a real one until someone clicks it.
 *
 * This module must stay import-free. Tool descriptions interpolate it at module
 * evaluation time and `tools/registry.ts` imports every tool module, so a
 * constant sitting behind an import cycle lands in the TDZ: unit tests stay
 * green and the API fails to boot.
 */
export const CITE_URL_INSTRUCTION =
  'Link any record you name using the `url` from its result — verbatim, never assembled by hand.';
