import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/reports/api/schema.ts',
  out: './plugins/reports/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
