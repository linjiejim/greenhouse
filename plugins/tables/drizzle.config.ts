import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/tables/api/schema.ts',
  out: './plugins/tables/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
