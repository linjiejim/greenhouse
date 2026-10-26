import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/projects/api/schema.ts',
  out: './plugins/projects/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
