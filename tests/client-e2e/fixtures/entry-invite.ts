/**
 * Client e2e fixture (tests/client-e2e/entry.e2e.ts): an invited account and its one-time
 * activation token on DATABASE_URL, printed as JSON for the spec. The token is what the
 * invitation mail would carry (apps/api/src/security/account.ts); it never leaves the test run.
 */
import { initDatabase, UNSET_ACCOUNT_PASSWORD_HASH } from '../../../packages/db/src/index.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = await initDatabase({ type: 'pg', pgConnectionString: url });
try {
  const email = `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const user = await db.users.create({
    email,
    password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
    nickname: 'Invitee',
    role: 'team',
    status: 'invited',
  });
  const issued = await db.accountPasswordLinks.issueInvite(user.id, user.id);
  process.stdout.write(JSON.stringify({ email, token: issued.token }));
} finally {
  await db.close();
}
