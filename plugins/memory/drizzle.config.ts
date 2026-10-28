import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/memory/api/schema.ts',
  out: './plugins/memory/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
