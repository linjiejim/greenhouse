import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/skills/api/schema.ts',
  out: './plugins/skills/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
