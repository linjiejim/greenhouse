import { getDb, type BotRow, type DatabaseProvider } from '@greenhouse/db';
import type { AuthUser } from '../auth/token.js';
import {
  DEFAULT_PROFILE_ID,
  botProfileId,
  isBotProfileId,
  isExecutableBot,
  loadBotReference,
  normalizeProfileId,
} from './profile.js';

type ProfileActor = Pick<AuthUser, 'id' | 'role'>;

export class ProfileAccessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = 'ProfileAccessError';
  }
}

async function loadReference(database: DatabaseProvider, profileId: string) {
  try {
    return await loadBotReference(database, profileId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ProfileAccessError(message, /^Invalid/.test(message) ? 400 : 404);
  }
}

function assertSharedAccess(bot: BotRow, version: number | undefined): void {
  if (!bot.is_shared || (bot.lifecycle_status !== 'pilot' && bot.lifecycle_status !== 'verified')) {
    throw new ProfileAccessError('You do not have access to this Bot', 403);
  }
  if (!bot.published_version) throw new ProfileAccessError('Bot has no published version', 403);
  if (version !== undefined && version !== bot.published_version) {
    throw new ProfileAccessError('Only the published Bot version is available', 403);
  }
}

/**
 * Resolve and authorize a Bot-backed profile reference. System profile IDs
 * return null; Bots must exist and be owned, shared, or requested by super.
 */
export async function assertBotProfileAccess(
  user: ProfileActor,
  profileId: string,
  database: DatabaseProvider = getDb(),
): Promise<BotRow | null> {
  if (!isBotProfileId(profileId)) return null;
  const loaded = await loadReference(database, profileId);
  if (!loaded) return null;
  if (user.role !== 'super' && loaded.bot.user_id !== user.id) assertSharedAccess(loaded.bot, loaded.version);
  return loaded.bot;
}

export interface PinOptions {
  /**
   * `pinned` (default): an immutable `bot:<id>@<v>` — what unattended work and
   * other members always get. `live`: the owner's own Chat sessions follow the
   * Bot's latest definition (`bot:<id>`), exactly like a Bots thread does
   * (spec 20261007 D2). Non-owners are pinned to the published version either way.
   */
  mode?: 'pinned' | 'live';
}

/**
 * Resolve visibility and return an execution reference.
 *
 * Owners/super may run the current draft; other users only the reviewed
 * published version of a pilot/verified Bot. This is the sole path for new
 * sessions/tasks/evals, so sharing never leaks an owner's newer draft.
 */
export async function pinProfileIdForUser(
  user: ProfileActor,
  rawProfileId?: string | null,
  database: DatabaseProvider = getDb(),
  options: PinOptions = {},
): Promise<string> {
  const profileId = normalizeProfileId(rawProfileId) ?? DEFAULT_PROFILE_ID;
  if (!isBotProfileId(profileId)) return profileId;

  const loaded = await loadReference(database, profileId);
  if (!loaded) return profileId;
  const { bot } = loaded;
  if (!isExecutableBot(bot)) throw new ProfileAccessError(`Bot is not executable (${bot.lifecycle_status})`, 403);

  const ownsAsset = user.role === 'super' || bot.user_id === user.id;
  let version: number | undefined;
  if (ownsAsset) {
    if (options.mode === 'live' && loaded.version === undefined) return botProfileId(bot.id);
    version = loaded.version ?? bot.current_version;
  } else {
    assertSharedAccess(bot, loaded.version);
    version = bot.published_version!;
  }

  if (!(await database.bots.getVersion(bot.id, version))) throw new ProfileAccessError('Bot version not found', 404);
  return botProfileId(bot.id, version);
}
