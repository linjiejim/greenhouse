ALTER TABLE "feishu_message_receipts" ADD COLUMN "logical_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feishu_receipts_logical" ON "feishu_message_receipts" USING btree ("logical_key");