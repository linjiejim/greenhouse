CREATE TABLE ext_example_should_roll_back (id text PRIMARY KEY);
--> statement-breakpoint
SELECT * FROM ext_example_missing_table;
