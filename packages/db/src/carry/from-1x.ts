/**
 * `migrate-from-1x` — carry a Greenhouse 1.6.x database into a fresh 3.0 one.
 *
 * 3.0 never upgrades a 1.x database in place. The operator points this at the
 * old database (read only — nothing there is ever written) and a new one; the
 * new one gets the 3.0 baseline if it is empty and is emptied first if it
 * already has data, so the carry can be repeated until the reconciliation
 * report is clean.
 *
 * Domain by domain, every row keeps its id (serial integers become their
 * decimal string), JSON text becomes jsonb, dates become `date`, and merged
 * tables record where a row came from (a discriminator column, and the
 * report). Rows of merged tables whose serial ids would collide get a source
 * prefix (`pac_`, `esl_`, `frc_`, `kbs_`, `tbm_`). Extension tables (any public
 * table the 1.x core chain did not create) and `extension_migrations` are
 * copied verbatim: DDL rebuilt from the catalog, data streamed with COPY.
 *
 * Not carried (they stay in the old database, which is kept read-only):
 * retired tables, deleted features, run events older than 30 days of settled
 * runs, delivered outbox rows, expired credentials, rate-limit buckets, request
 * log older than 30 days, evaluation data. Every skipped row is counted with
 * its reason.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { applyMigrations, detectDatabaseGeneration, V1_ARCHIVE_FOLDER, V1_LATEST_TAG } from '../migrate.js';
import { readCoreMigrations } from '../core-migrations.js';
import { copyExtensionTables, discoverExtensionTables, dropTables } from './extensions.js';

type Row = Record<string, unknown>;
type Sql = postgres.Sql;

export interface CarryOptions {
  from: string;
  to?: string;
  dryRun?: boolean;
  /** Cutoffs (30-day windows, expiry) are computed from this instant. */
  now?: Date;
  log?: (line: string) => void;
}

export interface CarryLine {
  source: string;
  target: string;
  read: number;
  written: number;
  skipped: Record<string, number>;
}

export interface CarryReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  sourceVersion: string;
  lines: CarryLine[];
  /** Source tables the carry read nothing from on purpose (whole table retired). */
  retired: Array<{ table: string; rows: number; reason: string }>;
  extensions: Array<{ table: string; rows: number }>;
  notes: string[];
  /** Target row counts after the carry (core tables), for reconciliation. */
  targetCounts: Record<string, number>;
}

export class CarryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CarryError';
  }
}

const DAY_MS = 86_400_000;
const BATCH = 500;

/** Whole 1.x tables that are not carried, and why. */
const RETIRED_TABLES: Record<string, string> = {
  eval_datasets: 'evaluation data (retired)',
  eval_runs: 'evaluation data (retired)',
  eval_results: 'evaluation data (retired)',
  chat_eval_results: 'evaluation data (retired)',
  agent_workspaces: 'Missions (retired in 1.4)',
  agent_runs: 'Missions (retired in 1.4)',
  agent_run_events: 'Missions (retired in 1.4)',
  agent_artifacts: 'Missions (retired in 1.4)',
  agent_run_approvals: 'Missions (retired in 1.4)',
  agent_run_outbox: 'Missions (retired in 1.4)',
  workflows: 'Workflows (retired in 1.4)',
  workflow_runs: 'Workflows (retired in 1.4)',
  workflow_node_runs: 'Workflows (retired in 1.4)',
  workflow_gates: 'Workflows (retired in 1.4)',
  api_clients: 'LLM relay keys (retired in 1.4)',
  session_tags: 'conversation tags (removed in 1.5)',
  session_tag_links: 'conversation tags (removed in 1.5)',
  user_groups: 'user groups (removed in 3.0)',
  group_members: 'user groups (removed in 3.0)',
  kb_comments: 'document comments (removed in 3.0)',
  kb_links: 'document backlinks (removed in 3.0)',
  table_forms: 'table forms (removed in 3.0)',
  table_dashboards: 'table dashboards (removed in 3.0)',
  table_dashboard_widgets: 'table dashboards (removed in 3.0)',
  table_automation_rules: 'in-table automations (removed in 3.0)',
  table_automation_outbox: 'in-table automations (removed in 3.0)',
  table_automation_runs: 'in-table automations (removed in 3.0)',
  table_notifications: 'table notifications (removed in 3.0)',
  platform_organizations: 'single organization (3.0)',
  platform_user_capability_overrides: 'per-user permission overrides (removed in 3.0)',
  platform_user_entity_policy_overrides: 'per-user permission overrides (removed in 3.0)',
  platform_app_releases: 'stored app releases (removed in 3.0)',
  rate_limit_buckets: 'rate-limit counters (transient)',
};

// ─── value helpers ────────────────────────────────────────

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const strReq = (value: unknown): string => String(value);

function stripNul(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === 'object') {
    const out: Row = {};
    for (const [key, inner] of Object.entries(value as Row)) out[key] = stripNul(inner);
    return out;
  }
  return value;
}

/** Parse 1.x JSON text; `fallback` (and a note) when it is not valid JSON. */
function parseJson(value: unknown, fallback: unknown, ctx?: Ctx, label?: string): unknown {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return stripNul(value);
  try {
    return stripNul(JSON.parse(value));
  } catch {
    ctx?.note(`invalid JSON in ${label ?? 'a column'} replaced by its default`);
    return fallback;
  }
}

const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

function day(value: unknown, ctx: Ctx, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (isDay(value)) return value;
  // `2026-10-24T…` — keep the calendar day.
  if (typeof value === 'string' && isDay(value.slice(0, 10))) return value.slice(0, 10);
  ctx.note(`unparseable date in ${label} dropped`);
  return null;
}

const ID_KEYS = new Set([
  'id',
  'tableId',
  'fieldId',
  'targetTableId',
  'relationFieldId',
  'targetFieldId',
  'baseId',
  'valueFieldId',
  'groupByFieldId',
  'recordId',
]);
const ID_LIST_KEYS = new Set(['fieldIds', 'recordIds', 'ids']);

/** Table ids inside field / view config and schema snapshots became strings. */
function stringifyIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stringifyIds);
  if (!value || typeof value !== 'object') return value;
  const out: Row = {};
  for (const [key, inner] of Object.entries(value as Row)) {
    if (ID_KEYS.has(key) && typeof inner === 'number') out[key] = String(inner);
    else if (ID_LIST_KEYS.has(key) && Array.isArray(inner))
      out[key] = inner.map((item) => (typeof item === 'number' ? String(item) : stringifyIds(item)));
    else out[key] = stringifyIds(inner);
  }
  return out;
}

/** Relation / attachment cell values hold record / file ids. */
function stringifyCell(value: unknown): unknown {
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(stringifyCell);
  if (value && typeof value === 'object') return stringifyIds(value);
  return value;
}

// ─── context ──────────────────────────────────────────────

interface TargetTable {
  columns: string[];
  jsonb: Set<string>;
}

class Ctx {
  readonly lines = new Map<string, CarryLine>();
  readonly notes = new Map<string, number>();
  readonly targetTables = new Map<string, TargetTable>();
  /** Ids that exist in the target, per table, for merged tables and FK-safety checks. */
  readonly ids = new Map<string, Set<string>>();

  constructor(
    readonly source: Sql,
    readonly target: Sql | null,
    readonly dryRun: boolean,
    readonly now: Date,
    readonly sourceTables: Set<string>,
    readonly log: (line: string) => void,
  ) {}

  note(text: string): void {
    this.notes.set(text, (this.notes.get(text) ?? 0) + 1);
  }

  line(source: string, target: string): CarryLine {
    const key = `${source}→${target}`;
    let line = this.lines.get(key);
    if (!line) {
      line = { source, target, read: 0, written: 0, skipped: {} };
      this.lines.set(key, line);
    }
    return line;
  }

  skip(line: CarryLine, reason: string, count = 1): void {
    line.skipped[reason] = (line.skipped[reason] ?? 0) + count;
  }

  idSet(table: string): Set<string> {
    let set = this.ids.get(table);
    if (!set) {
      set = new Set();
      this.ids.set(table, set);
    }
    return set;
  }

  daysAgo(days: number): Date {
    return new Date(this.now.getTime() - days * DAY_MS);
  }
}

/** A writer that batches rows into one target table. */
class Writer {
  private buffer: Row[] = [];

  constructor(
    private readonly ctx: Ctx,
    readonly table: string,
  ) {}

  async push(line: CarryLine, row: Row): Promise<void> {
    const id = row.id;
    if (typeof id === 'string') {
      const seen = this.ctx.idSet(this.table);
      if (seen.has(id)) {
        this.ctx.skip(line, `duplicate id in ${this.table}`);
        return;
      }
      seen.add(id);
    }
    line.written += 1;
    if (this.ctx.dryRun) return;
    this.buffer.push(row);
    if (this.buffer.length >= BATCH) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.ctx.target) return;
    const target = this.ctx.target;
    const meta = this.ctx.targetTables.get(this.table);
    if (!meta) throw new CarryError(`Target table ${this.table} is missing — is the 3.0 baseline applied?`);
    const columns = meta.columns.filter((column) => this.buffer.some((row) => row[column] !== undefined));
    const rows = this.buffer.map((row) => {
      const out: Row = {};
      for (const column of columns) {
        const value = row[column];
        out[column] =
          value === undefined
            ? null
            : meta.jsonb.has(column) && value !== null
              ? target.json(value as postgres.JSONValue)
              : value;
      }
      return out;
    });
    this.buffer = [];
    await target`INSERT INTO ${target(this.table)} ${target(rows as Array<Record<string, postgres.ParameterOrJSON<never>>>, columns)}`;
  }
}

async function eachRow(ctx: Ctx, table: string, visit: (row: Row) => Promise<void>, orderBy = ''): Promise<void> {
  if (!ctx.sourceTables.has(table)) return;
  const query = ctx.source.unsafe(`SELECT * FROM "${table}"${orderBy ? ` ORDER BY ${orderBy}` : ''}`);
  for await (const rows of query.cursor(1000)) {
    for (const row of rows) await visit(row as Row);
  }
}

async function countRows(sql: Sql, table: string): Promise<number> {
  const [row] = await sql.unsafe(`SELECT count(*)::bigint AS n FROM "${table}"`);
  return Number(row?.n ?? 0);
}

/** Copy `source` into `target` with a row transform (null = skip, with the returned reason). */
async function carry(
  ctx: Ctx,
  source: string,
  target: string,
  transform: (row: Row, line: CarryLine) => Promise<Row | string | null> | Row | string | null,
  orderBy = '',
): Promise<void> {
  const line = ctx.line(source, target);
  const writer = new Writer(ctx, target);
  await eachRow(
    ctx,
    source,
    async (row) => {
      line.read += 1;
      const result = await transform(row, line);
      if (result === null) return;
      if (typeof result === 'string') {
        ctx.skip(line, result);
        return;
      }
      await writer.push(line, result);
    },
    orderBy,
  );
  await writer.flush();
  ctx.log(`  ${source} → ${target}: ${line.read} read, ${line.written} written`);
}

// ─── domains ──────────────────────────────────────────────

const ts = (value: unknown): unknown => value ?? null;

async function carryIdentity(ctx: Ctx): Promise<void> {
  const workbench = new Map<string, unknown>();
  await eachRow(ctx, 'platform_user_workbench_preferences', async (row) => {
    workbench.set(strReq(row.user_id), parseJson(row.preferences, null, ctx, 'workbench preferences'));
  });
  const wbLine = ctx.line('platform_user_workbench_preferences', 'users.preferences');
  wbLine.read = workbench.size;

  await carry(ctx, 'users', 'users', (row) => {
    const prefs: Row = {};
    const stored = workbench.get(strReq(row.id));
    if (stored && typeof stored === 'object') {
      prefs.workbench = stored;
      wbLine.written += 1;
    }
    return {
      id: strReq(row.id),
      email: row.email,
      password_hash: row.password_hash,
      auth_version: row.auth_version,
      nickname: row.nickname,
      role: row.role,
      status: row.status,
      notes: row.notes,
      locale: row.locale,
      preferences: prefs,
      created_by: row.created_by,
      created_at: ts(row.created_at),
      updated_at: ts(row.updated_at),
      last_login_at: row.last_login_at,
    };
  });
  for (const userId of workbench.keys()) {
    if (!ctx.idSet('users').has(userId)) ctx.skip(wbLine, 'user no longer exists');
  }

  const users = ctx.idSet('users');
  const known = (userId: unknown) => users.has(String(userId));

  await carry(ctx, 'user_features', 'user_grants', (row) =>
    !known(row.user_id)
      ? 'user no longer exists'
      : {
          user_id: strReq(row.user_id),
          kind: 'feature',
          key: row.feature,
          enabled: row.enabled,
          config: parseJson(row.config, {}, ctx, 'user_features.config'),
          granted_by: row.granted_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
  );
  await carry(ctx, 'user_tools', 'user_grants', (row) =>
    !known(row.user_id)
      ? 'user no longer exists'
      : {
          user_id: strReq(row.user_id),
          kind: 'tool',
          key: row.tool_id,
          enabled: true,
          config: {},
          granted_by: row.assigned_by,
          created_at: row.assigned_at ?? ctx.now,
          updated_at: row.assigned_at ?? ctx.now,
        },
  );
  await carry(ctx, 'refresh_tokens', 'auth_refresh_tokens', (row) =>
    new Date(row.expires_at as string) <= ctx.now
      ? 'expired token'
      : !known(row.user_id)
        ? 'user no longer exists'
        : { ...row, id: strReq(row.id), user_id: strReq(row.user_id) },
  );
  await carry(ctx, 'account_password_links', 'password_links', (row) =>
    new Date(row.expires_at as string) <= ctx.now && !row.consumed_at
      ? 'expired token'
      : !known(row.user_id)
        ? 'user no longer exists'
        : { ...row, id: strReq(row.id), user_id: strReq(row.user_id) },
  );
  await carry(ctx, 'oauth_login_states', 'login_states', (row) =>
    new Date(row.expires_at as string) <= ctx.now
      ? 'expired token'
      : { ...row, payload: parseJson(row.payload, {}, ctx, 'oauth_login_states.payload') },
  );
}

async function carryAccess(ctx: Ctx): Promise<void> {
  const users = ctx.idSet('users');
  await carry(ctx, 'platform_roles', 'roles', (row) => {
    if (row.org_id !== 'default') return `role of organization ${String(row.org_id)}`;
    return {
      id: strReq(row.id),
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      system_protected: row.system_protected,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
  const roles = ctx.idSet('roles');
  await carry(ctx, 'platform_role_bindings', 'role_members', (row) =>
    !roles.has(String(row.role_id))
      ? 'role not carried'
      : !users.has(String(row.user_id))
        ? 'user no longer exists'
        : row,
  );
  await carry(ctx, 'platform_role_capabilities', 'role_capabilities', (row) =>
    !roles.has(String(row.role_id)) ? 'role not carried' : row,
  );
  await carry(ctx, 'platform_role_entity_policies', 'role_entity_policies', (row) =>
    !roles.has(String(row.role_id))
      ? 'role not carried'
      : {
          ...row,
          scopes: parseJson(row.scopes, [], ctx, 'entity policy scopes'),
          field_policies: parseJson(row.field_policies, {}, ctx, 'entity policy fields'),
        },
  );
}

async function carryOAuth(ctx: Ctx): Promise<void> {
  const users = ctx.idSet('users');
  await carry(ctx, 'platform_oauth_clients', 'oauth_clients', (row) =>
    row.bound_user_id && !users.has(String(row.bound_user_id))
      ? 'bound user no longer exists'
      : {
          ...row,
          redirect_uris: parseJson(row.redirect_uris, [], ctx, 'oauth client redirect_uris'),
          allowed_scopes: parseJson(row.allowed_scopes, [], ctx, 'oauth client allowed_scopes'),
        },
  );
  const clients = ctx.idSet('oauth_clients');
  await carry(ctx, 'platform_oauth_grants', 'oauth_grants', (row) =>
    !users.has(String(row.user_id))
      ? 'user no longer exists'
      : !clients.has(String(row.client_id))
        ? 'client not carried'
        : { ...row, scopes: parseJson(row.scopes, [], ctx, 'grant scopes'), avatar: null },
  );
  const grants = ctx.idSet('oauth_grants');
  await carry(ctx, 'platform_oauth_authorization_codes', 'oauth_codes', (row) =>
    new Date(row.expires_at as string) <= ctx.now
      ? 'expired token'
      : !grants.has(String(row.grant_id))
        ? 'grant not carried'
        : { ...row, scopes: parseJson(row.scopes, [], ctx, 'code scopes') },
  );
  await carry(ctx, 'platform_oauth_tokens', 'oauth_tokens', (row) =>
    new Date(row.expires_at as string) <= ctx.now
      ? 'expired token'
      : !grants.has(String(row.grant_id))
        ? 'grant not carried'
        : { ...row, scopes: parseJson(row.scopes, [], ctx, 'token scopes') },
  );
  await carry(ctx, 'gateway_keys', 'gateway_keys', (row) =>
    !users.has(String(row.user_id))
      ? 'user no longer exists'
      : { ...row, allowed_models: row.allowed_models === null ? null : parseJson(row.allowed_models, null, ctx) },
  );
  await carry(ctx, 'user_provider_tokens', 'provider_connections', (row) =>
    !users.has(String(row.user_id))
      ? 'user no longer exists'
      : {
          id: strReq(row.id),
          user_id: row.user_id,
          provider: row.provider,
          workspace_id: row.workspace_id,
          access_token_enc: row.access_token,
          refresh_token_enc: row.refresh_token,
          credential_enc: row.provider_credential,
          token_type: row.token_type,
          scope: row.scope,
          expires_at: row.expires_at,
          provider_user_id: row.provider_user_id,
          provider_email: row.provider_email,
          provider_name: row.provider_name,
          metadata: parseJson(row.metadata, {}, ctx, 'provider metadata'),
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
  );
}

async function carryConversations(ctx: Ctx): Promise<void> {
  // Pins: 1.x kept them as a per-user "Pinned" session group.
  const pinnedGroups = new Map<string, string>();
  await eachRow(ctx, 'session_groups', async (row) => {
    if (row.kind === 'pinned') pinnedGroups.set(strReq(row.id), strReq(row.user_id));
  });
  const groupLine = ctx.line('session_groups', '—');
  const groupMembers: Row[] = [];
  await eachRow(ctx, 'session_group_members', async (row) => {
    groupMembers.push(row);
  });
  const ownerPins = new Map<string, { at: unknown; position: number }>();
  const recipientPins: Row[] = [];
  const sessionOwner = new Map<string, string | null>();
  await eachRow(ctx, 'sessions', async (row) => {
    sessionOwner.set(strReq(row.id), str(row.user_id));
  });
  const pinLine = ctx.line('session_group_members', 'conversations.pinned_at / conversation_share_reads.pinned_at');
  for (const member of groupMembers) {
    pinLine.read += 1;
    if (!pinnedGroups.has(String(member.group_id)) || member.kind !== 'pinned') {
      ctx.skip(pinLine, 'conversation folders (removed in 1.5)');
      continue;
    }
    const sessionId = strReq(member.session_id);
    const owner = sessionOwner.get(sessionId);
    if (owner === undefined) {
      ctx.skip(pinLine, 'conversation not carried');
      continue;
    }
    if (owner === String(member.user_id))
      ownerPins.set(sessionId, { at: member.created_at, position: Number(member.sort_order ?? 0) });
    else recipientPins.push(member);
    pinLine.written += 1;
  }
  await eachRow(ctx, 'session_groups', async (row) => {
    groupLine.read += 1;
    if (row.kind !== 'pinned') ctx.skip(groupLine, 'conversation folders (removed in 1.5)');
    else ctx.skip(groupLine, 'pinned group became pinned_at columns');
  });

  await carry(ctx, 'sessions', 'conversations', (row) => {
    const pin = ownerPins.get(strReq(row.id));
    return {
      id: strReq(row.id),
      title: row.title,
      status: row.status,
      profile_id: row.profile_id,
      user_id: row.user_id,
      app_id: row.app_id,
      channel: row.channel,
      metadata: parseJson(row.metadata, {}, ctx, 'sessions.metadata'),
      pinned_at: pin?.at ?? null,
      pin_position: pin?.position ?? 0,
      digest: row.digest,
      digest_upto_seq: row.digest_upto_seq,
      digest_updated_at: row.digest_updated_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
  const conversations = ctx.idSet('conversations');
  if (ctx.sourceTables.has('sessions')) {
    const [ratings] =
      await ctx.source`SELECT count(*) FILTER (WHERE rating IS NOT NULL OR feedback IS NOT NULL OR comment IS NOT NULL)::int AS n FROM sessions`;
    if (Number(ratings?.n ?? 0) > 0) {
      ctx.notes.set(`conversation ratings / feedback / comments dropped (feature removed)`, Number(ratings!.n));
    }
  }

  await carry(
    ctx,
    'messages',
    'messages',
    (row) => {
      if (!conversations.has(String(row.session_id))) return 'conversation not carried';
      const parts: Row = {};
      const references = parseJson(row.references_, [], ctx, 'messages.references_');
      const images = parseJson(row.images, [], ctx, 'messages.images');
      const pipeline = parseJson(row.pipeline, [], ctx, 'messages.pipeline');
      if (Array.isArray(references) && references.length > 0) parts.references = references;
      if (Array.isArray(images) && images.length > 0) parts.images = images;
      if (Array.isArray(pipeline) && pipeline.length > 0) parts.pipeline = pipeline;
      return {
        id: strReq(row.id),
        session_id: row.session_id,
        role: row.role,
        content: typeof row.content === 'string' ? row.content.replaceAll('\u0000', '') : row.content,
        parts,
        reasoning: row.reasoning,
        model: row.model,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cached_tokens: row.cached_tokens,
        reasoning_tokens: row.reasoning_tokens,
        duration_ms: row.duration_ms,
        seq: row.seq,
        created_at: row.created_at,
      };
    },
    'session_id, seq',
  );

  await carry(ctx, 'session_shares', 'conversation_shares', (row) =>
    !conversations.has(String(row.session_id)) ? 'conversation not carried' : { ...row, id: strReq(row.id) },
  );
  const readLine = ctx.line('session_share_reads', 'conversation_share_reads');
  const reads = new Map<string, Row>();
  await eachRow(ctx, 'session_share_reads', async (row) => {
    readLine.read += 1;
    if (!conversations.has(String(row.session_id))) {
      ctx.skip(readLine, 'conversation not carried');
      return;
    }
    reads.set(`${String(row.session_id)}|${String(row.user_id)}`, {
      id: strReq(row.id),
      session_id: row.session_id,
      user_id: row.user_id,
      read_at: row.read_at,
      pinned_at: null,
      pin_position: 0,
    });
  });
  for (const pin of recipientPins) {
    const key = `${String(pin.session_id)}|${String(pin.user_id)}`;
    const existing = reads.get(key);
    if (existing) {
      existing.pinned_at = pin.created_at;
      existing.pin_position = Number(pin.sort_order ?? 0);
    } else {
      reads.set(key, {
        id: `pin_${String(pin.id)}`,
        session_id: pin.session_id,
        user_id: pin.user_id,
        read_at: null,
        pinned_at: pin.created_at,
        pin_position: Number(pin.sort_order ?? 0),
      });
    }
  }
  const readWriter = new Writer(ctx, 'conversation_share_reads');
  for (const row of reads.values()) await readWriter.push(readLine, row);
  await readWriter.flush();

  await carry(ctx, 'chat_artifact_receipts', 'card_action_receipts', (row) =>
    !conversations.has(String(row.session_id))
      ? 'conversation not carried'
      : { ...row, result: parseJson(row.result, {}, ctx, 'receipt result') },
  );
  await carry(ctx, 'feishu_conversations', 'feishu_conversations', (row) =>
    !conversations.has(String(row.session_id))
      ? 'conversation not carried'
      : !ctx.idSet('users').has(String(row.user_id))
        ? 'user no longer exists'
        : { ...row, id: strReq(row.id) },
  );
  await carry(ctx, 'feishu_message_receipts', 'feishu_receipts', (row) => row);
}

async function carryFiles(ctx: Ctx): Promise<void> {
  // Folders: parents before children.
  const folders: Row[] = [];
  await eachRow(ctx, 'drive_folders', async (row) => {
    folders.push(row);
  });
  const folderLine = ctx.line('drive_folders', 'folders');
  folderLine.read = folders.length;
  const byId = new Map(folders.map((row) => [String(row.id), row]));
  const depth = (row: Row, guard = 0): number =>
    row.parent_id === null || guard > 64
      ? 0
      : 1 + depth(byId.get(String(row.parent_id)) ?? { parent_id: null }, guard + 1);
  folders.sort((a, b) => depth(a) - depth(b));
  const folderWriter = new Writer(ctx, 'folders');
  for (const row of folders) {
    if (row.parent_id !== null && !ctx.idSet('folders').has(String(row.parent_id))) {
      ctx.skip(folderLine, 'parent folder not carried');
      continue;
    }
    await folderWriter.push(folderLine, {
      ...row,
      id: strReq(row.id),
      parent_id: str(row.parent_id),
      base_id: str(row.base_id),
    });
    // Children must see their parent's id while the writer still buffers it.
  }
  await folderWriter.flush();
  ctx.log(`  drive_folders → folders: ${folderLine.read} read, ${folderLine.written} written`);
  const folderIds = ctx.idSet('folders');

  await carry(ctx, 'drive_files', 'files', (row) =>
    row.folder_id !== null && !folderIds.has(String(row.folder_id))
      ? 'folder not carried'
      : {
          id: strReq(row.id),
          source: 'drive',
          name: row.name,
          content_type: row.content_type,
          size: row.size,
          sha256: null,
          storage_key: row.cos_key,
          status: row.status,
          scope: row.scope,
          folder_id: str(row.folder_id),
          visibility: row.visibility,
          owner_user_id: row.owner_user_id,
          base_id: str(row.base_id),
          owner_key: row.owner_key,
          meta: {},
          created_by: row.uploaded_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
  );
  const conversations = ctx.idSet('conversations');
  await carry(ctx, 'chat_files', 'files', (row) =>
    !conversations.has(String(row.session_id))
      ? 'conversation not carried'
      : {
          id: strReq(row.id),
          source: row.source === 'user' ? 'chat_upload' : 'chat_output',
          name: row.name,
          content_type: row.content_type,
          size: row.size,
          storage_key: row.storage_key,
          status: 'active',
          session_id: row.session_id,
          meta: {},
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.created_at,
        },
  );
}

const ARTIFACT_STATUS: Record<string, string> = {
  pending: 'pending',
  available: 'active',
  failed: 'failed',
  skipped: 'skipped',
};

async function carryKnowledge(ctx: Ctx): Promise<void> {
  const folders = ctx.idSet('folders');
  await carry(ctx, 'knowledge_base', 'kb_documents', (row) => {
    const at = row.updated_at ?? row.created_at ?? ctx.now;
    return {
      id: strReq(row.id),
      doc_id: row.doc_id,
      scope: row.scope,
      title: row.title,
      content: row.content,
      content_json: parseJson(row.content_json, {}, ctx, 'knowledge_base.content_json'),
      content_hash: row.content_hash,
      visibility: row.visibility === 'private' ? 'private' : 'team',
      status: row.status,
      is_template: row.is_template,
      tags: parseJson(row.tags, [], ctx, 'knowledge_base.tags'),
      meta: parseJson(row.meta, {}, ctx, 'knowledge_base.meta'),
      file_path: row.file_path,
      folder_id: row.folder_id !== null && folders.has(String(row.folder_id)) ? String(row.folder_id) : null,
      sort_order: row.sort_order,
      owner_user_id: row.owner_user_id,
      created_by: row.created_by,
      updated_by: row.updated_by,
      _summary: row._summary,
      _questions: parseJson(row._questions, [], ctx, 'knowledge_base._questions'),
      _topics: parseJson(row._topics, [], ctx, 'knowledge_base._topics'),
      _enriched_at: row._enriched_at,
      search_a: row._tokens_a,
      search_b: row._tokens_b,
      search_c: row._tokens_c,
      created_at: row.created_at ?? at,
      updated_at: at,
    };
  });
  const docs = ctx.idSet('kb_documents');
  await carry(ctx, 'knowledge_base_versions', 'kb_versions', (row) =>
    !docs.has(String(row.doc_id))
      ? 'document not carried'
      : {
          ...row,
          id: strReq(row.id),
          doc_id: strReq(row.doc_id),
          content_json: parseJson(row.content_json, {}, ctx, 'version content_json'),
          created_at: row.created_at ?? ctx.now,
        },
  );
  await carry(ctx, 'knowledge_base_shares', 'shares', (row) => {
    const sharedWith = String(row.shared_with);
    if (sharedWith.startsWith('group:')) return 'shared with a user group (removed in 3.0)';
    if (!docs.has(String(row.doc_id))) return 'document not carried';
    return {
      id: `kbs_${String(row.id)}`,
      resource_type: 'kb_document',
      resource_id: strReq(row.doc_id),
      principal_type: 'user',
      principal_id: sharedWith,
      role: row.role,
      message: row.message,
      created_by: row.shared_by,
      created_at: row.created_at,
      updated_at: row.created_at,
    };
  });
}

async function carryTables(ctx: Ctx): Promise<void> {
  await carry(ctx, 'table_bases', 'table_bases', (row) => ({ ...row, id: strReq(row.id) }));
  const bases = ctx.idSet('table_bases');
  await carry(ctx, 'table_base_members', 'shares', (row) =>
    !bases.has(String(row.base_id))
      ? 'base not carried'
      : {
          id: `tbm_${String(row.id)}`,
          resource_type: 'table_base',
          resource_id: strReq(row.base_id),
          principal_type: 'user',
          principal_id: row.user_id,
          role: row.role,
          message: null,
          created_by: row.added_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
  );
  await carry(ctx, 'table_tables', 'table_tables', (row) =>
    !bases.has(String(row.base_id)) ? 'base not carried' : { ...row, id: strReq(row.id), base_id: strReq(row.base_id) },
  );
  const tables = ctx.idSet('table_tables');
  const fieldTypes = new Map<string, string>();
  await carry(ctx, 'table_fields', 'table_fields', (row) => {
    if (!tables.has(String(row.table_id))) return 'table not carried';
    fieldTypes.set(String(row.id), String(row.type));
    return {
      ...row,
      id: strReq(row.id),
      table_id: strReq(row.table_id),
      config: stringifyIds(parseJson(row.config, {}, ctx, 'table_fields.config')),
    };
  });
  const fields = ctx.idSet('table_fields');
  await carry(ctx, 'table_field_dependencies', 'table_field_dependencies', (row) =>
    !fields.has(String(row.field_id)) || !fields.has(String(row.depends_on_field_id))
      ? 'field not carried'
      : { ...row, field_id: strReq(row.field_id), depends_on_field_id: strReq(row.depends_on_field_id) },
  );
  await carry(ctx, 'table_views', 'table_views', (row) =>
    !tables.has(String(row.table_id))
      ? 'table not carried'
      : {
          ...row,
          id: strReq(row.id),
          table_id: strReq(row.table_id),
          config: stringifyIds(parseJson(row.config, {}, ctx, 'table_views.config')),
        },
  );
  await carry(ctx, 'table_schema_versions', 'table_schema_versions', (row) =>
    !tables.has(String(row.table_id))
      ? 'table not carried'
      : {
          ...row,
          id: strReq(row.id),
          table_id: strReq(row.table_id),
          schema_snapshot: stringifyIds(parseJson(row.schema_snapshot, {}, ctx, 'schema snapshot')),
        },
  );
  await carry(ctx, 'table_records', 'table_records', (row) => {
    if (!tables.has(String(row.table_id))) return 'table not carried';
    const convert = (raw: unknown): Row => {
      const values = (parseJson(raw, {}, ctx, 'record values') ?? {}) as Row;
      const out: Row = {};
      for (const [fieldId, value] of Object.entries(values)) {
        const type = fieldTypes.get(fieldId);
        out[fieldId] = type === 'relation' || type === 'attachment' ? stringifyCell(value) : value;
      }
      return out;
    };
    return {
      ...row,
      id: strReq(row.id),
      table_id: strReq(row.table_id),
      values: convert(row.values),
      computed_values: convert(row.computed_values),
    };
  });
  const records = ctx.idSet('table_records');
  await carry(ctx, 'table_record_links', 'table_record_links', (row) =>
    !fields.has(String(row.field_id)) ||
    !records.has(String(row.source_record_id)) ||
    !records.has(String(row.target_record_id))
      ? 'field or record not carried'
      : {
          ...row,
          id: strReq(row.id),
          field_id: strReq(row.field_id),
          source_record_id: strReq(row.source_record_id),
          target_record_id: strReq(row.target_record_id),
        },
  );
  const files = ctx.idSet('files');
  await carry(ctx, 'table_record_attachments', 'file_links', (row) =>
    !records.has(String(row.record_id)) || !fields.has(String(row.field_id))
      ? 'field or record not carried'
      : !files.has(String(row.drive_file_id))
        ? 'file not carried'
        : {
            file_id: strReq(row.drive_file_id),
            target_type: 'table_record',
            target_id: strReq(row.record_id),
            slot: strReq(row.field_id),
            position: row.position,
            created_by: row.created_by,
            created_at: row.created_at,
          },
  );
  await carry(ctx, 'table_recompute_jobs', 'table_recompute_jobs', (row) =>
    !tables.has(String(row.table_id)) ||
    (row.field_id !== null && !fields.has(String(row.field_id))) ||
    (row.record_id !== null && !records.has(String(row.record_id)))
      ? 'table, field or record not carried'
      : {
          ...row,
          id: strReq(row.id),
          table_id: strReq(row.table_id),
          field_id: str(row.field_id),
          record_id: str(row.record_id),
        },
  );
}

async function carryProjects(ctx: Ctx): Promise<void> {
  await carry(ctx, 'projects', 'projects', (row) => ({
    ...row,
    id: strReq(row.id),
    start_date: day(row.start_date, ctx, 'projects.start_date'),
    end_date: day(row.end_date, ctx, 'projects.end_date'),
  }));
  const projects = ctx.idSet('projects');
  await carry(ctx, 'project_members', 'project_members', (row) =>
    !projects.has(String(row.project_id))
      ? 'project not carried'
      : { ...row, id: strReq(row.id), project_id: strReq(row.project_id) },
  );
  const tasks: Row[] = [];
  await eachRow(ctx, 'tasks', async (row) => {
    tasks.push(row);
  });
  const taskLine = ctx.line('tasks', 'tasks');
  taskLine.read = tasks.length;
  const taskIds = new Set(tasks.map((row) => String(row.id)));
  const taskWriter = new Writer(ctx, 'tasks');
  for (const row of tasks) {
    if (!projects.has(String(row.project_id))) {
      ctx.skip(taskLine, 'project not carried');
      continue;
    }
    const dependencies = parseJson(row.dependencies, [], ctx, 'tasks.dependencies');
    await taskWriter.push(taskLine, {
      ...row,
      id: strReq(row.id),
      project_id: strReq(row.project_id),
      // Parents are inserted in the same batch stream; a parent the carry skips is cleared.
      parent_id: row.parent_id !== null && taskIds.has(String(row.parent_id)) ? String(row.parent_id) : null,
      start_date: day(row.start_date, ctx, 'tasks.start_date'),
      due_date: day(row.due_date, ctx, 'tasks.due_date'),
      tags: parseJson(row.tags, [], ctx, 'tasks.tags'),
      dependencies: Array.isArray(dependencies) ? dependencies.map((dep) => String(dep)) : [],
    });
  }
  await taskWriter.flush();
  ctx.log(`  tasks → tasks: ${taskLine.read} read, ${taskLine.written} written`);
  const carriedTasks = ctx.idSet('tasks');
  await carry(ctx, 'task_comments', 'task_comments', (row) =>
    !carriedTasks.has(String(row.task_id))
      ? 'task not carried'
      : { ...row, id: strReq(row.id), task_id: strReq(row.task_id) },
  );
}

async function carryAudit(ctx: Ctx): Promise<void> {
  await carry(ctx, 'platform_audit_events', 'audit_events', (row) => ({
    id: strReq(row.id),
    actor_id: row.actor_id,
    actor_type: row.actor_type,
    on_behalf_of_user_id: row.on_behalf_of_user_id,
    client_id: row.client_id,
    request_id: row.request_id,
    app_id: row.app_id,
    module_id: row.module_id,
    entity_id: row.entity_id,
    record_id: row.record_id,
    action_id: row.action_id,
    capability: row.capability,
    result: row.result,
    summary: parseJson(row.summary, {}, ctx, 'audit summary'),
    created_at: row.created_at,
  }));
  await carry(ctx, 'project_activities', 'audit_events', (row) => ({
    id: `pac_${String(row.id)}`,
    actor_id: row.user_id,
    actor_type: 'human',
    on_behalf_of_user_id: null,
    client_id: null,
    request_id: `pac_${String(row.id)}`,
    app_id: 'projects',
    module_id: 'projects',
    entity_id: row.task_id !== null ? 'task' : 'project',
    record_id: str(row.task_id ?? row.project_id),
    action_id: row.action,
    capability: 'projects.activity',
    result: 'success',
    summary: { project_id: strReq(row.project_id), task_id: str(row.task_id), detail: row.detail ?? null },
    created_at: row.created_at,
  }));
  await carry(ctx, 'email_send_log', 'audit_events', (row) => ({
    id: `esl_${String(row.id)}`,
    actor_id: row.user_id,
    actor_type: 'human',
    on_behalf_of_user_id: null,
    client_id: null,
    request_id: `esl_${String(row.id)}`,
    app_id: 'email',
    module_id: 'email',
    entity_id: 'message',
    record_id: null,
    action_id: 'send',
    capability: 'email.send',
    result: row.status === 'sent' ? 'success' : 'error',
    summary: {
      account_scope: row.account_scope,
      account_id: str(row.account_id),
      from_address: row.from_address,
      subject: row.subject,
      recipients: parseJson(row.recipients, [], ctx, 'email recipients'),
      attachment_count: row.attachment_count,
      origin: row.origin,
      session_id: row.session_id,
      task_id: str(row.task_id),
      error_message: row.error_message,
    },
    created_at: row.created_at,
  }));
  const cutoff = ctx.daysAgo(30);
  await carry(ctx, 'api_audit_log', 'request_log', (row) =>
    new Date(row.created_at as string) < cutoff
      ? 'request log older than 30 days'
      : { ...row, id: strReq(row.id), meta: parseJson(row.meta, {}, ctx, 'request meta') },
  );
}

async function carryFeedback(ctx: Ctx): Promise<void> {
  await carry(ctx, 'feature_requests', 'feedback', (row) => ({
    id: strReq(row.id),
    kind: 'request',
    title: row.title,
    body: row.description,
    status: row.status,
    note: row.admin_note,
    submitted_by: row.submitted_by,
    priority: row.priority,
    session_id: row.session_id,
    occurrence_count: 1,
    sample_sessions: [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  await carry(ctx, 'tool_frictions', 'feedback', (row) => {
    const samples = parseJson(row.sample_sessions, [], ctx, 'friction samples');
    return {
      id: `frc_${String(row.id)}`,
      kind: 'friction',
      title: row.summary,
      body: row.detail,
      status: row.status,
      note: row.resolution_note,
      fingerprint: row.fingerprint,
      tool_id: row.tool_id,
      friction_kind: row.kind,
      occurrence_count: row.occurrence_count,
      sample_sessions: Array.isArray(samples) ? samples.map((sample) => String(sample)) : [],
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

async function carryAutomations(ctx: Ctx): Promise<void> {
  const users = ctx.idSet('users');
  await carry(ctx, 'scheduled_tasks', 'automations', (row) =>
    !users.has(String(row.user_id))
      ? 'user no longer exists'
      : {
          id: strReq(row.id),
          user_id: row.user_id,
          name: row.name,
          profile_id: row.profile_id,
          task_prompt: row.task_prompt,
          schedule: row.schedule,
          timezone: row.timezone,
          enabled: row.enabled,
          max_steps: row.max_steps,
          notify: {
            webhook: row.notify_webhook ?? null,
            email: Boolean(row.notify_email),
            wecom: Boolean(row.notify_wecom),
            feishu: Boolean(row.notify_feishu),
          },
          quiet_when_empty: row.quiet_when_empty,
          unattended_tools: parseJson(row.unattended_tools, [], ctx, 'unattended_tools'),
          last_run_at: row.last_run_at,
          last_status: row.last_status,
          next_run_at: row.next_run_at,
          run_count: row.run_count,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
  );
  await carry(ctx, 'scheduled_task_runtime_occurrences', 'automation_occurrences', (row) => ({
    ...row,
    task_id: strReq(row.task_id),
  }));

  // Custom agents: the current version's governance fields fold onto the profile.
  const versions = new Map<string, Row>();
  await eachRow(ctx, 'custom_profile_versions', async (row) => {
    versions.set(`${String(row.profile_id)}@${String(row.version)}`, row);
  });
  const versionLine = ctx.line('custom_profile_versions', 'run_profiles (current version folded in)');
  versionLine.read = versions.size;
  await carry(ctx, 'custom_profiles', 'run_profiles', (row) => {
    if (!users.has(String(row.user_id))) return 'user no longer exists';
    const current = versions.get(`${String(row.id)}@${String(row.current_version)}`);
    if (current) versionLine.written += 1;
    return {
      id: strReq(row.id),
      slug: row.slug,
      user_id: row.user_id,
      name: row.name,
      description: row.description,
      base_profile_id: row.base_profile_id,
      model_id: row.model_id,
      tools: parseJson(row.tools, [], ctx, 'custom_profiles.tools'),
      system_prompt: row.system_prompt,
      max_steps: row.max_steps,
      is_shared: row.is_shared,
      avatar: parseJson(row.avatar, {}, ctx, 'custom_profiles.avatar'),
      purpose: current?.purpose ?? null,
      audience: current?.audience ?? null,
      risk_level: current?.risk_level ?? 'medium',
      budget_policy: parseJson(current?.budget_policy, {}, ctx, 'budget_policy'),
      owner_backup_user_id:
        row.owner_backup_user_id && users.has(String(row.owner_backup_user_id)) ? row.owner_backup_user_id : null,
      version: row.current_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
  const older = versions.size - versionLine.written;
  if (older > 0) ctx.skip(versionLine, 'older immutable version (versions retired in 3.0)', older);
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);

async function carryRuns(ctx: Ctx): Promise<void> {
  const json = (value: unknown, fallback: unknown, label: string) => parseJson(value, fallback, ctx, label);
  const runStatus = new Map<string, string>();
  // Parents before children (parent_run_id is a self FK).
  await carry(
    ctx,
    'runtime_runs',
    'runs',
    (row) => {
      runStatus.set(String(row.id), String(row.status));
      return {
        ...row,
        input: json(row.input, {}, 'run input'),
        output: row.output === null ? null : json(row.output, null, 'run output'),
      };
    },
    'CASE WHEN parent_run_id IS NULL THEN 0 ELSE 1 END, created_at, id',
  );
  const runs = ctx.idSet('runs');
  await carry(
    ctx,
    'runtime_steps',
    'run_steps',
    (row) =>
      !runs.has(String(row.run_id))
        ? 'run not carried'
        : {
            ...row,
            input: json(row.input, {}, 'step input'),
            output: row.output === null ? null : json(row.output, null, 'step output'),
          },
    'CASE WHEN parent_step_id IS NULL THEN 0 ELSE 1 END, created_at, id',
  );
  await carry(ctx, 'runtime_tool_calls', 'run_tool_calls', (row) =>
    !runs.has(String(row.run_id))
      ? 'run not carried'
      : {
          ...row,
          input: json(row.input, {}, 'tool input'),
          output: row.output === null ? null : json(row.output, null, 'tool output'),
        },
  );
  await carry(ctx, 'runtime_interrupts', 'run_interrupts', (row) =>
    !runs.has(String(row.run_id))
      ? 'run not carried'
      : {
          ...row,
          payload: json(row.payload, {}, 'interrupt payload'),
          decision: row.decision === null ? null : json(row.decision, null, 'interrupt decision'),
        },
  );
  await carry(ctx, 'runtime_artifacts', 'files', (row) =>
    !runs.has(String(row.run_id))
      ? 'run not carried'
      : {
          id: strReq(row.id),
          source: 'run',
          run_id: row.run_id,
          name: row.name,
          content_type: row.content_type,
          size: row.size_bytes ?? 0,
          sha256: row.sha256,
          storage_key: row.storage_key,
          status: ARTIFACT_STATUS[String(row.status)] ?? 'failed',
          meta: {
            direction: row.direction,
            kind: row.kind,
            path: row.path,
            step_id: row.step_id,
            tool_call_id: row.tool_call_id,
            source: row.source,
            ...(row.size_bytes === null ? { size_known: false } : {}),
          },
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
  );

  // Events: 30 days, except while the run is active or an outbox row still waits on the event.
  const pendingEvents = new Set<string>();
  if (ctx.sourceTables.has('runtime_outbox')) {
    for await (const rows of ctx.source`SELECT event_id FROM runtime_outbox WHERE status <> 'delivered'`.cursor(5000)) {
      for (const row of rows) pendingEvents.add(String(row.event_id));
    }
  }
  const cutoff = ctx.daysAgo(30);
  await carry(ctx, 'runtime_events', 'run_events', (row) => {
    if (!runs.has(String(row.run_id))) return 'run not carried';
    const old = new Date(row.created_at as string) < cutoff;
    if (old && TERMINAL.has(runStatus.get(String(row.run_id)) ?? '') && !pendingEvents.has(String(row.id))) {
      return 'run event older than 30 days';
    }
    return { ...row, payload: json(row.payload, {}, 'event payload') };
  });
  const events = ctx.idSet('run_events');
  await carry(ctx, 'runtime_outbox', 'run_outbox', (row) =>
    row.status === 'delivered'
      ? 'delivered outbox'
      : !events.has(String(row.event_id))
        ? 'event not carried'
        : { ...row, payload: json(row.payload, {}, 'outbox payload') },
  );
}

async function carryNotifications(ctx: Ctx): Promise<void> {
  const users = ctx.idSet('users');
  await carry(ctx, 'notifications', 'notifications', (row) => ({
    ...row,
    payload: parseJson(row.payload, {}, ctx, 'notification payload'),
  }));
  const notifications = ctx.idSet('notifications');
  await carry(ctx, 'notification_delivery_attempts', 'notification_deliveries', (row) =>
    !notifications.has(String(row.notification_id)) ? 'notification not carried' : row,
  );
  await carry(ctx, 'push_devices', 'push_devices', (row) =>
    !users.has(String(row.user_id))
      ? 'user no longer exists'
      : { ...row, prefs: parseJson(row.prefs, {}, ctx, 'push prefs') },
  );
}

async function carryUsage(ctx: Ctx): Promise<void> {
  const priceApplied = (value: unknown) =>
    value === null || value === undefined ? null : parseJson(value, null, ctx, 'price_applied');
  await carry(ctx, 'llm_usage', 'usage_events', (row) => ({
    id: strReq(row.id),
    kind: 'model',
    service: row.service ?? null,
    model: row.model,
    profile_id: row.profile_id,
    caller: row.caller,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cached_tokens: row.cached_tokens,
    reasoning_tokens: row.reasoning_tokens,
    duration_ms: row.duration_ms,
    cost_usd_micros: row.cost_usd_micros,
    price_applied: priceApplied(row.price_applied),
    user_id: row.user_id,
    client: row.client,
    oauth_client_id: row.oauth_client_id,
    gateway_key_id: row.gateway_key_id,
    session_id: row.session_id,
    budget_idempotency_key: row.budget_idempotency_key,
    detail: {},
    created_at: row.created_at,
  }));
  await carry(ctx, 'service_usage', 'usage_events', (row) => ({
    id: strReq(row.id),
    kind: 'service',
    service: row.service,
    provider: row.provider,
    model: row.model,
    caller: row.caller,
    units: row.units,
    unit_kind: row.unit_kind,
    cost_usd_micros: row.cost_usd_micros,
    price_applied: priceApplied(row.price_applied),
    user_id: row.user_id,
    client: row.client,
    oauth_client_id: row.oauth_client_id,
    run_id: row.run_id,
    session_id: row.session_id,
    budget_idempotency_key: row.budget_idempotency_key,
    detail: parseJson(row.metadata, {}, ctx, 'service_usage.metadata'),
    created_at: row.created_at,
  }));
  await carry(ctx, 'llm_calls', 'usage_events', (row) => ({
    id: strReq(row.id),
    kind: 'audit',
    service: 'call_llm',
    caller: 'call_llm',
    model: row.model,
    units: 0,
    cost_usd_micros: null,
    user_id: row.user_id,
    session_id: row.session_id,
    duration_ms: row.duration_ms,
    detail: stripNul({
      system: row.system ?? null,
      input: row.input,
      output: row.output ?? null,
      status: row.status ?? 'ok',
      error: row.error ?? null,
      input_tokens: row.input_tokens ?? null,
      output_tokens: row.output_tokens ?? null,
    }),
    created_at: row.created_at,
  }));

  await carry(ctx, 'usage_budget_accounts', 'budgets', (row) =>
    row.scope_type === 'user' && row.unit === 'tokens'
      ? 'per-member token account (retired; USD member budgets replace it)'
      : {
          id: strReq(row.id),
          kind: 'account',
          scope_type: row.scope_type,
          scope_id: row.scope_id,
          unit: row.unit,
          status: row.status,
          period_start: row.period_start,
          period_end: row.period_end,
          limit_units: row.limit_units,
          reserved_units: row.reserved_units,
          spent_units: row.spent_units,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
  );
  await carry(ctx, 'usage_budget_limits', 'budgets', (row) => ({
    id: strReq(row.id),
    kind: 'limit',
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    unit: row.unit,
    status: 'active',
    period_start: null,
    period_end: null,
    limit_units: row.limit_units,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  const budgets = ctx.idSet('budgets');
  await carry(ctx, 'usage_budget_reservations', 'budget_reservations', (row) =>
    !budgets.has(String(row.account_id))
      ? 'account not carried'
      : { ...row, metadata: parseJson(row.metadata, {}, ctx, 'reservation metadata') },
  );
  await carry(ctx, 'usage_budget_ledger', 'budget_ledger', (row) =>
    !budgets.has(String(row.account_id))
      ? 'account not carried'
      : { ...row, id: strReq(row.id), metadata: parseJson(row.metadata, {}, ctx, 'ledger metadata') },
  );
  await carry(ctx, 'usage_price_overrides', 'prices', (row) => row);
  await carry(ctx, 'usage_counters', 'module_usage_daily', (row) => (isDay(row.day) ? row : 'unparseable day'));
}

async function carryMisc(ctx: Ctx): Promise<void> {
  const users = ctx.idSet('users');
  await carry(ctx, 'email_accounts', 'email_accounts', (row) => {
    if (!users.has(String(row.user_id))) return 'user no longer exists';
    const { password_encrypted, ...rest } = row;
    return { ...rest, id: strReq(row.id), password_enc: password_encrypted };
  });
  await carry(ctx, 'member_computers', 'member_computers', (row) =>
    !users.has(String(row.user_id)) ? 'user no longer exists' : row,
  );
  await carry(ctx, 'report_templates', 'report_templates', (row) => ({
    ...row,
    formats: parseJson(row.formats, [], ctx, 'report formats'),
    sections: parseJson(row.sections, [], ctx, 'report sections'),
    cover_fields: parseJson(row.cover_fields, [], ctx, 'report cover fields'),
  }));
  await carry(ctx, 'agent_skills', 'skills', (row) => ({
    ...row,
    id: strReq(row.id),
    tags: parseJson(row.tags, [], ctx, 'skill tags'),
    scan_findings: parseJson(row.scan_findings, [], ctx, 'skill scan findings'),
  }));
  const skills = ctx.idSet('skills');
  await carry(ctx, 'agent_skill_versions', 'skill_versions', (row) =>
    !skills.has(String(row.skill_id))
      ? 'skill not carried'
      : { ...row, id: strReq(row.id), skill_id: strReq(row.skill_id) },
  );
  await carry(ctx, 'user_prompts', 'prompts', (row) => ({
    ...row,
    id: strReq(row.id),
    variables: parseJson(row.variables, [], ctx, 'prompt variables'),
    expected_tools: parseJson(row.expected_tools, [], ctx, 'prompt expected_tools'),
  }));
  // superseded_by is a self FK: rows without a successor first.
  await carry(
    ctx,
    'user_memories',
    'memories',
    (row) =>
      !users.has(String(row.user_id))
        ? 'user no longer exists'
        : { ...row, id: strReq(row.id), superseded_by: null, _superseded_by: row.superseded_by },
    'id',
  );
  if (!ctx.dryRun && ctx.target && ctx.sourceTables.has('user_memories')) {
    const links = await ctx.source`SELECT id, superseded_by FROM user_memories WHERE superseded_by IS NOT NULL`;
    const memories = ctx.idSet('memories');
    for (const link of links) {
      if (!memories.has(String(link.id)) || !memories.has(String(link.superseded_by))) continue;
      await ctx.target`UPDATE memories SET superseded_by = ${String(link.superseded_by)} WHERE id = ${String(link.id)}`;
    }
  }
  await carry(ctx, 'workspace_settings', 'workspace_settings', (row) => row);
}

// ─── orchestration ────────────────────────────────────────

async function sameDatabase(a: Sql, b: Sql): Promise<boolean> {
  const [left] =
    await a`SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sys`;
  const [right] =
    await b`SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sys`;
  return left?.db === right?.db && left?.sys === right?.sys;
}

async function publicTables(sql: Sql): Promise<Set<string>> {
  const rows = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  return new Set(rows.map((row) => String(row.tablename)));
}

/** Tables the 1.x core chain owns: every CREATE / DROP in chain order, statement by statement. */
export function v1CoreTables(folder = V1_ARCHIVE_FOLDER): Set<string> {
  const owned = new Set<string>();
  const statement = /(CREATE|DROP) TABLE\s+(?:IF (?:NOT )?EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  for (const file of readCoreMigrations(folder)) {
    const text = readFileSync(join(folder, `${file.tag}.sql`), 'utf8');
    for (const match of text.matchAll(statement)) {
      if (match[1]!.toUpperCase() === 'CREATE') owned.add(match[2]!);
      else owned.delete(match[2]!);
    }
  }
  return owned;
}

async function describeTarget(target: Sql): Promise<Map<string, TargetTable>> {
  const rows = await target`
    SELECT table_name, column_name, data_type, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`;
  const tables = new Map<string, TargetTable>();
  for (const row of rows) {
    const name = String(row.table_name);
    let table = tables.get(name);
    if (!table) {
      table = { columns: [], jsonb: new Set() };
      tables.set(name, table);
    }
    if (row.is_generated === 'ALWAYS') continue;
    table.columns.push(String(row.column_name));
    if (row.data_type === 'jsonb') table.jsonb.add(String(row.column_name));
  }
  return tables;
}

export async function carryFrom1x(options: CarryOptions): Promise<CarryReport> {
  const log = options.log ?? (() => {});
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  if (!dryRun && !options.to) throw new CarryError('--to is required (unless --dry-run)');
  const source = postgres(options.from, { max: 2, onnotice: () => {} });
  const target = options.to ? postgres(options.to, { max: 2, onnotice: () => {} }) : null;
  const startedAt = new Date().toISOString();
  try {
    // ── source must be 1.6.x ──
    const generation = await detectDatabaseGeneration(source);
    if (generation.kind === 'v2') {
      throw new CarryError('The source is a Greenhouse 2.x database; migrate-from-1x only accepts 1.6.x.');
    }
    if (generation.kind !== 'v1') {
      throw new CarryError(`The source is not a Greenhouse 1.x database (detected: ${generation.kind}).`);
    }
    if (!generation.current) {
      throw new CarryError(
        `The source has 1.x migrations only through ${generation.latest ?? 'none'}; upgrade it to 1.6.x ` +
          `(${V1_LATEST_TAG}) with the 1.6 release first.`,
      );
    }

    // ── target must be empty or 3.0, and not the source ──
    if (target) {
      if (await sameDatabase(source, target)) throw new CarryError('--from and --to are the same database.');
      const targetGeneration = await detectDatabaseGeneration(target);
      if (targetGeneration.kind === 'v1' || targetGeneration.kind === 'v2' || targetGeneration.kind === 'unknown') {
        throw new CarryError(
          `The target must be an empty or a 3.0 database (detected: ${targetGeneration.kind}). Create a new database for 3.0.`,
        );
      }
      if (!dryRun && targetGeneration.kind === 'empty') {
        log('Applying the 3.0 baseline to the target…');
        await applyMigrations(options.to!);
      }
    }

    const sourceTables = await publicTables(source);
    const coreTables = v1CoreTables();
    const extensionTables = discoverExtensionTables(sourceTables, coreTables);
    const ctx = new Ctx(source, target, dryRun, now, sourceTables, log);

    if (target && !dryRun) {
      const targetMeta = await describeTarget(target);
      // Idempotent: empty every 3.0 table and drop previously copied extension tables.
      const v3Tables = [...targetMeta.keys()].filter((name) => !extensionTables.includes(name));
      const clash = extensionTables.filter((name) => name !== 'extension_migrations' && coreV3Names.has(name));
      if (clash.length > 0) throw new CarryError(`Extension tables clash with 3.0 core tables: ${clash.join(', ')}`);
      log('Emptying the target…');
      await dropTables(target, extensionTables);
      if (v3Tables.length > 0) {
        await target.unsafe(`TRUNCATE TABLE ${v3Tables.map((name) => `"${name}"`).join(', ')} CASCADE`);
      }
      for (const [name, meta] of await describeTarget(target)) ctx.targetTables.set(name, meta);
    }

    const retired: CarryReport['retired'] = [];
    for (const [table, reason] of Object.entries(RETIRED_TABLES)) {
      if (!sourceTables.has(table)) continue;
      retired.push({ table, rows: await countRows(source, table), reason });
    }

    log('Identity and access…');
    await carryIdentity(ctx);
    await carryAccess(ctx);
    await carryOAuth(ctx);
    log('Conversations…');
    await carryConversations(ctx);
    log('Folders and files…');
    await carryFiles(ctx);
    log('Knowledge…');
    await carryKnowledge(ctx);
    log('Tables…');
    await carryTables(ctx);
    log('Projects…');
    await carryProjects(ctx);
    log('Audit and feedback…');
    await carryAudit(ctx);
    await carryFeedback(ctx);
    log('Automations and agents…');
    await carryAutomations(ctx);
    log('Runs…');
    await carryRuns(ctx);
    log('Notifications…');
    await carryNotifications(ctx);
    log('Usage and budgets…');
    await carryUsage(ctx);
    log('Everything else…');
    await carryMisc(ctx);

    log('Extension tables…');
    const extensions = await copyExtensionTables(source, dryRun ? null : target, extensionTables, log, (text) =>
      ctx.note(text),
    );

    // Source tables nobody read: a 1.x table this carry does not know is a bug, not data loss to hide.
    const handled = new Set([...ctx.lines.values()].map((line) => line.source));
    for (const table of coreTables) {
      if (!sourceTables.has(table) || handled.has(table) || RETIRED_TABLES[table]) continue;
      ctx.notes.set(`1.x table ${table} has no carry rule (${await countRows(source, table)} rows not carried)`, 1);
    }

    const targetCounts: Record<string, number> = {};
    if (target && !dryRun) {
      for (const name of [...ctx.targetTables.keys()].sort()) {
        if (name === 'extension_migrations') continue;
        targetCounts[name] = await countRows(target, name);
      }
    }

    return {
      dryRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceVersion: generation.latest ?? 'unknown',
      lines: [...ctx.lines.values()],
      retired,
      extensions,
      notes: [...ctx.notes.entries()].map(([text, count]) => (count > 1 ? `${text} (×${count})` : text)),
      targetCounts,
    };
  } finally {
    await source.end();
    await target?.end();
  }
}

/** Names of the 3.0 core tables (an extension table must not reuse one). */
const coreV3Names = new Set([
  'users',
  'auth_refresh_tokens',
  'password_links',
  'login_states',
  'rate_limits',
  'roles',
  'role_members',
  'role_capabilities',
  'role_entity_policies',
  'user_grants',
  'oauth_clients',
  'oauth_grants',
  'oauth_codes',
  'oauth_tokens',
  'gateway_keys',
  'provider_connections',
  'conversations',
  'messages',
  'conversation_shares',
  'conversation_share_reads',
  'card_action_receipts',
  'runs',
  'run_steps',
  'run_tool_calls',
  'run_interrupts',
  'run_events',
  'run_outbox',
  'automations',
  'automation_occurrences',
  'run_profiles',
  'kb_documents',
  'kb_versions',
  'folders',
  'files',
  'file_links',
  'shares',
  'projects',
  'project_members',
  'tasks',
  'task_comments',
  'table_bases',
  'table_tables',
  'table_fields',
  'table_field_dependencies',
  'table_views',
  'table_records',
  'table_record_links',
  'table_schema_versions',
  'table_recompute_jobs',
  'notifications',
  'notification_deliveries',
  'push_devices',
  'usage_events',
  'budgets',
  'budget_reservations',
  'budget_ledger',
  'prices',
  'module_usage_daily',
  'audit_events',
  'request_log',
  'feedback',
  'email_accounts',
  'feishu_conversations',
  'feishu_receipts',
  'member_computers',
  'report_templates',
  'skills',
  'skill_versions',
  'prompts',
  'memories',
  'workspace_settings',
  'extension_migrations',
]);
