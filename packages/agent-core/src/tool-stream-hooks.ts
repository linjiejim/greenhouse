/**
 * Per-tool stream hooks — a downstream host/fork registers how a specific tool's
 * output is summarized for pipeline storage, so the kernel's `summarizeOutput()`
 * needs no hardcoded tool-name branch for fork tools.
 *
 * The kernel keeps built-in summaries for its OWN core tools (knowledge_query,
 * analyze_image) as a fallback; a registered summarizer takes precedence — so a
 * fork can add a tool OR override a core summary. Registry is EMPTY upstream; the
 * api host registers fork tools at startup (agent-core is a versioned package, so
 * a fork cannot edit chat-engine.ts directly).
 *
 * Fork example (call once at startup):
 *   registerToolOutputSummarizer('letpot_source', (out) => ({ found: out.found, query: out.query }));
 */

export type ToolOutputSummarizer = (output: Record<string, unknown>) => unknown;

const summarizers = new Map<string, ToolOutputSummarizer>();

/** Register a per-tool output summarizer (precedence over the kernel's built-ins). */
export function registerToolOutputSummarizer(toolName: string, fn: ToolOutputSummarizer): void {
  summarizers.set(toolName, fn);
}

export function getToolOutputSummarizer(toolName: string): ToolOutputSummarizer | undefined {
  return summarizers.get(toolName);
}
