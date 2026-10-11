/**
 * Who reaches a published app, and as which role (docs/specs/20261011-tables-apps.md
 * §3, D3) — the one place the gateway, notification recipients
 * (`canRecipientRead`'s app branch) and the realtime fan-out read app audiences.
 *
 * - **Live app**: published, not archived, on a live Base; its spec is the
 *   published version's verified text.
 * - **Role (D3)**: one role per person per app, by tier — their own audience
 *   row, else the group rows they are listed in (`group_members` only; the
 *   first matching role in the spec's role order), else the team row. The
 *   highest tier that has a row decides, even when its role key no longer
 *   exists in the live version (D4): that entry grants nothing, and falling
 *   through to a broader tier could grant more than the owner chose for them.
 * - **Compiled role**: the role's table rules normalized and compiled with THE
 *   access compiler against the Base's facts, once per role.
 *
 * Kernel ceilings (capabilities, the `record.values` policy) are the callers'
 * (`access.ts` for recipients, the gateway session for requests). This module
 * never imports `access.ts` — `access.ts` imports it for the recipient branch.
 */

import type { DatabaseProvider, TableAppAudienceRow, TableAppRow, TableBaseRow } from '@greenhouse/db';
import { findRole, pagesForRole, type AppPage, type AppRole, type AppSpec } from '@greenhouse/types/apps';
import {
  compileTableAccessScope,
  computeFieldAccess,
  normalizeAccessRules,
  ruleForTable,
  type TableAccessRules,
  type TableAccessSchemaFacts,
  type TableDataScope,
  type TableEffectiveFieldAccess,
} from '@greenhouse/types/table-access';
import { userHasFeature } from '../../auth/features.js';
import { parseStoredAppSpec } from './app-spec.js';
import { cardShownFieldIds, isRecordsCard, queryFieldIds, queryRowScopes, type RecordsLikeCard } from './app-scope.js';

type AudienceContext = { db: DatabaseProvider };

export interface LiveApp {
  app: TableAppRow;
  base: TableBaseRow;
  version: number;
  spec: AppSpec;
}

const EMPTY_RULES: TableAccessRules = { version: 1, tables: [], dashboards: 'none' };

/** The live app behind `app`: published, not archived, on a live Base, its version's spec verified. */
export async function liveAppOf(db: DatabaseProvider, app: TableAppRow): Promise<LiveApp | undefined> {
  if (app.status !== 'published' || !app.published_version || app.archived_at) return undefined;
  const [base, version] = await Promise.all([
    db.tables.getBase(app.base_id),
    db.tables.getAppVersion(app.id, app.published_version),
  ]);
  if (!base || base.archived_at || !version) return undefined;
  const spec = parseStoredAppSpec(version.spec);
  return spec ? { app, base, version: version.version, spec } : undefined;
}

/** Every live app on a Base. */
export async function liveAppsOnBase(db: DatabaseProvider, base: TableBaseRow): Promise<LiveApp[]> {
  if (base.archived_at) return [];
  const summaries = (await db.tables.listAppsForBase(base.id)).filter(
    (row) => row.status === 'published' && row.published_version !== null,
  );
  const live: LiveApp[] = [];
  for (const summary of summaries) {
    const app = await db.tables.getApp(summary.id);
    const found = app ? await liveAppOf(db, app) : undefined;
    if (found) live.push(found);
  }
  return live;
}

/** D3: the person's one role in an app from the audience rows that reach them. */
export function pickViewerRole(
  spec: AppSpec,
  matches: ReadonlyArray<Pick<TableAppAudienceRow, 'principal_type' | 'role_key'>>,
): AppRole | undefined {
  const own = matches.find((row) => row.principal_type === 'user');
  if (own) return findRole(spec, own.role_key);
  const groupKeys = new Set(matches.filter((row) => row.principal_type === 'group').map((row) => row.role_key));
  if (groupKeys.size > 0) return spec.roles.find((role) => groupKeys.has(role.key));
  const team = matches.find((row) => row.principal_type === 'team');
  return team ? findRole(spec, team.role_key) : undefined;
}

/** The person's role in a live app, or undefined (not in the audience, or their entry names a gone role). */
export async function viewerRoleIn(db: DatabaseProvider, live: LiveApp, userId: string): Promise<AppRole | undefined> {
  return pickViewerRole(live.spec, await db.tables.listAudienceMatches(live.app.id, userId));
}

/** A role's table rules as the compiler takes them; a malformed set grants nothing. */
export function appRoleRules(role: AppRole): TableAccessRules {
  const normalized = normalizeAccessRules({ version: 1, tables: role.tables, dashboards: 'none' });
  return normalized.ok ? normalized.rules : EMPTY_RULES;
}

/** A role compiled against one Base's facts. */
export interface CompiledAppRole {
  role: AppRole;
  rules: TableAccessRules;
  facts: TableAccessSchemaFacts;
  fieldAccess: ReadonlyMap<number, TableEffectiveFieldAccess>;
  /** The role's scope on `tableId` for `userId`; undefined = the role has no rule for that table. */
  scopeFor(tableId: number, userId: string): TableDataScope | undefined;
}

export function compileAppRole(role: AppRole, facts: TableAccessSchemaFacts): CompiledAppRole {
  const rules = appRoleRules(role);
  const fieldAccess = computeFieldAccess(rules, facts);
  return {
    role,
    rules,
    facts,
    fieldAccess,
    scopeFor: (tableId, userId) =>
      ruleForTable(rules, tableId) ? compileTableAccessScope(rules, tableId, facts, userId, fieldAccess) : undefined,
  };
}

/** Records-like cards on the pages a role sees (optionally only those reading `tableId`). */
export function recordCardsForRole(
  spec: AppSpec,
  role: AppRole,
  tableId?: number,
): Array<{ page: AppPage; card: RecordsLikeCard }> {
  return pagesForRole(spec, role).flatMap((page) =>
    page.cards.flatMap((card) =>
      isRecordsCard(card) && (tableId === undefined || card.source.tableId === tableId) ? [{ page, card }] : [],
    ),
  );
}

/**
 * `scope` narrowed to one records-like card: its query joins the read rows,
 * readable fields are cut to what the card shows. Undefined when the card's
 * query needs a field the role cannot read (the card is withheld from it).
 */
export function cardReadScope(scope: TableDataScope, card: RecordsLikeCard): TableDataScope | undefined {
  const readable = new Set(scope.readableFieldIds);
  if (queryFieldIds(card.source.query).some((id) => !readable.has(id))) return undefined;
  const shown = new Set(cardShownFieldIds(card));
  return {
    ...scope,
    rows: [...scope.rows, ...queryRowScopes(card.source.query)],
    readableFieldIds: scope.readableFieldIds.filter((id) => shown.has(id)),
  };
}

export interface AppRecordReach {
  appId: number;
  roleKey: string;
  /** Rows: the role's ∩ the card's; readable: the role's ∩ what the card shows. */
  scope: TableDataScope;
}

/**
 * Can `userId` open this record in some live app on its Base — their role has
 * a rule for the table, a records-like card on a page they see shows the
 * table, and the row is inside that card's scope? The first such card wins.
 * Kernel ceilings are the caller's; the `apps` feature flag is checked here
 * (without it the link would not open).
 */
export async function appReachForRecord(
  ctx: AudienceContext,
  userId: string,
  record: { id: number; table_id: number },
): Promise<AppRecordReach | null> {
  const table = await ctx.db.tables.getTable(record.table_id);
  const base = table ? await ctx.db.tables.getBase(table.base_id) : undefined;
  if (!table || !base || base.archived_at) return null;
  const apps = await liveAppsOnBase(ctx.db, base);
  if (apps.length === 0) return null;
  const user = await ctx.db.users.getById(userId);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) return null;
  if (!(await userHasFeature(user.id, user.role, 'apps', ctx.db))) return null;
  let facts: TableAccessSchemaFacts | undefined;
  for (const live of apps) {
    const role = await viewerRoleIn(ctx.db, live, userId);
    if (!role) continue;
    facts ??= await ctx.db.tables.loadAccessFacts(base.id);
    const scope = compileAppRole(role, facts).scopeFor(record.table_id, userId);
    if (!scope) continue;
    for (const { card } of recordCardsForRole(live.spec, role, record.table_id)) {
      const cardScope = cardReadScope(scope, card);
      if (!cardScope) continue;
      if (await ctx.db.tables.getRecord(record.table_id, record.id, cardScope)) {
        return { appId: live.app.id, roleKey: role.key, scope: cardScope };
      }
    }
  }
  return null;
}

/**
 * Of `userIds`, the people whose role in some live app on `base` has a rule
 * for `tableId` — they hear `tables:records_changed` for it (ids only; they
 * refetch through the gateway, which decides what they see).
 */
export async function appAudienceForTable(
  ctx: AudienceContext,
  base: TableBaseRow,
  tableId: number,
  userIds: readonly string[],
): Promise<Set<string>> {
  const reached = new Set<string>();
  if (userIds.length === 0) return reached;
  const apps = await liveAppsOnBase(ctx.db, base);
  for (const live of apps) {
    for (const userId of userIds) {
      if (reached.has(userId)) continue;
      const role = await viewerRoleIn(ctx.db, live, userId);
      if (role && ruleForTable(appRoleRules(role), tableId)) reached.add(userId);
    }
  }
  return reached;
}
