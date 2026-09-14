/**
 * Boot-time backfill of segmented FTS tokens for knowledge documents.
 *
 * The `_tokens_*` columns arrived with empty defaults; rows that predate them
 * would never match a search until re-tokenized. Runs only when such rows
 * exist, never blocks boot, and only warns on failure — the CLI
 * (`pnpm cli knowledge reindex`) remains the manual path.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';

export async function backfillKnowledgeTokens(db: DatabaseProvider): Promise<number> {
  try {
    const pending = await db.knowledgeBase.countUntokenized();
    if (pending === 0) return 0;
    logger.info(`[Knowledge] tokenizing ${pending} document(s) that predate segmented search`);
    const done = await db.knowledgeBase.reindexTokens();
    logger.info(`[Knowledge] tokenized ${done} document(s)`);
    return done;
  } catch (error) {
    logger.warn('[Knowledge] token backfill failed — run `pnpm cli knowledge reindex`', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
