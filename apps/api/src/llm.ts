/**
 * LLM completion layer — re-exports from src/llm/.
 *
 * Canonical implementation lives in src/llm/complete.ts.
 * This file preserves backward compatibility for api/ consumers.
 */

export { complete, completeJson } from './llm/complete.js';
export type { CompletionMessage, CompletionOptions, CompletionResult } from './llm/complete.js';
