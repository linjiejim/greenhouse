/**
 * Apply the extension migration lane to the database in DATABASE_URL.
 *
 * Core migrations are drizzle-kit's job; this covers the extensions' own lane,
 * which normally runs at boot. Handy for a test database that no server has
 * started against yet.
 */
import { initDatabase } from '@greenhouse/db';
import { applyExtensionMigrations } from '../apps/api/src/extensions/boot.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = await initDatabase({ type: 'pg', pgConnectionString: url });
await applyExtensionMigrations(db);
console.log(`extension migrations applied to ${new URL(url).pathname.slice(1)}`);
await db.close();
