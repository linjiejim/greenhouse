/**
 * Session Title Generator — LLM-powered concise title for chat sessions.
 *
 * Uses the flash model to generate a ≤30 character title from the user's
 * first message. Runs as a fire-and-forget async task alongside the main
 * chat stream.
 *
 * Fallback: if the LLM call fails, returns a truncated version of the
 * original message.
 */

import { generateText } from 'ai';
import { toErrorMessage } from '@greenhouse/utils/error';
import { createModelFromConfig } from '@greenhouse/agent-core';
import { logger } from '@greenhouse/utils/logger';
import type { ModelConfig } from '../profile.js';

// ─── Configuration ───────────────────────────────────────

/** Max chars of user message to send to the LLM (controls input token cost). */
const MAX_INPUT_LENGTH = 500;

/** Max chars for the generated title. */
const MAX_TITLE_LENGTH = 30;

/** Fallback title length when LLM fails. */
const FALLBACK_LENGTH = 50;

/**
 * Output token budget. Must be generous: reasoning models (e.g. DeepSeek's
 * reasoner-class endpoints) spend `reasoning_tokens` against this budget before
 * emitting any content. Too low → reasoning exhausts the budget, `content`
 * comes back empty with finish_reason=length, and the title is blank.
 * Even at this size a heavy reasoning model may exhaust it on a complex prompt;
 * the empty-title guard below is the real safety net.
 */
const MAX_OUTPUT_TOKENS = 1024;

/**
 * Model config: use the dedicated `title` registry id (LLM_MODEL_TITLE, falls
 * back to LLM_MODEL). Point it at a light, non-reasoning model — reasoning
 * models burn the output budget on thinking and return empty content.
 */
const TITLE_MODEL_CONFIG: ModelConfig = {
  id: 'title',
  provider: 'openai-compatible',
  model: 'title', // placeholder — resolved via registry id above
  apiKey: 'LLM_API_KEY',
};

// ─── Prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a title generator. Generate a concise, descriptive title for a chat conversation based on the user's first message.

Rules:
- Maximum ${MAX_TITLE_LENGTH} characters
- **Language consistency is mandatory**: the title MUST be in the same language as the user's message. Chinese message → Chinese title. English message → English title. Never translate.
- Focus on the main topic, task, or question
- Use clear, specific language — avoid generic words like "Help", "Question", "请帮我", "帮忙"
- No quotes, no trailing punctuation, no markdown
- Output the title text only, nothing else`;

// ─── Public API ──────────────────────────────────────────

/**
 * Generate a concise session title from the user's first message.
 *
 * @param userMessage - The first user message in the conversation.
 * @returns A short title string (≤30 chars). Falls back to truncated message on error.
 */
export async function generateSessionTitle(userMessage: string): Promise<string> {
  // Truncate long messages to control input token cost
  const truncated =
    userMessage.length > MAX_INPUT_LENGTH ? userMessage.slice(0, MAX_INPUT_LENGTH) + '...' : userMessage;

  try {
    const model = await createModelFromConfig(TITLE_MODEL_CONFIG);

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: truncated }],
      temperature: 0.3,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 1,
    });

    // A successful call can still yield empty/garbage text (e.g. a reasoning
    // model that spent its whole budget on reasoning_tokens). Never persist an
    // empty title — fall back to the truncated user message.
    const title = cleanTitle(result.text) || fallbackTitle(userMessage);

    logger.info('[title-gen] Generated', { title });

    // Record usage (fire-and-forget)
    if (result.usage) {
      import('@greenhouse/db')
        .then(({ getDb, isDbInitialized }) => {
          if (!isDbInitialized()) return;
          getDb()
            .usage.record({
              profile_id: 'system',
              caller: 'title-gen',
              model: TITLE_MODEL_CONFIG.model,
              input_tokens: result.usage.inputTokens ?? 0,
              output_tokens: result.usage.outputTokens ?? 0,
              cached_tokens: 0,
              reasoning_tokens: 0,
              duration_ms: 0,
            })
            .catch(() => {});
        })
        .catch(() => {});
    }

    return title;
  } catch (_err) {
    logger.warn('[title-gen] LLM title generation failed, using fallback', {
      error: toErrorMessage(_err),
    });
    return fallbackTitle(userMessage);
  }
}

// ─── Helpers ─────────────────────────────────────────────

/** Clean and validate the generated title. */
function cleanTitle(raw: string): string {
  let title = raw
    .trim()
    .replace(/^["'""]|["'""]$/g, '') // Remove surrounding quotes
    .replace(/[。.!！?？]$/, '') // Remove trailing punctuation
    .trim();

  // Enforce max length
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH - 1) + '…';
  }

  // If LLM returned empty/garbage, fall back
  if (!title || title.length < 2) {
    return '';
  }

  return title;
}

/** Fallback: truncate original message as title. */
function fallbackTitle(message: string): string {
  const clean = message
    .replace(/[\n\r]+/g, ' ') // Collapse newlines
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();

  if (clean.length <= FALLBACK_LENGTH) return clean;
  return clean.slice(0, FALLBACK_LENGTH - 1) + '…';
}
