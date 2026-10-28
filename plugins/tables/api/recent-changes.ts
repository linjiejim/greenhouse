import {
  humanActor,
  userHasFeature,
  scanRecentChanges,
  recentChangeDraft,
  type DatabaseProvider,
  type PlatformRuntime,
  type RecentViewer,
  type RecentChangeWindow,
  type RecentChangeLane,
} from '@greenhouse/api/extension-kit';
import { services } from './services.js';
const MAX_BASES = 50;
const MAX_TABLES = 200;
const EMPTY_LANE: RecentChangeLane = { items: [], exhausted: true, frontier: null };
export async function tableChanges(
  db: DatabaseProvider,
  runtime: PlatformRuntime,
  viewer: RecentViewer,
  window: RecentChangeWindow,
  need: number,
): Promise<RecentChangeLane> {
  if (!(await userHasFeature(viewer.id, viewer.role, 'tables', db))) return EMPTY_LANE;
  const listed = await runtime.dispatch({
    actor: humanActor(viewer),
    appId: 'tables',
    actionId: 'listBases',
    payload: {},
  });
  if (!listed.ok) return EMPTY_LANE;
  const bases = (listed.data as { bases: Array<{ id: string }> }).bases.slice(0, MAX_BASES);
  const tables = new Map<string, { baseId: string; name: string }>();
  for (const base of bases) {
    for (const table of await services(db).tables.listTables(base.id)) {
      if (tables.size >= MAX_TABLES) break;
      tables.set(table.id, { baseId: base.id, name: table.name });
    }
  }
  return scanRecentChanges(
    window,
    need,
    (cursor, limit) =>
      services(db).tables.recentTableChanges({ tableIds: [...tables.keys()], since: window.since, cursor, limit }),
    async (rows) =>
      rows.map((row) => {
        const table = tables.get(row.table_id)!;
        return recentChangeDraft({
          id: row.key,
          source: 'person',
          at: row.at,
          actorId: row.updated_by,
          module: 'tables',
          verb: 'update',
          entity: 'tableRecords',
          action: 'updateRecords',
          target: {
            id: String(row.table_id),
            label: table.name,
            url: `#/tables/${table.baseId}/table/${row.table_id}`,
          },
          detail: String(row.records),
        });
      }),
  );
}
