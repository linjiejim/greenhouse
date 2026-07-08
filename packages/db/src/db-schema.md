# Database schema (PostgreSQL)

## Design principles

1. **Service pattern** — all DB access goes through domain services (`services/*.ts`, types
   inferred from the Drizzle schema); business code never writes raw SQL.
2. **Markdown-first knowledge** — knowledge documents store canonical Markdown in `content`;
   `content_json` holds the Tiptap editor state; `_summary`/`_questions`/`_topics` are optional
   AI-enrichment fields that don't change the source content.
3. **Foreign-key strategy** — in-domain ownership uses FK constraints + CASCADE/SET NULL;
   cross-domain references (audit / logs / usage → users/sessions) stay loose (no FK) so those
   records outlive the entity they reference.

The current schema has 36 tables, grouped by domain below.

## Auth & users

| Table | Purpose |
|---|---|
| **users** | Account (email + scrypt password hash), role `super`/`team`/`external`, status, usage limits, locale, optional `notes` (injected into agent context) |
| **user_profiles** | User ↔ profile assignment (PK `user_id`+`profile_id`); a member may only use assigned profiles |
| **user_tools** | User ↔ tool assignment (PK `user_id`+`tool_id`); `is_global` tools need no assignment |
| **refresh_tokens** | Refresh-token store (SHA-256 hash) for silent login refresh |
| **user_features** | Per-user feature flags (`user_id × feature`, `enabled`, `config`); unique `(user_id, feature)` |
| **user_memories** | Persistent user facts extracted from conversations (`category` preference/fact/behavior, `confidence`, access tracking) |
| **user_prompts** | Quick prompts / slash commands; personal or global (`is_global`, super-created) |
| **custom_profiles** | User-created agent profiles. Relational shell (`user_id`/`slug`/`name`/`is_shared`/`base_profile_id`/`forked_from`) + a single `data` jsonb holding the rest of the manifest (`ProfileData` from `@greenhouse/types/profile-manifest` — adding a config field needs no migration); `base_profile_id` ∈ `default`/`team`; unique `(user_id, slug)` |

## Sessions & chat

| Table | Purpose |
|---|---|
| **sessions** | Chat sessions: `status`, `profile_id`, `user_id` (nullable, no FK), `app_id` (external client), `channel` (web/api/a2a/task/subagent), `parent_session_id` (self-ref for `spawn_session` children), rating/feedback, `metadata` (incl. `spawn_depth`) |
| **messages** | Conversation messages (FK `session_id` CASCADE); content, `references_`, `pipeline` (tool-call chain), `reasoning`, `images`, token counts, `duration_ms`, `seq` |
| **session_groups** | User-created session folders; `kind` custom/pinned; unique `(user_id, name)` |
| **session_group_members** | Session ↔ folder membership (FK `group_id`, `session_id` CASCADE); single-home constraint for custom folders |
| **session_tags** | User-defined session tags; unique `(user_id, name)` |
| **session_tag_links** | Tag ↔ session links (FK `tag_id` CASCADE); unique `(session_id, tag_id)` |
| **session_shares** | Share a session with a user or `__team__`; unique `(session_id, shared_with)` |
| **session_share_reads** | Per-user read tracking for shared sessions; unique `(session_id, user_id)` |

## LLM gateway & usage

| Table | Purpose |
|---|---|
| **llm_upstreams** | Gateway upstream pool: real vendor endpoint (`provider_kind`/`base_url`) + AES-256-GCM encrypted key (`api_key_enc`), admin-managed |
| **llm_gateway_models** | Public model catalog: `public_id` → upstream mapping (`upstream_model`), `is_default`, `is_public`, `enabled` (FK `upstream_id` CASCADE) |
| **llm_calls** | `call_llm` one-shot sub-call audit (full input/output + model + tokens, FK `session_id` CASCADE); not fed back into context |
| **llm_usage** | Token-usage accounting by profile/caller/model/user/session (loose refs) |

## Knowledge base & groups

| Table | Purpose |
|---|---|
| **knowledge_base** | Documents: Markdown `content` + Tiptap `content_json`, `visibility` team/private (`private` + `owner_user_id` = personal), `status` draft/published/archived, tags, FTS, optional `_summary`/`_questions`/`_topics` enrichment; unique `(doc_id, scope)` |
| **knowledge_base_versions** | Per-doc version snapshots for history / diff / restore (FK `doc_id` CASCADE); unique `(doc_id, version)` |
| **knowledge_base_shares** | Fine-grained sharing of private docs: `shared_with` = user_id or `group:<id>`, `role` reader/editor (FK `doc_id` CASCADE); unique `(doc_id, shared_with)` |
| **user_groups** | User-created groups, used as sharing targets; managed by `created_by` |
| **group_members** | Group membership (FK `group_id`, `user_id` CASCADE); unique `(group_id, user_id)` |

## Projects

| Table | Purpose |
|---|---|
| **projects** | Project (title/description/status/priority/owner/dates/visibility) |
| **project_members** | Members (`role` owner/member; FK `project_id` CASCADE); unique `(project_id, user_id)` |
| **tasks** | Tasks with parent/child (FK `project_id` CASCADE, `parent_id` self-ref SET NULL); status/priority/type/assignee/dates/hours/tags/dependencies |
| **task_comments** | Task comments (FK `task_id` CASCADE) |
| **project_activities** | Project/task change log (FK `project_id` CASCADE, `task_id` SET NULL) |

## Automations & email

| Table | Purpose |
|---|---|
| **scheduled_tasks** | Cron-scheduled agent runs (FK `user_id` CASCADE): `profile_id`, `task_prompt`, `schedule` (cron), `timezone`, `enabled`, run tracking |
| **email_accounts** | Per-user IMAP/SMTP mailbox binding (FK `user_id` CASCADE); AES-256-GCM encrypted `credentials`; unique `(user_id, provider, email_address)` |

## Skill Center

| Table | Purpose |
|---|---|
| **agent_skills** | Skill catalog: unique kebab-case `name` (immutable), `display_name`, `description`, `tags` (JSON), denormalized `latest_version`, `status` active/archived, `owner_user_id` (loose), `download_count`. Payload bundles live in the skill store (S3-compatible or local disk), not in the DB |
| **agent_skill_versions** | Immutable per-version history (FK `skill_id` CASCADE): semver `version`, mandatory `changelog`, `file_count`, `size_bytes`, `content_hash` (sha256), `storage_key`, `created_by`; unique `(skill_id, version)` |

## API clients, audit & misc

| Table | Purpose |
|---|---|
| **api_clients** | External API client registration: `app_id`, key hash, limits, `allowed_profiles`, `user_id` (bound internal user for a2a/relay keys), `channel` (api/a2a/local-agent/cli/relay) |
| **api_audit_log** | API call audit (v1 + agent proxy + relay + MCP): endpoint, tokens, IP, channel, bound user/session (loose refs) |
| **feature_requests** | User feature requests (`status` pending/accepted/rejected/done, `priority`); member submits, super manages |
| **workspace_settings** | Admin-editable deployment config, one row per configured `WORKSPACE_SETTINGS` registry key (`@greenhouse/types/workspace-settings`): plain values in `value` jsonb, secrets AES-256-GCM encrypted in `value_enc` (exactly one non-null); resolution DB → env fallback happens in `apps/api/src/settings/` |

## Table relationships

### FK constraints (enforced at the DB level)

| Child.column | → Parent.column | onDelete |
|---|---|---|
| `messages.session_id` | → `sessions.id` | CASCADE |
| `llm_calls.session_id` | → `sessions.id` | CASCADE |
| `session_group_members.group_id` | → `session_groups.id` | CASCADE |
| `session_group_members.session_id` | → `sessions.id` | CASCADE |
| `session_tag_links.tag_id` | → `session_tags.id` | CASCADE |
| `llm_gateway_models.upstream_id` | → `llm_upstreams.id` | CASCADE |
| `knowledge_base_versions.doc_id` | → `knowledge_base.id` | CASCADE |
| `knowledge_base_shares.doc_id` | → `knowledge_base.id` | CASCADE |
| `group_members.group_id` | → `user_groups.id` | CASCADE |
| `group_members.user_id` | → `users.id` | CASCADE |
| `projects` ← `project_members.project_id` | → `projects.id` | CASCADE |
| `tasks.project_id` | → `projects.id` | CASCADE |
| `tasks.parent_id` | → `tasks.id` | SET NULL |
| `task_comments.task_id` | → `tasks.id` | CASCADE |
| `project_activities.project_id` | → `projects.id` | CASCADE |
| `project_activities.task_id` | → `tasks.id` | SET NULL |
| `user_profiles.user_id` | → `users.id` | CASCADE |
| `user_tools.user_id` | → `users.id` | CASCADE |
| `refresh_tokens.user_id` | → `users.id` | CASCADE |
| `user_features.user_id` | → `users.id` | CASCADE |
| `user_memories.user_id` | → `users.id` | CASCADE |
| `custom_profiles.user_id` | → `users.id` | CASCADE |
| `scheduled_tasks.user_id` | → `users.id` | CASCADE |
| `email_accounts.user_id` | → `users.id` | CASCADE |
| `agent_skill_versions.skill_id` | → `agent_skills.id` | CASCADE |

### Logical associations (application-level, no FK)

Intentionally without an FK so audit / log / usage data is independent of the referenced
entity's lifecycle.

| Child.column | → Semantic target | Note |
|---|---|---|
| `sessions.user_id` | → `users.id` | Anonymous sessions may be null |
| `sessions.app_id` | → `api_clients.app_id` | External API session identity |
| `sessions.parent_session_id` | → `sessions.id` | Self-ref lineage; deleting a parent does not delete children |
| `messages` (`references_`) | → `knowledge_base` docs | Cited documents (JSON) |
| `llm_usage.session_id` / `.user_id` | → `sessions.id` / `users.id` | Usage outlives the session/user |
| `llm_calls.user_id` | → `users.id` | Caller (nullable) |
| `api_clients.user_id` | → `users.id` | Bound internal user for a2a/relay keys (nullable = system key) |
| `api_audit_log.app_id` / `.user_id` / `.session_id` | → `api_clients.app_id` / `users.id` / `sessions.id` | Audit independent of those entities |
| `knowledge_base.owner_user_id` / `.created_by` / `.updated_by` | → `users.id` | Personal-doc owner + authorship (loose) |
| `knowledge_base_versions.changed_by` | → `users.id` | Version author (loose) |
| `knowledge_base_shares.shared_with` | → `users.id` or `group:<user_groups.id>` | Prefixed composite target |
| `knowledge_base_shares.shared_by` | → `users.id` | Granting user (= owner) |
| `user_groups.created_by` | → `users.id` | Group owner |
| `session_groups.user_id` / `session_group_members.user_id` | → `users.id` | Folder owner |
| `session_tags.user_id` / `session_tag_links.session_id` | → `users.id` / `sessions.id` | Tag owner / tagged session |
| `session_shares.shared_with` / `.shared_by` | → `users.id` (or `__team__`) | Share target / sharer |
| `projects.owner_id` / `.created_by` | → `users.id` | Project owner / creator |
| `project_members.user_id` | → `users.id` | Member |
| `tasks.assignee_id` / `.created_by` | → `users.id` | Assignee (nullable) / creator |
| `task_comments.user_id` | → `users.id` | Commenter |
| `project_activities.user_id` | → `users.id` | Actor |
| `user_prompts.user_id` | → `users.id` | Prompt owner |
| `user_memories.source_session_id` | → `sessions.id` | Origin session |
| `feature_requests.submitted_by` / `.session_id` | → `users.id` / `sessions.id` | Submitter / context |
| `agent_skills.owner_user_id` / `agent_skill_versions.created_by` | → `users.id` | Skill owner / version author — skills outlive members |
| `workspace_settings.updated_by` | → `users.id` | Last editor (audit) |

## ER diagram

```mermaid
erDiagram
    users {
        text id PK
        text email UK
        text password_hash
        text nickname
        text role "super/team/external"
        text status "active/disabled"
        int daily_message_limit
        int monthly_token_limit
        text notes
        text locale
        timestamptz created_at
        timestamptz updated_at
        timestamptz last_login_at
    }
    user_profiles {
        text user_id FK "PK part"
        text profile_id "PK part"
        text assigned_by
        timestamptz assigned_at
    }
    user_tools {
        text user_id FK "PK part"
        text tool_id "PK part"
        text assigned_by
        timestamptz assigned_at
    }
    refresh_tokens {
        text id PK
        text user_id FK
        text token_hash
        timestamptz expires_at
    }
    user_features {
        int id PK
        text user_id FK
        text feature
        bool enabled
        text config "JSON"
        text granted_by
    }
    user_memories {
        int id PK
        text user_id FK
        text category "preference/fact/behavior"
        text content
        text source_session_id "logical"
        real confidence
        int access_count
    }
    user_prompts {
        int id PK
        text user_id "logical"
        text title
        text content
        text shortcut
        bool is_global
    }
    custom_profiles {
        int id PK
        text user_id FK
        text slug
        text name
        text base_profile_id "default/team"
        bool is_shared
        text forked_from "nullable"
        jsonb data "ProfileData manifest payload"
    }
    sessions {
        text id PK
        text title
        text status
        text profile_id
        text user_id "logical, nullable"
        text app_id "logical"
        text channel "web/api/a2a/task/subagent"
        text parent_session_id "self-ref, logical"
        int rating
        text feedback
        text metadata "JSON (spawn_depth)"
        timestamptz created_at
        timestamptz updated_at
    }
    messages {
        text id PK
        text session_id FK
        text role
        text content
        text references_ "JSON"
        text pipeline "JSON tool chain"
        text reasoning
        text images "JSON"
        real confidence
        int grounded
        int input_tokens
        int output_tokens
        int seq
    }
    session_groups {
        int id PK
        text user_id "logical"
        text name
        text kind "custom/pinned"
        int sort_order
    }
    session_group_members {
        int id PK
        text user_id "logical"
        int group_id FK
        text session_id FK
        text kind
    }
    session_tags {
        int id PK
        text user_id "logical"
        text name
        int sort_order
    }
    session_tag_links {
        int id PK
        text session_id "logical"
        int tag_id FK
    }
    session_shares {
        int id PK
        text session_id "logical"
        text shared_with "user_id or __team__"
        text shared_by
    }
    session_share_reads {
        int id PK
        text session_id "logical"
        text user_id "logical"
        timestamptz read_at
    }
    llm_upstreams {
        text id PK
        text name
        text provider_kind "openai/anthropic/deepseek/openai-compatible"
        text base_url
        text api_key_enc "AES-256-GCM"
        bool enabled
    }
    llm_gateway_models {
        text id PK
        text public_id UK
        text display_name
        text upstream_id FK
        text upstream_model
        bool is_default
        bool is_public
        bool enabled
    }
    llm_calls {
        text id PK
        text session_id FK
        text user_id "logical"
        text model
        text input
        text output
        text status "ok/error"
        int input_tokens
        int output_tokens
    }
    llm_usage {
        int id PK
        text profile_id
        text caller
        text session_id "logical"
        text user_id "logical"
        text model
        int input_tokens
        int output_tokens
        int cached_tokens
        int reasoning_tokens
    }
    knowledge_base {
        int id PK
        text doc_id "UK with scope"
        text scope
        text title
        text content "Markdown"
        text content_json "Tiptap JSON"
        text content_hash
        text visibility "team/private"
        text status "draft/published/archived"
        text tags "JSON"
        text owner_user_id "logical"
        text created_by "logical"
        text _summary
        text _questions "JSON"
        text _topics "JSON"
        timestamptz _enriched_at
    }
    knowledge_base_versions {
        int id PK
        int doc_id FK
        int version
        text title
        text content
        text summary
        text changed_by "logical"
        text change_reason
    }
    knowledge_base_shares {
        int id PK
        int doc_id FK
        text shared_with "user_id or group:<id>"
        text role "reader/editor"
        text shared_by "logical"
    }
    user_groups {
        int id PK
        text name
        text description
        text created_by "logical"
    }
    group_members {
        int id PK
        int group_id FK
        text user_id FK
        text added_by
    }
    projects {
        int id PK
        text title
        text description
        text status "planning/active/on_hold/completed/archived"
        text priority "low/normal/high/urgent"
        text owner_id "logical"
        text start_date
        text end_date
        text visibility "public/private"
        text created_by "logical"
    }
    project_members {
        int id PK
        int project_id FK
        text user_id "logical"
        text role "owner/member"
    }
    tasks {
        int id PK
        int project_id FK
        int parent_id FK "self-ref SET NULL"
        text title
        text status "todo/in_progress/in_review/done/cancelled"
        text priority "low/normal/high/urgent"
        text task_type
        text assignee_id "logical"
        text start_date
        text due_date
        timestamptz completed_at
        text tags "JSON"
        text dependencies "JSON"
        text created_by "logical"
    }
    task_comments {
        int id PK
        int task_id FK
        text user_id "logical"
        text content
    }
    project_activities {
        int id PK
        int project_id FK
        int task_id FK "SET NULL"
        text user_id "logical"
        text action
        text detail
    }
    scheduled_tasks {
        int id PK
        text user_id FK
        text name
        text profile_id
        text task_prompt
        text schedule "cron"
        text timezone
        bool enabled
        timestamptz last_run_at
        text last_status
        timestamptz next_run_at
        int run_count
    }
    email_accounts {
        int id PK
        text user_id FK
        text provider "imap"
        text email_address
        text credentials "AES-256-GCM"
        text status "active/disabled/auth_expired/error"
        timestamptz last_synced_at
    }
    api_clients {
        text id PK
        text app_id UK
        text app_name
        text api_key_hash
        text status "active/disabled"
        text allowed_profiles "JSON"
        int rate_limit_rpm
        int rate_limit_rpd
        int daily_token_limit
        text user_id "logical, nullable"
        text channel "api/a2a/local-agent/cli/relay"
    }
    api_audit_log {
        int id PK
        text app_id "logical"
        text endpoint
        text method
        text session_id "logical"
        text user_id "logical"
        text channel
        int status_code
        int duration_ms
        int input_tokens
        int output_tokens
        text ip_address
    }
    feature_requests {
        int id PK
        text title
        text description
        text submitted_by "logical"
        text status "pending/accepted/rejected/done"
        text priority "low/normal/high"
        text session_id "logical"
    }
    agent_skills {
        int id PK
        text name UK
        text display_name
        text description
        text tags "JSON"
        text latest_version
        text status "active/archived"
        text owner_user_id "logical"
        int download_count
    }
    agent_skill_versions {
        int id PK
        int skill_id FK
        text version "unique per skill"
        text changelog
        int file_count
        int size_bytes
        text content_hash "sha256"
        text storage_key
        text created_by "logical"
    workspace_settings {
        text key PK "registry key"
        jsonb value "plain value"
        text value_enc "encrypted secret"
        text updated_by "logical"
    }

    %% ── FK constraints (solid) ──
    users ||--o{ user_profiles : "FK CASCADE"
    users ||--o{ user_tools : "FK CASCADE"
    users ||--o{ refresh_tokens : "FK CASCADE"
    users ||--o{ user_features : "FK CASCADE"
    users ||--o{ user_memories : "FK CASCADE"
    users ||--o{ custom_profiles : "FK CASCADE"
    users ||--o{ scheduled_tasks : "FK CASCADE"
    users ||--o{ email_accounts : "FK CASCADE"
    users ||--o{ group_members : "FK CASCADE"
    sessions ||--o{ messages : "FK CASCADE"
    sessions ||--o{ llm_calls : "FK CASCADE"
    sessions ||--o{ session_group_members : "FK CASCADE"
    session_groups ||--o{ session_group_members : "FK CASCADE"
    session_tags ||--o{ session_tag_links : "FK CASCADE"
    llm_upstreams ||--o{ llm_gateway_models : "FK CASCADE"
    knowledge_base ||--o{ knowledge_base_versions : "FK CASCADE"
    knowledge_base ||--o{ knowledge_base_shares : "FK CASCADE"
    user_groups ||--o{ group_members : "FK CASCADE"
    projects ||--o{ project_members : "FK CASCADE"
    projects ||--o{ tasks : "FK CASCADE"
    projects ||--o{ project_activities : "FK CASCADE"
    tasks ||--o{ tasks : "FK SET NULL (parent)"
    tasks ||--o{ task_comments : "FK CASCADE"
    tasks ||--o| project_activities : "FK SET NULL"
    agent_skills ||--o{ agent_skill_versions : "FK CASCADE"

    %% ── Logical associations (no FK) ──
    users ||--o{ sessions : "logical: user_id"
    users ||--o{ llm_usage : "logical: user_id"
    users ||--o{ projects : "logical: owner/created_by"
    users ||--o{ tasks : "logical: assignee/created_by"
    users ||--o{ feature_requests : "logical: submitted_by"
    users ||--o{ workspace_settings : "logical: updated_by"
    users ||--o{ api_clients : "logical: user_id"
    users ||--o{ knowledge_base : "logical: owner/created_by"
    users ||--o{ agent_skills : "logical: owner_user_id"
    sessions ||--o{ sessions : "logical: parent_session_id"
    sessions ||--o{ llm_usage : "logical: session_id"
    sessions ||--o{ api_audit_log : "logical: session_id"
    sessions ||--o{ session_shares : "logical: session_id"
    api_clients ||--o{ api_audit_log : "logical: app_id"
    api_clients ||--o{ sessions : "logical: app_id"
```
