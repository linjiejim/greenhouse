-- The asset library's tables (plugin `assets`). Bytes live in the plugin object store.
CREATE TABLE IF NOT EXISTS "ext_assets_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"ext" text NOT NULL,
	"original_name" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"phash" text,
	"has_preview" boolean DEFAULT false NOT NULL,
	"frame_count" integer DEFAULT 0 NOT NULL,
	"title" text,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text,
	"facets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display_title" text NOT NULL,
	"ai_status" text DEFAULT 'pending' NOT NULL,
	"ai_title" text,
	"ai_caption" text,
	"ai_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_text" text,
	"ai_facets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_people" boolean,
	"ai_model" text,
	"ai_error" text,
	"ai_attempts" integer DEFAULT 0 NOT NULL,
	"ai_started_at" timestamp with time zone,
	"ai_at" timestamp with time zone,
	"upload_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"search_a" text DEFAULT '' NOT NULL,
	"search_b" text DEFAULT '' NOT NULL,
	"search_c" text DEFAULT '' NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', search_a), 'A') || setweight(to_tsvector('simple', search_b), 'B') || setweight(to_tsvector('simple', search_c), 'C')) STORED,
	CONSTRAINT "chk_ext_assets_assets_kind" CHECK ("ext_assets_assets"."kind" IN ('image', 'video')),
	CONSTRAINT "chk_ext_assets_assets_status" CHECK ("ext_assets_assets"."status" IN ('uploading', 'active', 'invalid', 'deleted', 'purging')),
	CONSTRAINT "chk_ext_assets_assets_ai_status" CHECK ("ext_assets_assets"."ai_status" IN ('pending', 'running', 'done', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ext_assets_assets_sha256" ON "ext_assets_assets" USING btree ("sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ext_assets_assets_status_created" ON "ext_assets_assets" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ext_assets_assets_uploaded_by" ON "ext_assets_assets" USING btree ("uploaded_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ext_assets_assets_ai_queue" ON "ext_assets_assets" USING btree ("ai_status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ext_assets_assets_search" ON "ext_assets_assets" USING gin ("search_tsv");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ext_assets_uploads" (
	"asset_id" text NOT NULL REFERENCES "ext_assets_assets"("id") ON DELETE cascade,
	"user_id" text NOT NULL,
	"original_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ext_assets_uploads_asset_id_user_id_pk" PRIMARY KEY("asset_id","user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ext_assets_uploads_user" ON "ext_assets_uploads" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ext_assets_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ext_assets_collection_items" (
	"collection_id" text NOT NULL REFERENCES "ext_assets_collections"("id") ON DELETE cascade,
	"asset_id" text NOT NULL REFERENCES "ext_assets_assets"("id") ON DELETE cascade,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ext_assets_collection_items_collection_id_asset_id_pk" PRIMARY KEY("collection_id","asset_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ext_assets_collection_items_asset" ON "ext_assets_collection_items" USING btree ("asset_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ext_assets_facets" (
	"key" text PRIMARY KEY NOT NULL,
	"label_en" text NOT NULL,
	"label_zh" text NOT NULL,
	"values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"multiple" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ext_assets_similar" (
	"asset_id" text NOT NULL REFERENCES "ext_assets_assets"("id") ON DELETE cascade,
	"other_id" text NOT NULL REFERENCES "ext_assets_assets"("id") ON DELETE cascade,
	"distance" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ext_assets_similar_asset_id_other_id_pk" PRIMARY KEY("asset_id","other_id"),
	CONSTRAINT "chk_ext_assets_similar_status" CHECK ("ext_assets_similar"."status" IN ('open', 'dismissed', 'merged')),
	CONSTRAINT "chk_ext_assets_similar_order" CHECK ("ext_assets_similar"."asset_id" < "ext_assets_similar"."other_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ext_assets_similar_other" ON "ext_assets_similar" USING btree ("other_id");
