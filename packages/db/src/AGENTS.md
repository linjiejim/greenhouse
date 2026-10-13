# Database rules

These rules cover the v1 schema in drizzle/. v2 does not extend that chain: it starts from one fresh baseline defined in docs/product/data-model.md, and v1 data moves over per docs/product/migration-v1.md.

## Layout and services
- PostgreSQL only, via DATABASE_URL (local default postgresql://greenhouse:greenhouse@localhost:5432/greenhouse; `docker compose up -d postgres` binds 127.0.0.1:5432).
- Tables live in `schema/<domain>.ts` (exported from schema/index.ts), services in `services/<domain>.ts`, assembled in provider.ts. drizzle.config.ts and drizzle/ sit at the repo root.
- Business code (routes, tools, CLI) reaches the database only through domain services on getDb() (db.users.getById(...)) and never writes SQL.
- A service is a factory createXxxService(db: Db) returning an object literal; self-calls use `const service = {...}; return service;`, never `this`.
- Types are inferred, never mirrored: `DatabaseProvider = ReturnType<typeof createDatabase>`, row types are `typeof table.$inferSelect` at the bottom of the schema file.
- String unions use `text('col', { enum: [...] })`; input types sit beside the service; everything is re-exported from @greenhouse/db.
- No repository classes, interface mirrors or multi-backend layers.
- Use the `sql` template for FTS, aggregates and complex joins. Raw execute() returns COUNT and SUM as strings: wrap them in Number().

## Columns and keys
- Timestamps are `timestamp(name, { withTimezone: true, mode: 'string' })`, written with nowIso(). Date-only fields (due_date, start_date) stay TEXT in YYYY-MM-DD.
- Every table declares its indexes explicitly.
- Owned children within a domain use .references() with onDelete cascade or set null. Audit, log, stats and cross-domain references get no FK so history outlives its subject; db-schema.md records them as logical links.
- JSON stored as text is NOT NULL with default '[]' or '{}'. Columns where null means something (messages.reasoning, knowledge_base._enriched_at) stay nullable.
- Move a column to jsonb only for a real query need, one column at a time (USING col::jsonb, every read and write path, `.$type<T>()`).
- Credentials go into encrypted columns (`*_encrypted`, `*_enc`) and nothing else does: connection settings stay plaintext, and stored URLs never embed credentials.

## Migrations
- The chain in drizzle/ (SQL files, meta/_journal.json, meta/NNNN_snapshot.json) is the only schema truth. Shared or persistent databases get migrate only, never push; push is for throwaway scratch databases.
- Flow: edit `schema/*.ts`, run `pnpm drizzle-kit generate` at the repo root (`pnpm --filter @greenhouse/db exec` breaks the relative paths), review the SQL, commit it with the code. CI and deploys run migrate; locally run it only with an explicit DATABASE_URL (root AGENTS.md).
- Review generated SQL for type changes without USING, NOT NULL without DEFAULT on populated tables, renames emitted as drop plus add (rewrite as RENAME or data is lost), and backfills you must add by hand.
- Never hand-write a migration that alters a table the chain never created.
- Every journal entry needs its snapshot, hand-written migrations (`drizzle-kit generate --custom`) included, because generate diffs only against the latest snapshot. Check the chain with `pnpm drizzle-kit check`.
- migrate applies only entries newer than the last applied created_at and never compares hashes. After rebasing onto new migrations, delete yours and generate it again.
- drizzle-kit 0.31 migrate hides the failing statement: rerun with CI=true, or feed the SQL to `psql -v ON_ERROR_STOP=1`.
- applyCoreMigrations (core-migrations.ts, behind MIGRATE_ON_START=1) is drizzle's own migrator under an advisory lock: keep it interchangeable with drizzle-kit migrate and never let it generate DDL.
- Adopt an existing database with `pnpm cli db baseline`, always with --dry-run first; --through stops short of the chain's end.
- A fresh test database gets extension tables from `DATABASE_URL=<url> pnpm tsx scripts/apply-ext-migrations.mjs`.
- Every table, column, index or relationship change updates db-schema.md, marking FK CASCADE or SET NULL versus logical links.
- New table: schema plus Row type, createXxxService in services/, one line in provider.ts, `export * from './services/xxx.js'` in index.ts, a reviewed migration, db-schema.md, a `*.db.test.ts`.

## Tests
- The rollback transaction of a `*.db.test.ts` starts in beforeEach: call initDatabase() there, never in beforeAll or at module scope, or its writes commit.
- Service transactions nest as savepoints on the provider; never open a separate connection.
- Assert only on rows the test created. Other connections' committed rows stay visible, so never expect a table to hold exactly N rows.
- Sequences do not roll back: never assume an id or update by a fixed one.
- Never call resetSchema(); the project truncates once at startup and bootstraps platform roles. Create users inside the test with tests/helpers/internal-user.ts.
- Use `*.db-commit.test.ts` only for multi-connection visibility, DDL or lock races; there, use unique keys per run, targeted cleanup and no global counts.

## Invariants
- Filter visibility in SQL before LIMIT, cursors and COUNT, never on a fetched page: readerUserId for knowledge, sessionVisibleTo and runtimeVisibleTo (bots-privacy.ts) for sessions and runtime.
- Bots-derived sessions and runtime records stay owner-only even after their session is deleted; never decide that by joining live sessions.
- Decide conversation visibility with visibleTo(userId) (rooms by participation), never with eq(botConversations.user_id, ...).
- The `public: true` option of ensureDirectConversation, createTaskConversation and createAgentMessage skips ownership checks. Pass it only after the API authorized the public Agent.
- A Bots conversation has one writer, the engine holding its run. Anything else produced mid-turn goes to bot_inbox, never addMessage; the engine appends with sessions.appendIfTail.
- MemoryScope is required by listForIndex, search and getOwnedInScope. Fetch a memory by id only through getOwnedInScope, or one Agent can read another's private memories.
- user_memories.status is the truth: decay and consolidation change status, and only a member's manual delete removes rows. touch() runs on real use (recall, update), never on prompt injection.
- sessions.sessionReferencesImage() is the authorization check for an image id a model names; every conversation-file read path uses it.
- bot_versions are immutable: createBot writes v1, updateBot appends; never update or delete a version.
- bot_computers state changes are version CAS under withComputerLock or withCapacityLock (two API slots share the table). Recheck lease_epoch before returning an observation.
- Vault services store ciphertext as given and return metadata only (VaultItemView). Create the id with newVaultItemId() before encrypting; it is part of the AAD.
- bot_requests settle once through settleRequest (CAS from pending); payloads never hold secrets.
- Reset passwords only through users.resetPasswordAndRevokeSessions(), which changes the password, auth_version and refresh tokens in one transaction. Access, refresh and WebSocket checks compare auth_version.
- account_password_links store only token hashes. Lock the user row before link rows, and consume a link in one transaction that checks purpose, status, expiry and generation.
- OAuth codes and tokens are stored as SHA-256 hashes only and never share rows with api_clients keys. Scope columns hold exactly what was granted and are never widened on read.
- Revoking an OAuth grant, disabling a client or changing scopes revokes the affected tokens in the same transaction.
- The FTS index idx_kb_fts_seg (drizzle/0013_kb_fts_index.sql) must match weightedTsVector in services/knowledge-base.ts byte for byte.
- Every knowledge_base write recomputes the `_tokens_*` columns with segmentForFts, the same tokenizer queries use.
- search, searchShared, searchLike and searchSharedLike change together: same folder filters (empty folderIds = no rows, empty excludeFolderIds = no exclusion) and the same columns, folder_id included.
- Folder operations never delete documents (knowledge_base.folder_id is SET NULL). Backlinks pass each row through resolveKbAccess. kb_comments never enter search.
- Manual ordering (reorderFolders, reorderDocs) writes a whole sibling group in one statement, never a per-row loop.
- Tables soft-delete at three levels (table_bases.archived_at, table_tables.archived_at, table_records.deleted_at). New read paths filter them; getRecordById deliberately does not.
- A skill with scanned_at IS NULL was never scanned: never mark it clean. setScanResult never touches updated_at, the list sort key.
- Usage budget: reserve before provider I/O and settle after; release only when I/O never started; an expired reservation counts as spent.
- The usage ledger is append-only, accounts lock in id order, and missing or disabled accounts fail closed.
- Runtime records are permanent (no delete, TTL or truncation). runtime_events is append-only, delivery state lives only in runtime_outbox, and each state change appends its event and outbox row in the same transaction.
- Real tool calls start only through runtime.beginToolCallWithAuthority(); a running call whose worker is lost becomes uncertain and is never replayed. Admission limits use createRun options, never in-process sets.
- notifications are permanent and idempotent on (user_id, dedupe_key); only read_at changes. Delivery attempts never write business state back.
- Push devices are deactivated, never deleted. isDeliverable() and its SQL twin listDeliverable() change together; a delivery that fails its pre-send recheck settles as suppressed, not dead_letter.
