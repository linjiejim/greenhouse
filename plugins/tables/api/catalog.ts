import type { CatalogInput } from '@greenhouse/api/extension-kit';
import { getPlatformRuntime } from '@greenhouse/api/extension-kit';
import type { UserRow } from '@greenhouse/api/extension-kit';
import type { TableDefinitionRow } from './schema.js';
import type { TableBaseRole } from '@greenhouse/types/tables';
import type { DataCatalogBase, DataCatalogReach } from '@greenhouse/types/hub-context';
import { services } from './services.js';
import { tablesQueryTool } from './tools/tables-query.js';
import { tablesMutationTool } from './tools/tables-mutation.js';
const MAX_BASES = 100;
const MAX_TABLES_PER_BASE = 50;
const EDIT_ROLES = new Set(['editor', 'builder', 'owner']);
function toolReach(toolId: string, how: string): DataCatalogReach | null {
  const meta = toolId === 'tables_query' ? tablesQueryTool.meta : tablesMutationTool.meta;
  return { tool: toolId, access: meta.surface?.proxy === 'write' ? 'write' : 'read', group: 'tables', how };
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

export async function tablesBases(input: CatalogInput): Promise<{ bases: DataCatalogBase[]; truncated: boolean }> {
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
        id: string;
        name: string;
        description: string | null;
        visibility: 'private' | 'team';
        owner_id: string;
        updated_at: string;
        role: TableBaseRole;
      }>;
    }
  ).bases;
  const picked = all.slice(0, MAX_BASES);
  const runtime = getPlatformRuntime();
  const tableTotals = new Map<string, number>();
  // Tables through the guarded listing (table entity policy, `tables.structure.read`),
  // never straight from the service.
  const tablesByBase = new Map(
    await Promise.all(
      picked.map(async (base) => {
        const result = await runtime.dispatch({
          actor: input.actor,
          appId: 'tables',
          actionId: 'listTables',
          payload: { baseId: base.id },
        });
        const tables = result.ok ? (result.data as { tables: TableDefinitionRow[] }).tables : [];
        tableTotals.set(base.id, tables.length);
        return [base.id, tables.slice(0, MAX_TABLES_PER_BASE)] as const;
      }),
    ),
  );
  // Row counts and record activity only where the member may read records:
  // record access is decided per base (base role + `tables.data.read` + the
  // record entity policy), so one guarded count on a table of the base answers
  // it for every table in that base. Elsewhere counts are left out, not zeroed.
  const recordsReadable = new Set<string>();
  if (input.counts !== false) {
    await Promise.all(
      picked.map(async (base) => {
        const probe = tablesByBase.get(base.id)?.[0];
        if (!probe) return;
        const result = await runtime.dispatch({
          actor: input.actor,
          appId: 'tables',
          actionId: 'aggregateRecords',
          payload: { tableId: probe.id, input: { operation: 'count' } },
        });
        if (result.ok) recordsReadable.add(base.id);
      }),
    );
  }
  const tableIds = picked
    .filter((base) => recordsReadable.has(base.id))
    .flatMap((base) => (tablesByBase.get(base.id) ?? []).map((table) => table.id));
  const stats = new Map((await services(input.db).tables.recordStats(tableIds)).map((row) => [row.table_id, row]));
  const ownerIds = [...new Set(picked.map((base) => base.owner_id))];
  const owners = new Map(
    (await Promise.all(ownerIds.map((id) => input.db.users.getById(id)))).flatMap((user) =>
      user ? [[user.id, user] as const] : [],
    ),
  );
  const canWrite = input.reachable.has('tables_mutation');

  const bases = picked.map((base): DataCatalogBase => {
    const readable = recordsReadable.has(base.id);
    const tables = (tablesByBase.get(base.id) ?? []).map((table) => {
      const stat = stats.get(table.id);
      return {
        id: table.id,
        name: table.name,
        row_count: readable ? (stat?.row_count ?? 0) : null,
        last_changed_at: latest(readable ? stat?.last_changed_at : null, table.updated_at),
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
      table_count: tableTotals.get(base.id) ?? tables.length,
      tables_truncated: (tableTotals.get(base.id) ?? tables.length) > tables.length,
      url: `#/tables/${base.id}`,
      reach,
    };
  });
  return { bases, truncated: all.length > picked.length };
}
