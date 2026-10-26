import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/computer/api/schema.ts',
  out: './plugins/computer/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
