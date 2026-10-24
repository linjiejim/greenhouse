-- A small Greenhouse 1.6 dataset for the migrate-from-1x tests. Applied on top of
-- the archived 1.x chain (drizzle/archive-1x). Covers every carried domain plus
-- the edge cases the carry must report: expired credentials, old run events,
-- delivered outbox, retired tables, group shares, pins, numeric table ids inside
-- JSON, NUL escapes, bad dates and an extension table with a serial id + FK.
-- "now" for the tests is 2026-10-25T00:00:00Z.

INSERT INTO platform_organizations (id, code, name, created_at, updated_at) VALUES ('default', 'default', 'Greenhouse', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z') ON CONFLICT DO NOTHING;

INSERT INTO users (id, email, password_hash, auth_version, nickname, role, status, daily_message_limit, monthly_token_limit, notes, locale, created_at, updated_at) VALUES
  ('u-ann', 'ann@example.test', 'scrypt$x', 2, 'Ann', 'super', 'active', 200, 20000000, 'likes bullets', 'zh', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
  ('u-bob', 'bob@example.test', 'scrypt$y', 0, 'Bob', 'team', 'active', 200, 20000000, NULL, 'en', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z');

INSERT INTO platform_user_workbench_preferences (org_id, user_id, preferences, created_at, updated_at) VALUES
  ('default', 'u-ann', '{"version":1,"cards":[]}', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');
INSERT INTO user_features (id, user_id, feature, enabled, config, granted_by, created_at, updated_at) VALUES
  (1, 'u-bob', 'memory', false, '{}', 'u-ann', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');
INSERT INTO user_tools (user_id, tool_id, assigned_by, assigned_at) VALUES ('u-bob', 'web_search', 'u-ann', '2026-02-01T00:00:00Z');
INSERT INTO refresh_tokens (id, user_id, token_hash, auth_version, expires_at, created_at) VALUES
  ('rt-live', 'u-ann', 'h1', 2, '2026-11-30T00:00:00Z', '2026-10-20T00:00:00Z'),
  ('rt-old', 'u-ann', 'h2', 2, '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO rate_limit_buckets (key, count, expires_at) VALUES ('login:x:1', 3, '2026-10-26T00:00:00Z');

INSERT INTO platform_roles (id, org_id, code, name, system_protected, created_at, updated_at) VALUES
  ('r-super', 'default', 'super', 'Super', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('r-team', 'default', 'team', 'Team', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO platform_role_bindings (role_id, user_id, created_at) VALUES ('r-super', 'u-ann', '2026-01-01T00:00:00Z'), ('r-team', 'u-bob', '2026-01-01T00:00:00Z');
INSERT INTO platform_role_capabilities (role_id, capability, created_at) VALUES ('r-team', 'crm.*', '2026-01-01T00:00:00Z');
INSERT INTO platform_role_entity_policies (id, role_id, app_id, module_id, entity_id, scopes, field_policies, created_at, updated_at) VALUES
  ('p1', 'r-team', 'crm', 'customer', 'company', '[{"kind":"own"}]', '{"name":{"read":"full","write":true,"export":false}}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO platform_user_capability_overrides (org_id, user_id, capability, effect, created_at, updated_at) VALUES
  ('default', 'u-bob', 'crm.customer.export', 'deny', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

INSERT INTO platform_oauth_clients (id, client_name, redirect_uris, allowed_scopes, created_at, updated_at) VALUES
  ('c-claude', 'Claude Code', '["http://localhost/cb"]', '["mcp:read","mcp:write"]', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');
INSERT INTO platform_oauth_grants (id, user_id, client_id, resource, scopes, created_at, updated_at) VALUES
  ('g1', 'u-bob', 'c-claude', 'http://x/mcp', '["mcp:read","mcp:knowledge"]', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');
INSERT INTO platform_oauth_tokens (id, grant_id, token_hash, token_type, resource, scopes, expires_at, created_at) VALUES
  ('t-live', 'g1', 'th1', 'refresh', 'http://x/mcp', '["mcp:read"]', '2026-12-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ('t-dead', 'g1', 'th2', 'access', 'http://x/mcp', '["mcp:read"]', '2026-10-01T01:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO user_provider_tokens (id, user_id, provider, access_token, metadata, created_at, updated_at) VALUES
  (1, 'u-bob', 'feishu', 'v1:cipher', '{"open_id":"ou_1"}', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');

INSERT INTO sessions (id, title, user_id, channel, rating, feedback, metadata, created_at, updated_at) VALUES
  ('s-ann', 'Ann chat', 'u-ann', 'web', 5, 'good', '{"task_id":7}', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
  ('s-bob', 'Bob chat', 'u-bob', 'web', NULL, NULL, '{}', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z');
INSERT INTO messages (id, session_id, role, content, references_, pipeline, images, confidence, seq, created_at) VALUES
  ('m1', 's-ann', 'user', 'hello', '[]', '[]', '["img-1"]', NULL, 1, '2026-10-01T00:00:00Z'),
  ('m2', 's-ann', 'assistant', 'hi', '[{"doc_id":1}]', '[{"type":"tool","output":"bad\u0000byte"}]', '[]', 0.8, 2, '2026-10-01T00:00:01Z');
INSERT INTO session_shares (id, session_id, shared_with, shared_by, created_at) VALUES (1, 's-ann', 'u-bob', 'u-ann', '2026-10-02T00:00:00Z');
INSERT INTO session_share_reads (id, session_id, user_id, read_at) VALUES (1, 's-ann', 'u-bob', '2026-10-02T01:00:00Z');
INSERT INTO session_groups (id, user_id, name, kind, created_at, updated_at) VALUES
  (1, 'u-ann', 'Pinned', 'pinned', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  (2, 'u-bob', 'Pinned', 'pinned', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  (3, 'u-bob', 'Old folder', 'custom', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO session_group_members (id, user_id, group_id, session_id, kind, sort_order, created_at) VALUES
  (1, 'u-ann', 1, 's-ann', 'pinned', 1, '2026-10-05T00:00:00Z'),
  (2, 'u-bob', 2, 's-ann', 'pinned', 0, '2026-10-06T00:00:00Z'),
  (3, 'u-bob', 3, 's-bob', 'custom', 0, '2026-10-06T00:00:00Z');
INSERT INTO chat_files (id, session_id, name, content_type, size, storage_key, source, created_by, created_at) VALUES
  ('cf-1', 's-ann', 'a.pdf', 'application/pdf', 10, 'chat/a.pdf', 'user', 'u-ann', '2026-10-01T00:00:00Z');
INSERT INTO llm_calls (id, session_id, user_id, model, input, output, status, created_at) VALUES
  ('lc-1', 's-ann', 'u-ann', 'flash', 'prompt', 'answer', 'ok', '2026-10-01T00:00:00Z');

INSERT INTO drive_folders (id, scope, parent_id, name, visibility, owner_user_id, created_at, updated_at) VALUES
  (1, 'kb', NULL, 'Team', 'team', NULL, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z'),
  (2, 'kb', 1, 'Child', 'team', NULL, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z');
INSERT INTO drive_folders (id, scope, parent_id, name, owner_key, created_at, updated_at) VALUES
  (3, 'crm', NULL, 'Acme', '42', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z');
INSERT INTO drive_files (id, scope, folder_id, name, cos_key, content_type, size, status, visibility, created_at, updated_at) VALUES
  (1, 'kb', 2, 'spec.docx', 'drive/kb/1', 'application/x', 100, 'active', 'team', '2026-04-02T00:00:00Z', '2026-04-02T00:00:00Z');
INSERT INTO drive_files (id, scope, folder_id, name, cos_key, size, status, owner_key, uploaded_by, created_at, updated_at) VALUES
  (2, 'crm', 3, 'contract.pdf', 'drive/crm/2', 50, 'active', '42', 'u-bob', '2026-04-02T00:00:00Z', '2026-04-02T00:00:00Z');

INSERT INTO knowledge_base (id, doc_id, title, content, content_json, tags, meta, folder_id, _tokens_a, _questions, created_at, updated_at) VALUES
  (1, 'doc-a', 'Guide', 'See #/projects/1', '{}', '["ops"]', '{"space":"general"}', 2, 'guide ops', '["how?"]', '2026-04-03T00:00:00Z', NULL),
  (2, 'doc-b', 'Private', 'x', '{}', '[]', '{}', NULL, '', '[]', NULL, NULL);
UPDATE knowledge_base SET visibility = 'private', owner_user_id = 'u-bob' WHERE id = 2;
INSERT INTO knowledge_base_versions (id, doc_id, version, title, content, created_at) VALUES (1, 1, 1, 'Guide', 'v1', '2026-04-03T00:00:00Z');
INSERT INTO knowledge_base_shares (id, doc_id, shared_with, role, shared_by, created_at) VALUES
  (1, 2, 'u-ann', 'reader', 'u-bob', '2026-04-04T00:00:00Z'),
  (2, 2, 'group:3', 'reader', 'u-bob', '2026-04-04T00:00:00Z');
INSERT INTO kb_comments (id, doc_id, author_user_id, content, created_at) VALUES (1, 1, 'u-bob', 'nice', '2026-04-05T00:00:00Z');

INSERT INTO table_bases (id, name, owner_id, created_by, created_at, updated_at) VALUES (1, 'CRM', 'u-ann', 'u-ann', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z');
INSERT INTO table_base_members (id, base_id, user_id, role, added_by, created_at, updated_at) VALUES (1, 1, 'u-bob', 'editor', 'u-ann', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z');
INSERT INTO table_tables (id, base_id, name, created_by, created_at, updated_at) VALUES (1, 1, 'Deals', 'u-ann', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z');
INSERT INTO table_fields (id, table_id, name, type, is_primary, config, created_by, created_at, updated_at) VALUES
  (1, 1, 'Name', 'text', true, '{}', 'u-ann', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
  (2, 1, 'Related', 'relation', false, '{"relation":{"targetTableId":1,"multiple":true}}', 'u-ann', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
  (3, 1, 'Files', 'attachment', false, '{}', 'u-ann', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z');
INSERT INTO table_views (id, table_id, name, config, created_by, created_at, updated_at) VALUES
  (1, 1, 'Grid', '{"fieldIds":[1,2],"query":{"sort":[{"fieldId":1,"direction":"asc"}]}}', 'u-ann', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z');
INSERT INTO table_records (id, table_id, values, created_by, updated_by, created_at, updated_at) VALUES
  (1, 1, '{"1":"Acme","2":[2],"3":[1]}', 'u-ann', 'u-ann', '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z'),
  (2, 1, '{"1":"Beta"}', 'u-ann', 'u-ann', '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z');
INSERT INTO table_record_links (id, field_id, source_record_id, target_record_id, created_by, created_at) VALUES (1, 2, 1, 2, 'u-ann', '2026-05-02T00:00:00Z');
INSERT INTO table_record_attachments (id, record_id, field_id, drive_file_id, created_by, created_at) VALUES (1, 1, 3, 1, 'u-ann', '2026-05-02T00:00:00Z');
INSERT INTO table_dashboards (id, base_id, name, created_by, created_at, updated_at) VALUES (1, 1, 'Board', 'u-ann', '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z');

INSERT INTO projects (id, title, owner_id, start_date, end_date, created_by, created_at, updated_at) VALUES
  (1, 'Launch', 'u-ann', '2026-06-01', 'June 30', 'u-ann', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z');
INSERT INTO project_members (id, project_id, user_id, role, added_by, created_at) VALUES (1, 1, 'u-bob', 'member', 'u-ann', '2026-06-01T00:00:00Z');
INSERT INTO tasks (id, project_id, parent_id, title, due_date, tags, dependencies, created_by, created_at, updated_at) VALUES
  (1, 1, NULL, 'Plan', '2026-06-10', '["p1"]', '[]', 'u-ann', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'),
  (2, 1, 1, 'Do', NULL, '[]', '[1]', 'u-ann', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z');
INSERT INTO task_comments (id, task_id, user_id, content, created_at) VALUES (1, 2, 'u-bob', 'ok', '2026-06-02T00:00:00Z');
INSERT INTO project_activities (id, project_id, task_id, user_id, action, detail, created_at) VALUES (1, 1, 2, 'u-ann', 'task_created', 'Do', '2026-06-01T00:00:00Z');

INSERT INTO platform_audit_events (id, org_id, actor_id, actor_type, request_id, app_id, action_id, capability, result, summary, created_at) VALUES
  ('a1', 'default', 'u-ann', 'human', 'r1', 'knowledge', 'updateDocument', 'knowledge.document.update', 'success', '{"id":1}', '2026-07-01T00:00:00Z');
INSERT INTO email_send_log (id, user_id, account_scope, from_address, subject, recipients, origin, status, created_at) VALUES
  (1, 'u-ann', 'shared', 'gh@example.test', 'Hi', '["x@example.test"]', 'chat', 'sent', '2026-07-01T00:00:00Z');
INSERT INTO api_audit_log (id, app_id, endpoint, method, user_id, channel, meta, created_at) VALUES
  (1, 'mcp', '/api/mcp', 'POST', 'u-bob', 'a2a', '{}', '2026-10-20T00:00:00Z'),
  (2, 'mcp', '/api/mcp', 'POST', 'u-bob', 'a2a', '{}', '2026-08-01T00:00:00Z');

INSERT INTO feature_requests (id, title, description, submitted_by, created_at, updated_at) VALUES (1, 'Dark mode', 'please', 'u-bob', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
INSERT INTO tool_frictions (id, fingerprint, tool_id, kind, summary, sample_sessions, first_seen_at, last_seen_at, created_at, updated_at) VALUES
  (1, 'fp1', 'web_search', 'tool_error', 'timeouts', '["s-ann"]', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z');

INSERT INTO scheduled_tasks (id, user_id, name, task_prompt, schedule, notify_webhook, notify_email, notify_feishu, unattended_tools, created_at, updated_at) VALUES
  (7, 'u-ann', 'Digest', 'summarize', '0 9 * * *', 'https://hook.example.test', true, true, '["knowledge_mutation"]', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
INSERT INTO custom_profiles (id, slug, user_id, name, tools, system_prompt, avatar, forked_from, current_version, lifecycle_status, created_at, updated_at) VALUES
  (3, 'researcher', 'u-bob', 'Researcher', '["web_search"]', 'be thorough', '{"plant":"fern"}', 'researcher', 2, 'pilot', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z');
INSERT INTO custom_profile_versions (id, profile_id, version, manifest_hash, name, tools, system_prompt, purpose, risk_level, budget_policy, created_at) VALUES
  (1, 3, 1, 'h1', 'Researcher', '[]', 'v1', NULL, 'low', '{}', '2026-08-01T00:00:00Z'),
  (2, 3, 2, 'h2', 'Researcher', '["web_search"]', 'be thorough', 'research', 'high', '{"monthly_usd":5}', '2026-08-02T00:00:00Z');

INSERT INTO runtime_runs (id, kind, owner_user_id, initiated_by_user_id, root_run_id, source_kind, source_id, status, input, created_at, updated_at) VALUES
  ('run-old', 'automation', 'u-ann', 'u-ann', 'run-old', 'scheduled_task', '7', 'succeeded', '{"task_id":7}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  ('run-live', 'chat', 'u-ann', 'u-ann', 'run-live', 'chat_turn', 'm2', 'running', '{}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
INSERT INTO runtime_events (id, run_id, seq, type, payload, created_at) VALUES
  ('e-old', 'run-old', 1, 'run.created', '{}', '2026-08-01T00:00:00Z'),
  ('e-old-pending', 'run-old', 2, 'run.settled', '{}', '2026-08-01T00:00:01Z'),
  ('e-live', 'run-live', 1, 'run.created', '{}', '2026-08-01T00:00:00Z'),
  ('e-new', 'run-old', 3, 'note', '{"x":1}', '2026-10-20T00:00:00Z');
INSERT INTO runtime_outbox (id, event_id, topic, payload, status, available_at, delivered_at, created_at, updated_at) VALUES
  ('o-done', 'e-new', 'runtime.events', '{}', 'delivered', '2026-10-20T00:00:00Z', '2026-10-20T00:00:01Z', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z'),
  ('o-wait', 'e-old-pending', 'runtime.events', '{}', 'pending', '2026-08-01T00:00:00Z', NULL, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
INSERT INTO runtime_artifacts (id, run_id, direction, kind, name, status, source, created_at, updated_at) VALUES
  ('art-1', 'run-old', 'output', 'file', 'out.csv', 'available', 'tool', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
INSERT INTO scheduled_task_runtime_occurrences (runtime_run_id, task_id, owner_user_id, status, runtime_version, scheduled_for, run_created_at, projected_at) VALUES
  ('run-old', 7, 'u-ann', 'succeeded', 3, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

INSERT INTO notifications (id, user_id, kind, title, body, payload, dedupe_key, created_at) VALUES
  ('n1', 'u-ann', 'system', 'Hi', 'body', '{"url":"#/x"}', 'k1', '2026-09-01T00:00:00Z');
INSERT INTO notification_delivery_attempts (id, notification_id, channel, recipient, status, available_at, created_at, updated_at) VALUES
  ('d1', 'n1', 'feishu', 'ou_1', 'delivered', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');

INSERT INTO llm_usage (id, profile_id, caller, user_id, model, input_tokens, output_tokens, cost_usd_micros, price_applied, created_at) VALUES
  (1, 'team', 'chat', 'u-ann', 'flash', 100, 20, 30, '{"source":"config"}', '2026-10-01T00:00:00Z');
INSERT INTO service_usage (id, user_id, service, provider, units, unit_kind, metadata, created_at) VALUES
  ('svu-1', 'u-ann', 'web_search', 'tavily', 1, 'call', '{"q":1}', '2026-10-01T00:00:00Z');
INSERT INTO usage_budget_accounts (id, scope_type, scope_id, unit, period_start, period_end, limit_units, spent_units, created_at, updated_at) VALUES
  ('uba-user', 'user', 'u-ann', 'tokens', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 1000, 120, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ('uba-usd', 'user', 'u-ann', 'usd_micros', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 5000000, 30, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO usage_budget_ledger (id, account_id, operation_key, entry_type, delta_spent_units, reserved_units_after, spent_units_after, created_at) VALUES
  (1, 'uba-user', 'op1', 'settle', 120, 0, 120, '2026-10-01T00:00:00Z'),
  (2, 'uba-usd', 'op2', 'settle', 30, 0, 30, '2026-10-01T00:00:00Z');
INSERT INTO usage_budget_limits (id, scope_type, scope_id, limit_units, created_at, updated_at) VALUES ('ubl_x', 'organization', 'default', 100000000, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO usage_price_overrides (id, kind, target, input_per_mtok, created_at, updated_at) VALUES ('upo_x', 'model', 'flash', 0.5, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO usage_counters (day, kind, key, client, count, updated_at) VALUES ('2026-10-01', 'tool_call', 'web_search', 'mcp', 4, '2026-10-01T00:00:00Z');

INSERT INTO email_accounts (id, user_id, email_address, imap_host, imap_port, smtp_host, smtp_port, username, password_encrypted, created_at, updated_at) VALUES
  (1, 'u-ann', 'ann@mail.test', 'imap.test', 993, 'smtp.test', 465, 'ann', 'v1:secret', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO agent_skills (id, name, display_name, description, tags, latest_version, owner_user_id, created_at, updated_at) VALUES
  (1, 'pdf-tools', 'PDF tools', 'pdfs', '["pdf"]', '1.0.0', 'u-ann', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO agent_skill_versions (id, skill_id, version, changelog, file_count, size_bytes, content_hash, storage_key, created_by, created_at) VALUES
  (1, 1, '1.0.0', 'first', 2, 10, 'hash', 'skills/1', 'u-ann', '2026-09-01T00:00:00Z');
INSERT INTO user_prompts (id, user_id, title, content, variables, created_at, updated_at) VALUES (1, 'u-ann', 'Weekly', 'do it', '[{"name":"x"}]', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO user_memories (id, user_id, title, content, status, superseded_by, created_at, updated_at) VALUES
  (1, 'u-ann', 'old', 'a', 'superseded', NULL, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (2, 'u-ann', 'new', 'b', 'active', NULL, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z');
UPDATE user_memories SET superseded_by = 2 WHERE id = 1;
INSERT INTO workspace_settings (key, value, updated_at) VALUES ('branding.product_name', '"Greenhouse"', '2026-09-01T00:00:00Z');
INSERT INTO eval_datasets (id, category, question, ground_truth, created_at, updated_at) VALUES (1, 'x', 'q', 'a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- An extension table the way a private extension's migration lane creates it.
CREATE TABLE crm_companies (id serial PRIMARY KEY, name text NOT NULL, owner_user_id text, drive_folder_id integer, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_contacts (id serial PRIMARY KEY, company_id integer NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE, email text);
CREATE INDEX idx_crm_contacts_email ON crm_contacts (email);
INSERT INTO crm_companies (id, name, owner_user_id, drive_folder_id) VALUES (42, 'Acme', 'u-bob', 3);
SELECT setval('crm_companies_id_seq', 42);
INSERT INTO crm_contacts (company_id, email) VALUES (42, 'a@acme.test');
CREATE TABLE IF NOT EXISTS extension_migrations (extension_id text NOT NULL, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (extension_id, name));
INSERT INTO extension_migrations (extension_id, name, checksum) VALUES ('crm', '0001_baseline.sql', 'abc');
