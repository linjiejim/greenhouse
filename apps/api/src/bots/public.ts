/**
 * Public Agents (spec 20261011-agent-first-class P4, D33–D41).
 *
 * An owner publishes one of their Agents (never Sprouty) to an audience; members in it talk to the
 * published version in their own DM. Everything here answers one of four questions:
 * - is it available to this member (`publicBotFor`)?
 * - what are its settings (`publicationOf`, defaults filled in)?
 * - is a write by its owner valid (`validatePublicationWrite`)?
 * - which knowledge folders does it read, within its owner's own access (`grantedFolderIds`)?
 *
 * The engine runs it on a fixed, narrow face (engine/public-face.ts): its effective permissions are
 * these grants intersected with the owner's access at the moment of use, never the member's.
 */

import type { BotRow, DatabaseProvider } from '@greenhouse/db';
import {
  PUBLIC_AGENT_DEFAULT_MONTHLY_TOKENS,
  type BotAudience,
  type BotPublicationSettings,
  type BotPublicationWrite,
} from '@greenhouse/types/bots';
import { safeJsonParse } from '@greenhouse/utils/json';
import { kbFolderSubtreeIds } from '../knowledge/folders.js';

const MAX_AUDIENCE_USERS = 500;
const MAX_AUDIENCE_GROUPS = 100;
const MAX_GRANTED_FOLDERS = 50;
const MAX_MONTHLY_TOKENS = 1_000_000_000;

export class PublicationError extends Error {
  constructor(
    readonly code: 'bot_protected' | 'invalid' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

/** A Bot's publication settings with every default filled in. */
export function publicationOf(row: Pick<BotRow, 'publication'>): BotPublicationSettings {
  const raw = safeJsonParse(row.publication, {}) as Partial<BotPublicationSettings>;
  const audience = (raw.audience ?? {}) as Partial<BotAudience>;
  const grants = (raw.grants ?? {}) as Partial<BotPublicationSettings['grants']>;
  const budget = (raw.budget ?? {}) as Partial<BotPublicationSettings['budget']>;
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const ints = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v) && (v as number) > 0) : [];
  const positive = (value: unknown) => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : null);
  return {
    audience: {
      everyone: audience.everyone === true,
      user_ids: strings(audience.user_ids),
      group_ids: ints(audience.group_ids),
    },
    grants: { kb_folder_ids: ints(grants.kb_folder_ids), computer: grants.computer === true },
    budget: {
      monthly_tokens: positive(budget.monthly_tokens),
      daily_tokens_per_user: positive(budget.daily_tokens_per_user),
    },
  };
}

/** Its monthly token cap (D37). */
export function monthlyTokensOf(settings: BotPublicationSettings): number {
  return settings.budget.monthly_tokens ?? PUBLIC_AGENT_DEFAULT_MONTHLY_TOKENS;
}

/** Published, not paused, active — usable by its audience at all. */
export function isPublished(
  row: Pick<BotRow, 'visibility' | 'published_version' | 'public_paused' | 'status'>,
): boolean {
  return row.visibility === 'public' && row.published_version !== null && !row.public_paused && row.status === 'active';
}

async function inAudience(db: DatabaseProvider, userId: string, audience: BotAudience): Promise<boolean> {
  if (audience.everyone || audience.user_ids.includes(userId)) return true;
  for (const groupId of audience.group_ids) if (await db.groups.isMember(groupId, userId)) return true;
  return false;
}

/**
 * Someone else's public Bot as this member may use it: its published version applied (name, role,
 * instructions, model, …), or null when it is not offered to them (unpublished, paused, archived,
 * outside its audience — or their own Bot, which they use directly).
 */
export async function publicBotFor(db: DatabaseProvider, userId: string, botId: string): Promise<BotRow | null> {
  const row = await db.bots.getBotById(botId);
  if (!row || row.user_id === userId || !isPublished(row)) return null;
  const member = await db.users.getById(userId);
  if (!member || member.status !== 'active' || (member.role !== 'team' && member.role !== 'super')) return null;
  if (!(await inAudience(db, userId, publicationOf(row).audience))) return null;
  const version = await db.bots.getVersion(row.id, row.published_version!);
  if (!version) return null;
  return {
    ...row,
    name: version.name,
    role: version.role,
    description: version.description,
    instructions: version.instructions,
    model_id: version.model_id,
    tools: version.tools,
    connectors: version.connectors,
    max_steps: version.max_steps,
    avatar: version.avatar,
  };
}

/** Every public Bot this member may use (the directory), newest-named first is the caller's call. */
export async function listPublicBotsFor(db: DatabaseProvider, userId: string): Promise<BotRow[]> {
  const out: BotRow[] = [];
  for (const row of await db.bots.listPublicBots()) {
    const usable = await publicBotFor(db, userId, row.id);
    if (usable) out.push(usable);
  }
  return out;
}

/**
 * Names of every Bot a member's conversation can show: their own (archived included) and any
 * other member's public Agent in it (P4) — so headers, digests and alerts never say "deleted".
 */
export async function conversationBotNames(
  db: DatabaseProvider,
  userId: string,
  memberBotIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map((await db.bots.listBots(userId, { includeArchived: true })).map((bot) => [bot.id, bot.name]));
  for (const id of memberBotIds) {
    if (names.has(id)) continue;
    const bot = await db.bots.getBotById(id);
    if (bot) names.set(id, bot.name);
  }
  return names;
}

/** May the owner read this knowledge folder (theirs, or a team folder)? */
async function ownerReadsFolder(db: DatabaseProvider, ownerId: string, folderId: number): Promise<boolean> {
  const folder = await db.drive.getFolder(folderId);
  if (!folder || folder.scope !== 'kb') return false;
  if (folder.visibility === 'team') return true;
  return folder.visibility === 'private' && folder.owner_user_id === ownerId && folder.bot_id === null;
}

/**
 * The folders a public Agent reads, expanded to their subtrees: the granted ones its owner can still
 * read right now (D2: grants ∩ the owner's current access), plus its own reference folder.
 */
export async function grantedFolderIds(
  db: DatabaseProvider,
  bot: Pick<BotRow, 'id' | 'user_id'>,
  settings: BotPublicationSettings,
): Promise<number[]> {
  const ids = new Set<number>();
  for (const folderId of settings.grants.kb_folder_ids) {
    const folder = await db.drive.getFolder(folderId);
    if (!folder || !(await ownerReadsFolder(db, bot.user_id, folderId))) continue;
    const scope =
      folder.visibility === 'team'
        ? ({ visibility: 'team' } as const)
        : ({ visibility: 'private', ownerUserId: bot.user_id } as const);
    for (const id of await kbFolderSubtreeIds(db, folderId, scope)) ids.add(id);
  }
  const own = await db.drive.listFolders({
    scope: 'kb',
    visibility: 'private',
    owner_user_id: bot.user_id,
    parent_id: null,
  });
  for (const folder of own) {
    if (folder.bot_id !== bot.id) continue;
    for (const id of await kbFolderSubtreeIds(db, folder.id, { visibility: 'private', ownerUserId: bot.user_id }))
      ids.add(id);
  }
  return [...ids];
}

/**
 * Validate and apply an owner's write onto the current settings. Audience members must be active
 * internal members; groups must exist; granted folders must be readable by the owner (D36).
 */
export async function validatePublicationWrite(
  db: DatabaseProvider,
  bot: BotRow,
  write: BotPublicationWrite,
): Promise<{ settings: BotPublicationSettings; visibility: 'private' | 'public'; publishedVersion: number | null }> {
  if (bot.template_key === 'sprouty') {
    throw new PublicationError('bot_protected', 'Sprouty is your main Agent and is never published');
  }
  const current = publicationOf(bot);
  const settings: BotPublicationSettings = {
    audience: { ...current.audience },
    grants: { ...current.grants },
    budget: { ...current.budget },
  };
  if (write.audience !== undefined) {
    const userIds = [...new Set(write.audience.user_ids ?? [])];
    const groupIds = [...new Set(write.audience.group_ids ?? [])];
    if (userIds.length > MAX_AUDIENCE_USERS || groupIds.length > MAX_AUDIENCE_GROUPS) {
      throw new PublicationError('invalid', 'That audience is too large — choose everyone instead');
    }
    for (const id of userIds) {
      const user = await db.users.getById(id);
      if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
        throw new PublicationError('invalid', 'Only active members can be in the audience');
      }
    }
    for (const id of groupIds) {
      if (!Number.isInteger(id) || !(await db.groups.getById(id)))
        throw new PublicationError('invalid', 'Unknown group');
    }
    settings.audience = { everyone: write.audience.everyone === true, user_ids: userIds, group_ids: groupIds };
  }
  if (write.grants?.kb_folder_ids !== undefined) {
    const folderIds = [...new Set(write.grants.kb_folder_ids)];
    if (folderIds.length > MAX_GRANTED_FOLDERS) throw new PublicationError('invalid', 'Grant at most 50 folders');
    for (const id of folderIds) {
      if (!Number.isInteger(id) || !(await ownerReadsFolder(db, bot.user_id, id))) {
        throw new PublicationError('invalid', 'You can only grant knowledge folders you can read');
      }
    }
    settings.grants.kb_folder_ids = folderIds;
  }
  if (write.grants?.computer !== undefined) settings.grants.computer = write.grants.computer === true;
  const budgetValue = (value: number | null | undefined, current: number | null): number | null => {
    if (value === undefined) return current;
    if (value === null) return null;
    if (!Number.isInteger(value) || value < 1 || value > MAX_MONTHLY_TOKENS) {
      throw new PublicationError('invalid', 'A token limit is a whole number between 1 and 1,000,000,000');
    }
    return value;
  };
  if (write.budget) {
    settings.budget = {
      monthly_tokens: budgetValue(write.budget.monthly_tokens, settings.budget.monthly_tokens),
      daily_tokens_per_user: budgetValue(write.budget.daily_tokens_per_user, settings.budget.daily_tokens_per_user),
    };
  }
  const visibility = write.visibility ?? bot.visibility;
  if (visibility !== 'private' && visibility !== 'public') throw new PublicationError('invalid', 'Unknown visibility');
  const publishedVersion = write.publish ? bot.current_version : bot.published_version;
  if (visibility === 'public' && publishedVersion === null) {
    throw new PublicationError('invalid', 'Publish a version before making the Agent public');
  }
  return { settings, visibility, publishedVersion };
}
