import type { DatabaseProvider } from '@greenhouse/db';
import type { AuthUser } from '../auth/token.js';
import { stationManifest } from './station-manifest.js';

/** Reuse the station's member projection; a token never grants additional plugin access. */
export async function memberCanUsePlugin(db: DatabaseProvider, user: AuthUser, plugin: string): Promise<boolean> {
  return (await stationManifest(db, user)).plugins.some((p) => p.id === plugin);
}
