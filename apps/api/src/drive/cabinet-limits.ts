/**
 * Limits of the knowledge-cabinet agent tools. A zero-import leaf module: tool
 * descriptions interpolate these at module evaluation, and tools/registry.ts
 * imports every tool module, so a constant behind an import cycle would sit in
 * the TDZ and stop the API from booting.
 */

/** An agent upload travels inside one MCP/JSON request, so it stays small. */
export const MAX_AGENT_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Lifetime of a download link handed to an agent. */
export const DOWNLOAD_URL_TTL_SECONDS = 300;
