-- A 3.x install that was carried from 1.x and runs a private overlay (load after plugin-upgrade-v3.sql):
-- legacy CHECK values only carried rows hold, a completed carry marker, and overlay plugin lanes.
INSERT INTO users (id,email,password_hash,nickname,role,status) VALUES ('carried-external','carried-external@example.test','EXTERNAL_ACCOUNT_RETIRED_NOLOGIN','Carried external','external','disabled');
INSERT INTO request_log (id,app_id,endpoint,method,channel) VALUES ('carried-log-api','legacy','/api/legacy','POST','api'),('carried-log-relay','legacy','/relay','POST','relay');
INSERT INTO runs (id,kind,status,owner_user_id,initiated_by_user_id,root_run_id,source_kind,source_id) VALUES
  ('carried-run-workflow','workflow','succeeded','upgrade-user','upgrade-user','carried-run-workflow','workflow','carried-workflow'),
  ('carried-run-mission','mission','canceled','upgrade-user','upgrade-user','carried-run-mission','mission','carried-mission'),
  ('carried-run-subagent','subagent','succeeded','upgrade-user','upgrade-user','carried-run-subagent','session','carried-subagent'),
  ('carried-run-eval','eval','failed','upgrade-user','upgrade-user','carried-run-eval','eval','carried-eval');
INSERT INTO budgets (id,kind,scope_type,scope_id,limit_units) VALUES ('carried-budget-agent','limit','agent','carried-agent',1000),('carried-budget-run','limit','run','carried-run',1000),('carried-budget-eval','limit','eval','carried-eval',1000);
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE drizzle.greenhouse_carry (id integer PRIMARY KEY CHECK (id = 1), source_version text, started_at timestamptz NOT NULL, completed_at timestamptz);
INSERT INTO drizzle.greenhouse_carry (id, source_version, started_at, completed_at) VALUES (1, '0013_report_templates', '2026-09-15T00:00:00Z', '2026-09-15T00:10:00Z');
CREATE TABLE IF NOT EXISTS extension_migrations (extension_id text NOT NULL, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (extension_id, name));
CREATE TABLE crm_accounts (id text PRIMARY KEY, name text NOT NULL, owner_user_id text REFERENCES users(id) ON DELETE SET NULL);
INSERT INTO crm_accounts (id,name,owner_user_id) VALUES ('carried-crm-account','Carried account','upgrade-user');
CREATE TABLE sellfox_orders (id serial PRIMARY KEY, crm_account_id text REFERENCES crm_accounts(id) ON DELETE CASCADE, total integer NOT NULL);
INSERT INTO sellfox_orders (crm_account_id,total) VALUES ('carried-crm-account',42);
INSERT INTO extension_migrations (extension_id,name,checksum,applied_at) VALUES
  ('crm','0001_init.sql','overlay-crm-checksum','2026-09-15T00:20:00Z'),
  ('crm','0002_v1_pipeline.sql','overlay-crm-1x-checksum','2026-09-15T00:20:00Z'),
  ('sellfox','0001_init.sql','overlay-sellfox-checksum','2026-09-15T00:20:00Z');
