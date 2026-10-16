import { defineConfig } from 'drizzle-kit';

// No fallback URL: a bare `drizzle-kit migrate` in a worktree must never reach a shared database.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL for drizzle-kit (for example the v2 dev or test database)');

export default defineConfig({
  schema: './packages/db/src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
});
