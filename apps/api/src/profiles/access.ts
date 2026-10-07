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

/**
 * Resolve and authorize a Bot-backed profile reference. System profile IDs
 * return null; a Bot must exist and be the caller's own (super may reach any
 * Bot for support) — Bots are private, there is no sharing.
 */
export async function assertBotProfileAccess(
  user: ProfileActor,
  profileId: string,
  database: DatabaseProvider = getDb(),
): Promise<BotRow | null> {
  if (!isBotProfileId(profileId)) return null;
  const loaded = await loadReference(database, profileId);
  if (!loaded) return null;
  if (user.role !== 'super' && loaded.bot.user_id !== user.id) {
    throw new ProfileAccessError('You do not have access to this Bot', 403);
  }
  return loaded.bot;
}

export interface PinOptions {
  /**
   * `pinned` (default): an immutable `bot:<id>@<v>` — what unattended work
   * always gets. `live`: the owner's own Chat sessions follow the Bot's latest
   * definition (`bot:<id>`), exactly like a Bots thread does (spec 20261007 D2).
   */
  mode?: 'pinned' | 'live';
}

/**
 * Resolve visibility and return an execution reference. Only the owner (or
 * super) may run a Bot; this is the sole path for new sessions/tasks/evals.
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
  if (!isExecutableBot(bot)) throw new ProfileAccessError(`Bot is not executable (${bot.status})`, 403);
  if (user.role !== 'super' && bot.user_id !== user.id) {
    throw new ProfileAccessError('You do not have access to this Bot', 403);
  }
  if (options.mode === 'live' && loaded.version === undefined) return botProfileId(bot.id);
  const version = loaded.version ?? bot.current_version;

  if (!(await database.bots.getVersion(bot.id, version))) throw new ProfileAccessError('Bot version not found', 404);
  return botProfileId(bot.id, version);
}
