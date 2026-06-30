/**
 * User Memory — extraction, retrieval, and batch processing.
 *
 * - extractMemories(): LLM-powered extraction from a single conversation
 * - retrieveUserMemories(): Load & format memories for system prompt injection
 * - runMemoryExtraction(): Daily batch job entry point
 */

import { generateText } from 'ai';
import { toErrorMessage } from '@greenhouse/utils/error';
import { createModelFromConfig } from '@greenhouse/agent-core';
import { logger } from '@greenhouse/utils/logger';
import { extractJson } from '@greenhouse/utils/json';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import { getDb, isDbInitialized } from '@greenhouse/db';
import type { ModelConfig } from '../profile.js';

// ─── Configuration ───────────────────────────────────────

/** Model: configurable via env, defaults to flash for speed and cost. */
const MEMORY_MODEL_CONFIG: ModelConfig = {
  id: 'flash',
  provider: process.env.MEMORY_LLM_PROVIDER || 'openai-compatible',
  model: process.env.MEMORY_LLM_MODEL || 'flash', // placeholder — resolved via registry id above
  apiKey: process.env.MEMORY_LLM_API_KEY_NAME || 'LLM_API_KEY',
};

/** Max messages to include in extraction prompt. */
const MAX_MESSAGES_FOR_EXTRACTION = 8;

/** Max characters per message in extraction prompt. */
const MAX_MESSAGE_LENGTH = 600;

/** Concurrency limit for session processing within a user. */
const SESSION_CONCURRENCY = 3;

/** Max total sessions to process per job run (global cap). */
const MAX_SESSIONS_PER_JOB = 100;

/** Max sessions to scan per user (only recent unprocessed). */
const MAX_SESSIONS_PER_USER = 20;

// ─── Extraction Prompt ───────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Analyze the conversation and extract user-specific facts worth remembering for future conversations.

Extract ONLY information that is:
1. About the USER personally (not general knowledge or task content)
2. Likely to be useful in FUTURE conversations
3. Persistent facts (not ephemeral session context)

Categories:
- "preference": Communication style, language, format, response length preferences
- "fact": Role, projects, tech stack, team structure, domain expertise, company info
- "behavior": Common workflows, frequently used tools, work patterns

Rules:
- Output a JSON array: [{"category": "...", "content": "..."}]
- Each content: one concise, self-contained statement
- Max 3 items per conversation (be highly selective)
- If nothing worth remembering, output: []
- Content language: match the user's language
- NEVER extract: passwords, tokens, API keys, emails, phone numbers
- NEVER extract: transient task details, one-off questions, general knowledge`;

// ─── Core Functions ──────────────────────────────────────

interface ExtractedMemory {
  category: string;
  content: string;
}

/**
 * Extract memories from a conversation using LLM.
 *
 * @param messages - Conversation messages (user + assistant only)
 * @returns Array of extracted memories (may be empty)
 */
export async function extractMemories(messages: Array<{ role: string; content: string }>): Promise<ExtractedMemory[]> {
  // Filter to user+assistant, take last N messages
  const relevant = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_MESSAGES_FOR_EXTRACTION);

  if (relevant.length < 2) return []; // Need at least one exchange

  // Format for prompt (truncate long messages)
  const formatted = relevant
    .map((m) => {
      const content =
        m.content.length > MAX_MESSAGE_LENGTH ? m.content.slice(0, MAX_MESSAGE_LENGTH) + '...' : m.content;
      return `${m.role}: ${content}`;
    })
    .join('\n\n');

  try {
    const model = await createModelFromConfig(MEMORY_MODEL_CONFIG);

    const result = await generateText({
      model,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Conversation:\n${formatted}` }],
      temperature: 0.2,
      maxOutputTokens: 300,
      maxRetries: 1,
    });

    // Parse JSON output
    const jsonStr = extractJson(result.text);
    if (!jsonStr) return [];

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    // Validate structure
    const validCategories = new Set(['preference', 'fact', 'behavior']);
    const memories: ExtractedMemory[] = parsed
      .filter(
        (m: unknown): m is { category: string; content: string } =>
          typeof m === 'object' &&
          m !== null &&
          typeof (m as Record<string, unknown>).category === 'string' &&
          typeof (m as Record<string, unknown>).content === 'string' &&
          validCategories.has((m as Record<string, unknown>).category as string) &&
          ((m as Record<string, unknown>).content as string).length > 0,
      )
      .slice(0, 3); // Max 3 per conversation

    // Record usage (fire-and-forget)
    if (result.usage && isDbInitialized()) {
      getDb()
        .usage.record({
          profile_id: 'system',
          caller: 'memory-extract',
          model: MEMORY_MODEL_CONFIG.model,
          input_tokens: result.usage.inputTokens ?? 0,
          output_tokens: result.usage.outputTokens ?? 0,
          cached_tokens: 0,
          reasoning_tokens: 0,
        })
        .catch(() => {});
    }

    return memories;
  } catch (err) {
    logger.warn('[memory] Extraction failed', { error: toErrorMessage(err) });
    return [];
  }
}

/**
 * Retrieve and format user memories for system prompt injection.
 *
 * @param userId - User ID
 * @returns Formatted memory block string, or null if no memories
 */
export async function retrieveUserMemories(userId: string): Promise<string | null> {
  const db = getDb();
  const memories = await db.userMemories.listByUser(userId, 20);
  if (memories.length === 0) return null;

  // Fire-and-forget: record access
  db.userMemories.touchMany(memories.map((m) => m.id)).catch(() => {});

  // Group by category and format
  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m.content);
  }

  const categoryLabels: Record<string, string> = {
    preference: 'Preferences',
    fact: 'Facts',
    behavior: 'Behavior Patterns',
  };

  const parts: string[] = [];
  for (const [cat, items] of Object.entries(grouped)) {
    const label = categoryLabels[cat] || cat;
    parts.push(`${label}:\n${items.map((c) => `- ${c}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Daily batch job: extract memories from unprocessed sessions.
 *
 * 1. Get users with 'memory' feature enabled
 * 2. For each user, find sessions not yet processed
 * 3. Extract memories from each session
 * 4. Store memories + mark sessions as processed
 */
export async function runMemoryExtraction(): Promise<{
  usersProcessed: number;
  sessionsProcessed: number;
  memoriesExtracted: number;
}> {
  const db = getDb();
  const stats = { usersProcessed: 0, sessionsProcessed: 0, memoriesExtracted: 0 };

  // 1. Get enabled users
  const userIds = await db.userFeatures.listEnabledUsers('memory');
  if (userIds.length === 0) {
    logger.info('[memory] No users with memory feature enabled');
    return stats;
  }

  logger.info(`[memory] Processing ${userIds.length} user(s)`);

  let totalSessionsProcessed = 0;

  // 2. Process each user
  for (const userId of userIds) {
    if (totalSessionsProcessed >= MAX_SESSIONS_PER_JOB) {
      logger.info(`[memory] Global session cap (${MAX_SESSIONS_PER_JOB}) reached, stopping`);
      break;
    }

    try {
      // Get user's sessions that haven't been memory-extracted
      const sessions = await db.sessions.list({
        userId,
        channel: 'web',
        limit: MAX_SESSIONS_PER_USER,
      });

      // Filter to sessions not yet extracted
      const unprocessed = sessions.filter((s) => {
        try {
          const meta = JSON.parse(s.metadata || '{}');
          return !meta.memory_extracted;
        } catch {
          return true;
        }
      });

      if (unprocessed.length === 0) continue;

      logger.info(`[memory] User ${userId}: ${unprocessed.length} unprocessed session(s)`);
      stats.usersProcessed++;

      // Process sessions with concurrency limit
      await runWithConcurrency(unprocessed, SESSION_CONCURRENCY, async (session) => {
        try {
          const messages = await db.sessions.buildChatMessages(session.id);

          // Skip sessions with too few messages
          if (messages.filter((m) => m.role === 'user').length < 1) {
            await markSessionExtracted(session.id);
            return;
          }

          const extracted = await extractMemories(messages);

          if (extracted.length > 0) {
            const count = await db.userMemories.upsertBatch(
              extracted.map((m) => ({
                user_id: userId,
                category: m.category,
                content: m.content,
                source_session_id: session.id,
              })),
            );
            stats.memoriesExtracted += count;
          }

          await markSessionExtracted(session.id);
          stats.sessionsProcessed++;
          totalSessionsProcessed++;
        } catch (err) {
          logger.warn('[memory] Failed to process session', { sessionId: session.id, error: String(err) });
        }
      });
    } catch (err) {
      logger.error(`[memory] Failed to process user ${userId}`, err);
    }
  }

  return stats;
}

/**
 * Mark a session as memory-extracted in its metadata.
 */
async function markSessionExtracted(sessionId: string): Promise<void> {
  try {
    const db = getDb();
    const session = await db.sessions.getById(sessionId);
    const meta = JSON.parse(session?.metadata || '{}');
    meta.memory_extracted = true;
    meta.memory_extracted_at = new Date().toISOString();
    await db.sessions.update(sessionId, { metadata: JSON.stringify(meta) });
  } catch {
    /* ignore */
  }
}
