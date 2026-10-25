-- 3.0 drops the home workbench; strip the stored layout so the strict preferences schema never meets it.
UPDATE "users" SET "preferences" = "preferences" - 'workbench' WHERE "preferences" ? 'workbench';
