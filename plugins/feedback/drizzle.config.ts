import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/feedback/api/schema.ts',
  out: './plugins/feedback/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
