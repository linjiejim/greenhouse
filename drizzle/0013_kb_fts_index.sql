-- knowledge_base full-text search: the GIN expression index packages/db/src/AGENTS.md documents
-- (`idx_kb_fts_seg`) was never created by any migration, so every search scanned the table.
-- The expression matches `weightedTsVector` in packages/db/src/services/knowledge-base.ts
-- byte-for-byte (same weights, same 'simple' config), which is what lets the planner use it.
CREATE INDEX IF NOT EXISTS "idx_kb_fts_seg" ON "knowledge_base" USING gin (
  (
    setweight(to_tsvector('simple', "_tokens_a"), 'A') ||
    setweight(to_tsvector('simple', "_tokens_b"), 'B') ||
    setweight(to_tsvector('simple', "_tokens_c"), 'C')
  )
);
