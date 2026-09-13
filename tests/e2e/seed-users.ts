/**
 * Seed and clean up the real internal identity used by the live-server E2E suite.
 *
 * The production auth middleware resolves every signed token back to an active
 * database user.  E2E therefore must not rely on a synthetic uid or an auth
 * bypass: this helper creates a normal super user through the database service
 * and prints its generated UUID for scripts/e2e-ci.sh to export.
 */

import { createDatabase } from '../../packages/db/src/index.js';
import { assertSafeE2eDatabase } from './database-safety.js';

const EMAIL_PREFIX = 'e2e-bootstrap-super-';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  assertSafeE2eDatabase(connectionString);

  const command = process.argv[2];
  if (command === 'check') return;

  const db = createDatabase(connectionString);
  try {
    if (command === 'seed') {
      const suffix = `${Date.now()}-${process.pid}`;
      const user = await db.users.create({
        email: `${EMAIL_PREFIX}${suffix}@test.local`,
        // The fixture authenticates only with a directly signed E2E token. An
        // invalid stored hash deliberately prevents interactive password login.
        password_hash: 'e2e-token-only-account',
        nickname: 'E2E Bootstrap Super',
        role: 'super',
      });
      try {
        await db.platform.syncLegacyRoleBinding(user.id, user.role);
      } catch (error) {
        // Do not strand an active super account when platform fixture setup
        // fails before the shell has received the id needed for its trap.
        await db.users.delete(user.id);
        throw error;
      }
      process.stdout.write(user.id);
      return;
    }

    if (command === 'cleanup') {
      const userId = process.argv[3];
      if (!userId) throw new Error('cleanup requires a user id');

      const user = await db.users.getById(userId);
      if (user?.email.startsWith(EMAIL_PREFIX)) {
        await db.users.delete(userId);
      }
      return;
    }

    throw new Error('Expected command: check | seed | cleanup <user-id>');
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`E2E identity fixture failed: ${message}\n`);
  process.exitCode = 1;
});
