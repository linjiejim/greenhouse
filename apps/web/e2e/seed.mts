/**
 * Resets the browser-test database and seeds two members. Refuses any database whose name
 * does not end in _e2e, so it can never wipe a real one.
 *   node --import tsx apps/web/e2e/seed.mts
 */

import { applyMigrations, createDbClient, members, newId } from '../../../packages/db/src/index.ts';
import { hashPassword } from '../../api/src/auth/password.ts';
import { E2E, PEOPLE } from './env.ts';

const url = new URL(E2E.databaseUrl);
const name = url.pathname.slice(1);
if (!name.endsWith('_e2e')) throw new Error(`Refusing to reset ${name}: browser-test databases end in _e2e`);

const admin = new URL(url);
admin.pathname = '/postgres';
const server = createDbClient(admin.toString());
await server.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await server.sql.unsafe(`CREATE DATABASE "${name}"`);
await server.close();

await applyMigrations(E2E.databaseUrl);
const client = createDbClient(E2E.databaseUrl);
for (const person of Object.values(PEOPLE)) {
  await client.db.insert(members).values({
    id: newId('member'),
    email: person.email,
    name: person.name,
    role: person.role,
    status: 'active',
    passwordHash: await hashPassword(person.password),
  });
}
await client.close();
console.log(`seeded ${name}`);
