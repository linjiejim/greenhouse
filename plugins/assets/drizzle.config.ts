import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './plugins/assets/api/schema.ts',
  out: './plugins/assets/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
