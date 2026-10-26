import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/knowledge/api/schema.ts',
  out: './plugins/knowledge/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
