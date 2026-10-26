# Memory plugin

- Production API imports use `@greenhouse/api/extension-kit`; web imports use `@greenhouse/web/extension-kit`.
- Own tables and row types live in `api/schema.ts`; services in `api/db/`, reached through `api/services.ts`.
- Preserve existing URLs, tool ids, guards and payloads. Disabled means no registration; data stays in place.
- Add migrations after `0001_adopt.sql`; never edit applied SQL. Drizzle config is run from the repository root with an explicit test/dev DATABASE_URL.
- Copy belongs under `ext.memory.*`; browser specs live in `e2e/` and import only `@playwright/test`.
