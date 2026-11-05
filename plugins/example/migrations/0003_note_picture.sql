-- A note may carry one picture, stored in the plugin's object namespace at notes/<id>/picture.
ALTER TABLE "ext_example_notes" ADD COLUMN IF NOT EXISTS "picture_type" text;
