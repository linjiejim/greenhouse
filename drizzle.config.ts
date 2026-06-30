import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/db/src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse',
  },
});
