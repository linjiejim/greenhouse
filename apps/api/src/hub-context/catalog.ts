/**
 * Data catalog (数据目录) — what data the team has, as one member may see it,
 * and how that member's agent reaches each source.
 *
 * Two kinds of source, both read through the owner's existing permission rules:
 *   • Tables bases: listed by the Tables application's own `listBases` dispatch
 *     (base roles and entity policies apply), with per-table row counts and last
 *     change — counts only, never a record value.
 *   • Extension data: every active extension that registers search sources,
 *     export sources or MCP tools, listed only when the member reaches at least
 *     one of its MCP tools (its feature flag / platform capabilities decide).
 *
 * `reachable` is the caller's MCP tool set: a real token's tools on `/api/mcp`
 * (so a grant without `mcp:tables` lists no bases), or every tool the member's
 * own permissions allow for the web page. Nothing here widens either.
 */

import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import type { ActorContext } from '@greenhouse/platform-kernel';
import type {
  DataCatalog,
  DataCatalogBase,
  DataCatalogExtensionSource,
  DataCatalogReach,
} from '@greenhouse/types/hub-context';
import { getToolMeta } from '../tools/registry.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import { EXTENSIONS } from '../extensions/index.js';

/** Bases beyond this are cut (the catalog says so); tables per base likewise. */
const MAX_BASES = 100;
const MAX_TABLES_PER_BASE = 50;

const EDIT_ROLES = new Set(['editor', 'builder', 'owner']);

export interface CatalogInput {
  db: DatabaseProvider;
  /** Who is asking — a human for the web page, the delegated agent on MCP. */
  actor: ActorContext;
  /** The MCP tools the caller reaches (see module doc). */
  reachable: ReadonlySet<string>;
  /** False skips the per-table row counts (a summary only needs the list). */
  counts?: boolean;
}

/** The first sentence of a tool description: enough to say what it is for. */
function firstSentence(text: string): string {
  const match = /^(.{20,200}?[.。])(\s|$)/s.exec(text.trim());
  const sentence = (match ? match[1]! : text.trim()).replace(/\s+/g, ' ');
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

function toolReach(toolId: string, how: string): DataCatalogReach | null {
  const meta = getToolMeta(toolId);
  if (!meta?.surface?.proxy) return null;
  return {
    tool: toolId,
    access: meta.surface.proxy === 'write' ? 'write' : 'read',
    group: typeof meta.surface.mcp === 'string' ? meta.surface.mcp : null,
    how,
  };
}

function ownerName(user: UserRow | undefined): string | null {
  if (!user) return null;
  return user.nickname || user.email || null;
}

function latest(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    const iso = new Date(value).toISOString();
    if (!best || iso > best) best = iso;
  }
  return best;
}

async function tablesBases(input: CatalogInput): Promise<{ bases: DataCatalogBase[]; truncated: boolean }> {
  if (!input.reachable.has('tables_query')) return { bases: [], truncated: false };
  const listed = await getPlatformRuntime().dispatch({
    actor: input.actor,
    appId: 'tables',
    actionId: 'listBases',
    payload: {},
  });
  if (!listed.ok) return { bases: [], truncated: false };
  const all = (
    listed.data as {
      bases: Array<{
        id: number;
        name: string;
        description: string | null;
        visibility: 'private' | 'team';
        owner_id: string;
        updated_at: string;
        role: string;
      }>;
    }
  ).bases;
  const picked = all.slice(0, MAX_BASES);
  const tablesByBase = new Map(
    await Promise.all(
      picked.map(
        async (base) => [base.id, (await input.db.tables.listTables(base.id)).slice(0, MAX_TABLES_PER_BASE)] as const,
      ),
    ),
  );
  const tableIds = [...tablesByBase.values()].flat().map((table) => table.id);
  const stats = new Map(
    (input.counts === false ? [] : await input.db.tables.recordStats(tableIds)).map((row) => [row.table_id, row]),
  );
  const ownerIds = [...new Set(picked.map((base) => base.owner_id))];
  const owners = new Map(
    (await Promise.all(ownerIds.map((id) => input.db.users.getById(id)))).flatMap((user) =>
      user ? [[user.id, user] as const] : [],
    ),
  );
  const canWrite = input.reachable.has('tables_mutation');

  const bases = picked.map((base): DataCatalogBase => {
    const tables = (tablesByBase.get(base.id) ?? []).map((table) => {
      const stat = stats.get(table.id);
      return {
        id: table.id,
        name: table.name,
        row_count: stat?.row_count ?? 0,
        last_changed_at: latest(stat?.last_changed_at, table.updated_at),
      };
    });
    const reach = [
      toolReach(
        'tables_query',
        `tables_query action=tables.list base_id=${base.id}, then schema.get / records.query with a table_id`,
      ),
      canWrite && EDIT_ROLES.has(base.role)
        ? toolReach('tables_mutation', `tables_mutation on table_id from this base (your role: ${base.role})`)
        : null,
    ].filter((entry): entry is DataCatalogReach => entry !== null);
    return {
      kind: 'tables_base',
      id: base.id,
      name: base.name,
      description: base.description ?? null,
      visibility: base.visibility,
      role: base.role,
      owner: owners.has(base.owner_id)
        ? { id: base.owner_id, name: ownerName(owners.get(base.owner_id)) ?? base.owner_id }
        : null,
      last_changed_at: latest(base.updated_at, ...tables.map((table) => table.last_changed_at)),
      tables,
      url: `#/tables/${base.id}`,
      reach,
    };
  });
  return { bases, truncated: all.length > picked.length };
}

function extensionSources(reachable: ReadonlySet<string>): DataCatalogExtensionSource[] {
  const out: DataCatalogExtensionSource[] = [];
  for (const ext of EXTENSIONS) {
    const tools = (ext.tools ?? []).map((mod) => mod.meta).filter((meta) => meta.surface?.mcp && meta.surface.proxy);
    const searchKinds = (ext.searchSources ?? []).map((source) => source.kind);
    const exports = (ext.exportSources ?? []).map((source) => ({ type: source.type, describe: source.describe }));
    // Not a data source: an extension with no data tools, search lanes or exports.
    if (tools.length === 0 && searchKinds.length === 0 && exports.length === 0) continue;
    const reach = tools
      .filter((meta) => reachable.has(meta.id))
      .map((meta) => toolReach(meta.id, firstSentence(meta.description)))
      .filter((entry): entry is DataCatalogReach => entry !== null);
    // The member (or this grant) reaches none of its tools: not theirs to see.
    if (reach.length === 0) continue;
    if (exports.length > 0) {
      reach.push({
        tool: 'export_data',
        access: 'read',
        group: null,
        how: `In Greenhouse chat only: export_data with source type ${exports.map((entry) => entry.type).join(' / ')}`,
      });
    }
    out.push({
      kind: 'extension',
      id: ext.id,
      name: ext.name,
      description: ext.description ?? null,
      record_kinds: searchKinds,
      exports,
      reach,
    });
  }
  return out;
}

export async function buildDataCatalog(input: CatalogInput): Promise<DataCatalog> {
  const { bases, truncated } = await tablesBases(input);
  return {
    generated_at: new Date().toISOString(),
    bases,
    extensions: extensionSources(input.reachable),
    truncated,
  };
}
