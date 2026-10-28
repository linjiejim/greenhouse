-- Card receipts preserve plugin kinds on reads; active registrations validate new claims.
ALTER TABLE "card_action_receipts" DROP CONSTRAINT IF EXISTS "chk_card_action_receipts_kind";
