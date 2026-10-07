/**
 * A Bot's private reference folder (spec 20261007 §2.5).
 *
 * One personal knowledge folder per Bot (`drive_folders.bot_id`), created on
 * first use. The owner sees it in their own knowledge library like any other
 * private folder. What is new is only an EXCLUSION rule on the agent side: a
 * turn that runs as Bot X reads the personal library minus the owner's other
 * Bots' folders; an identity-less agent surface (the MCP runtime, a headless
 * run without a Bot) reads it minus all of them. The owner's own HTTP routes
 * pass nothing and keep seeing everything.
 */

import type { BotRow, DatabaseProvider, DriveFolderRow } from '@greenhouse/db';
import { kbFolderSubtreeIds } from '../knowledge/folders.js';

/** The Bot's root folder, created on first use (name follows the Bot's name). */
export async function ensureBotFolder(
  db: DatabaseProvider,
  bot: Pick<BotRow, 'id' | 'user_id' | 'name'>,
): Promise<DriveFolderRow> {
  const existing = await db.drive.getBotFolder(bot.id);
  if (existing) return existing;
  return db.drive.createFolder({
    scope: 'kb',
    parent_id: null,
    name: bot.name,
    visibility: 'private',
    owner_user_id: bot.user_id,
    bot_id: bot.id,
    created_by: bot.user_id,
  });
}

/** Keep the folder's name in step with a renamed Bot. */
export async function renameBotFolder(db: DatabaseProvider, bot: Pick<BotRow, 'id' | 'name'>): Promise<void> {
  const folder = await db.drive.getBotFolder(bot.id);
  if (folder && folder.name !== bot.name) await db.drive.updateFolder(folder.id, { name: bot.name });
}

export interface BotFolderScope {
  /** Personal folders (expanded subtrees) the current identity must not see. */
  excludeFolderIds: number[];
  /** This Bot's own folder subtree (root first), or null when it has none yet. */
  ownFolderIds: number[] | null;
}

/**
 * The folder scoping for an agent turn in `userId`'s personal library:
 * `botId` = the Bot the turn runs as (its own folder stays visible, every
 * other Bot's is hidden); `null` = no Bot identity (every Bot folder hidden).
 */
export async function botFolderScope(
  db: DatabaseProvider,
  userId: string,
  botId: string | null,
): Promise<BotFolderScope> {
  const roots = (
    await db.drive.listFolders({ scope: 'kb', parent_id: null, visibility: 'private', owner_user_id: userId })
  ).filter((folder) => folder.bot_id != null);
  const scope = { visibility: 'private' as const, ownerUserId: userId };
  const excludeFolderIds: number[] = [];
  let ownFolderIds: number[] | null = null;
  for (const root of roots) {
    const subtree = await kbFolderSubtreeIds(db, root.id, scope);
    if (root.bot_id === botId) ownFolderIds = subtree;
    else excludeFolderIds.push(...subtree);
  }
  return { excludeFolderIds, ownFolderIds };
}
