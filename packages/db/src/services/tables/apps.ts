/**
 * Apps (应用) on a Tables Base — storage for apps, drafts, immutable versions,
 * audiences, pins and the "which apps does this person see" queries
 * (docs/specs/20261011-tables-apps.md §1).
 *
 * Storage only. Validating a spec against the Base schema, deciding who may
 * manage / publish (Base owner / builder, owner or super for publish and
 * audiences — D2) and a viewer's role are the API's (`platform/tables/app-spec.ts`,
 * `handlers/apps.ts`). The rules this module keeps:
 *
 * - **Draft CAS**: every draft write names the `draft_revision` it was based
 *   on; a stale one is `conflict` with the current revision.
 * - **Versions are immutable and hashed**: publishing copies the draft text as
 *   is into a new version row, `spec_hash = sha256(spec)`, in the same
 *   transaction that moves `published_version` — the text is stored, not jsonb,
 *   so the bytes read back are the bytes hashed (D7). Every read of a version's
 *   spec verifies the hash and throws on a mismatch. Rolling back = copying a
 *   version into the draft and publishing again (D5): numbers only grow.
 * - **Audiences are replaced as a whole** under `audiences_revision` CAS.
 * - **Group reach is `group_members` rows only** (a group's creator is not a
 *   member unless listed), the same rule as Base group grants.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { APP_ACCENTS, APP_ICONS, APP_LIMITS, type AppAccent, type AppIconName } from '@greenhouse/types/apps';
import type { Db } from '../../client.js';
import {
  groupMembers,
  tableAppAudiences,
  tableAppPins,
  tableApps,
  tableAppVersions,
  tableBaseMembers,
  tableBases,
} from '../../schema/index.js';
import type {
  TableAppAudienceRow,
  TableAppPinRow,
  TableAppRow,
  TableAppVersionRow,
  TableAppCustomReviewRecord,
} from '../../schema/table-apps.js';
import { TablesValidationError, trimmed, type TableRevisionResult } from './shared.js';

/** An app without its draft text — what lists carry. */
export type TableAppSummaryRow = Omit<TableAppRow, 'draft_spec'>;

/** A version's metadata, without the spec text. */
export type TableAppVersionSummaryRow = Omit<TableAppVersionRow, 'spec'>;

export interface CreateTableAppInput {
  base_id: number;
  name: string;
  description?: string | null;
  icon?: AppIconName;
  accent?: AppAccent;
  owner_id: string;
  /** The first draft, as JSON text (validated by the caller). */
  draft_spec: string;
  created_by: string;
}

export interface UpdateTableAppInput {
  name?: string;
  description?: string | null;
  icon?: AppIconName;
  accent?: AppAccent;
}

export interface TableAppAudienceInput {
  principal_type: 'user' | 'group' | 'team';
  user_id?: string | null;
  group_id?: number | null;
  role_key: string;
}

export type PublishTableAppResult =
  | { ok: true; app: TableAppRow; version: TableAppVersionRow; pendingReview?: boolean }
  | { ok: false; reason: 'not_found' | 'archived' | 'audiences_changed' }
  | { ok: false; reason: 'conflict'; current: number };

export type RestoreTableAppVersionResult =
  | TableRevisionResult<TableAppRow>
  | { ok: false; reason: 'version_not_found' | 'archived' };

export type ReplaceTableAppAudiencesResult =
  | { ok: true; app: TableAppRow; audiences: TableAppAudienceRow[] }
  | { ok: false; reason: 'not_found' | 'archived' | 'publication_changed' }
  | { ok: false; reason: 'conflict'; current: number };

/** Hex sha256 of a spec's exact text — the one hash both publish and read use. */
export function appSpecHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A version's spec text after checking it is still the text that was hashed. */
export function verifiedAppVersionSpec(row: Pick<TableAppVersionRow, 'app_id' | 'version' | 'spec' | 'spec_hash'>) {
  if (appSpecHash(row.spec) !== row.spec_hash) {
    throw new Error(`App ${row.app_id} v${row.version}: spec hash mismatch`);
  }
  return row.spec;
}

const MAX_PINS = 50;
const MAX_AUDIENCE_ENTRIES = 600;

function appName(name: string): string {
  return trimmed(name, 'App name', APP_LIMITS.nameLength);
}

function appDescription(description: string | null | undefined): string | null {
  const value = description?.trim();
  return value ? value.slice(0, 500) : null;
}

function checkIcon(icon: string | undefined): AppIconName | undefined {
  if (icon === undefined) return undefined;
  if (!(APP_ICONS as readonly string[]).includes(icon)) throw new TablesValidationError(`Unknown app icon "${icon}"`);
  return icon as AppIconName;
}

function checkAccent(accent: string | undefined): AppAccent | undefined {
  if (accent === undefined) return undefined;
  if (!(APP_ACCENTS as readonly string[]).includes(accent)) {
    throw new TablesValidationError(`Unknown app accent "${accent}"`);
  }
  return accent as AppAccent;
}

function checkSpecText(text: string): string {
  if (typeof text !== 'string' || !text) throw new TablesValidationError('App spec is required');
  if (Buffer.byteLength(text, 'utf8') > APP_LIMITS.specBytes) {
    throw new TablesValidationError(`App spec exceeds ${APP_LIMITS.specBytes} bytes`);
  }
  return text;
}

/** One audience entry's row shape; the CHECK constraint enforces the same pairing. */
function audienceValues(appId: number, entry: TableAppAudienceInput, createdBy: string, now: string) {
  const roleKey = typeof entry.role_key === 'string' ? entry.role_key.trim() : '';
  if (!roleKey) throw new TablesValidationError('Audience role is required');
  const base = { app_id: appId, role_key: roleKey, created_by: createdBy, created_at: now };
  if (entry.principal_type === 'user' && entry.user_id) {
    return { ...base, principal_type: 'user' as const, user_id: entry.user_id, group_id: null };
  }
  if (entry.principal_type === 'group' && entry.group_id) {
    return { ...base, principal_type: 'group' as const, user_id: null, group_id: entry.group_id };
  }
  if (entry.principal_type === 'team')
    return { ...base, principal_type: 'team' as const, user_id: null, group_id: null };
  throw new TablesValidationError('Each audience entry needs a person, a group, or the team');
}

/** The audience key that makes two entries the same principal. */
function principalKey(entry: TableAppAudienceInput): string {
  return entry.principal_type === 'user'
    ? `user:${entry.user_id}`
    : entry.principal_type === 'group'
      ? `group:${entry.group_id}`
      : 'team';
}

export function createTablesApps(db: Db) {
  const { draft_spec: _draftSpec, ...summaryColumns } = getTableColumns(tableApps);
  const { spec: _spec, ...versionSummaryColumns } = getTableColumns(tableAppVersions);

  /** The person manages the app's Base: its owner, or an owner / builder member row (groups never hold builder). */
  const managesBase = (userId: string): SQL =>
    sql`(${tableBases.owner_id} = ${userId} OR EXISTS (
      SELECT 1 FROM ${tableBaseMembers} m
      WHERE m.base_id = ${tableApps.base_id} AND m.user_id = ${userId} AND m.role IN ('owner', 'builder')
    ))`;

  /** Some audience row of the app reaches the person: their own row, a group they are listed in, or the team. */
  const audienceReaches = (userId: string): SQL =>
    sql`EXISTS (
      SELECT 1 FROM ${tableAppAudiences} a
      WHERE a.app_id = ${tableApps.id} AND (
        (a.principal_type = 'user' AND a.user_id = ${userId})
        OR (a.principal_type = 'group' AND a.group_id IN (
          SELECT gm.group_id FROM ${groupMembers} gm WHERE gm.user_id = ${userId}
        ))
        OR a.principal_type = 'team'
      )
    )`;

  /** Published, live, on a live Base. */
  const live = (): SQL =>
    and(
      eq(tableApps.status, 'published'),
      sql`${tableApps.published_version} IS NOT NULL`,
      isNull(tableApps.archived_at),
      isNull(tableBases.archived_at),
    )!;

  const summaries = () =>
    db.select(summaryColumns).from(tableApps).innerJoin(tableBases, eq(tableBases.id, tableApps.base_id));

  async function lockApp(tx: Pick<Db, 'select'>, appId: number): Promise<TableAppRow | undefined> {
    const [row] = await tx.select().from(tableApps).where(eq(tableApps.id, appId)).limit(1).for('update');
    return row;
  }

  const service = {
    // ─── Apps ─────────────────────────────────────────────

    async createApp(input: CreateTableAppInput): Promise<TableAppRow> {
      const now = nowIso();
      const [row] = await db
        .insert(tableApps)
        .values({
          base_id: input.base_id,
          name: appName(input.name),
          description: appDescription(input.description),
          icon: checkIcon(input.icon) ?? 'app',
          accent: checkAccent(input.accent) ?? 'brand',
          owner_id: input.owner_id,
          status: 'draft',
          draft_spec: checkSpecText(input.draft_spec),
          draft_revision: 1,
          audiences_revision: 1,
          featured: false,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    /** Any app by id, archived included (callers decide what an archived app means). */
    async getApp(appId: number): Promise<TableAppRow | undefined> {
      const [row] = await db.select().from(tableApps).where(eq(tableApps.id, appId)).limit(1);
      return row;
    },

    /** A Base's apps, newest first; archived ones only on request. */
    async listAppsForBase(baseId: number, options: { includeArchived?: boolean } = {}): Promise<TableAppSummaryRow[]> {
      return db
        .select(summaryColumns)
        .from(tableApps)
        .where(and(eq(tableApps.base_id, baseId), options.includeArchived ? undefined : isNull(tableApps.archived_at)))
        .orderBy(desc(tableApps.updated_at), desc(tableApps.id));
    },

    /** Name, description, icon, accent. Undefined when the app is gone or archived. */
    async updateApp(appId: number, patch: UpdateTableAppInput): Promise<TableAppRow | undefined> {
      const values: Partial<typeof tableApps.$inferInsert> = { updated_at: nowIso() };
      if (patch.name !== undefined) values.name = appName(patch.name);
      if (patch.description !== undefined) values.description = appDescription(patch.description);
      if (patch.icon !== undefined) values.icon = checkIcon(patch.icon);
      if (patch.accent !== undefined) values.accent = checkAccent(patch.accent);
      const [row] = await db
        .update(tableApps)
        .set(values)
        .where(and(eq(tableApps.id, appId), isNull(tableApps.archived_at)))
        .returning();
      return row;
    },

    /** Replace the draft text if it is still at `draftRevision`; bumps the revision. */
    async saveAppDraft(
      appId: number,
      input: { spec: string; draftRevision: number },
    ): Promise<TableRevisionResult<TableAppRow> | { ok: false; reason: 'archived' }> {
      const spec = checkSpecText(input.spec);
      const [row] = await db
        .update(tableApps)
        .set({ draft_spec: spec, draft_revision: sql`${tableApps.draft_revision} + 1`, updated_at: nowIso() })
        .where(
          and(
            eq(tableApps.id, appId),
            eq(tableApps.draft_revision, input.draftRevision),
            isNull(tableApps.archived_at),
          ),
        )
        .returning();
      if (row) return { ok: true, value: row };
      const current = await service.getApp(appId);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.archived_at) return { ok: false, reason: 'archived' };
      return { ok: false, reason: 'conflict', current: current.draft_revision };
    },

    /**
     * Publish the draft as the next version, if the draft is still at
     * `draftRevision`: the version row stores the draft text verbatim with its
     * hash, and `published_version` moves in the same transaction.
     */
    async publishApp(
      appId: number,
      input: {
        draftRevision: number;
        notes?: string | null;
        publishedBy: string;
        /** Checked audience snapshot; a concurrent sharing change must be re-authorized. */
        audiencesRevision?: number;
        customCode?: { requireReview: boolean };
      },
    ): Promise<PublishTableAppResult> {
      return db.transaction(async (tx) => {
        const app = await lockApp(tx, appId);
        if (!app) return { ok: false, reason: 'not_found' } as const;
        if (app.archived_at) return { ok: false, reason: 'archived' } as const;
        if (app.draft_revision !== input.draftRevision) {
          return { ok: false, reason: 'conflict', current: app.draft_revision } as const;
        }
        if (input.audiencesRevision !== undefined && app.audiences_revision !== input.audiencesRevision) {
          return { ok: false, reason: 'audiences_changed' } as const;
        }
        const hash = appSpecHash(app.draft_spec);
        const matching = input.customCode
          ? await tx
              .select()
              .from(tableAppVersions)
              .where(and(eq(tableAppVersions.app_id, appId), eq(tableAppVersions.spec_hash, hash)))
              .orderBy(desc(tableAppVersions.version))
          : [];
        for (const row of matching) verifiedAppVersionSpec(row);
        const approved = matching.find(
          (row) => row.custom_review?.status === 'approved' && row.custom_review.hash === hash,
        );
        const review: TableAppCustomReviewRecord | undefined = input.customCode
          ? (approved?.custom_review ?? { status: 'pending', hash })
          : undefined;
        const pendingReview = !!input.customCode?.requireReview && !approved;
        const pending = matching.find((row) => row.draft_revision === app.draft_revision);
        if (pendingReview && pending) return { ok: true, app, version: pending, pendingReview: true } as const;
        const [last] = await tx
          .select({ version: sql<number>`coalesce(max(${tableAppVersions.version}), 0)` })
          .from(tableAppVersions)
          .where(eq(tableAppVersions.app_id, appId));
        const nextVersion = Number(last?.version ?? 0) + 1;
        const now = nowIso();
        const notes = input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null;
        const [version] = await tx
          .insert(tableAppVersions)
          .values({
            app_id: appId,
            version: nextVersion,
            spec: app.draft_spec,
            spec_hash: hash,
            custom_review: review ?? null,
            draft_revision: app.draft_revision,
            notes,
            published_by: input.publishedBy,
            published_at: now,
          })
          .returning();
        if (pendingReview) return { ok: true, app, version: version!, pendingReview: true } as const;
        const [updated] = await tx
          .update(tableApps)
          .set({ published_version: nextVersion, status: 'published', updated_at: now })
          .where(eq(tableApps.id, appId))
          .returning();
        return { ok: true, app: updated!, version: version! } as const;
      });
    },

    /** Review queue, including past decisions; only the API's super handler exposes it. */
    async listAppCustomReviews(): Promise<Array<{ app: TableAppSummaryRow; version: TableAppVersionRow }>> {
      const rows = await db
        .select({ app: summaryColumns, version: getTableColumns(tableAppVersions) })
        .from(tableAppVersions)
        .innerJoin(tableApps, eq(tableApps.id, tableAppVersions.app_id))
        .innerJoin(tableBases, eq(tableBases.id, tableApps.base_id))
        .where(
          and(
            sql`${tableAppVersions.custom_review} IS NOT NULL`,
            isNull(tableApps.archived_at),
            isNull(tableBases.archived_at),
          ),
        )
        .orderBy(desc(tableAppVersions.published_at))
        .limit(200);
      for (const row of rows) verifiedAppVersionSpec(row.version);
      return rows;
    },

    /** The app row lock serializes a hash-level decision with publishing. */
    async reviewAppCustomCode(
      appId: number,
      input: {
        version: number;
        hash: string;
        decision: 'approve' | 'reject';
        reviewerId: string;
        note?: string;
      },
    ): Promise<TableAppVersionRow | undefined> {
      return db.transaction(async (tx) => {
        const app = await lockApp(tx, appId);
        if (!app || app.archived_at) return undefined;
        const [version] = await tx
          .select()
          .from(tableAppVersions)
          .where(and(eq(tableAppVersions.app_id, appId), eq(tableAppVersions.version, input.version)))
          .limit(1);
        if (!version || !version.custom_review || version.spec_hash !== input.hash) return undefined;
        verifiedAppVersionSpec(version);
        const review: TableAppCustomReviewRecord = {
          status: input.decision === 'approve' ? 'approved' : 'rejected',
          hash: input.hash,
          reviewed_by: input.reviewerId,
          reviewed_at: nowIso(),
          ...(input.note ? { note: input.note } : {}),
        };
        const rows = await tx
          .update(tableAppVersions)
          .set({ custom_review: review })
          .where(and(eq(tableAppVersions.app_id, appId), eq(tableAppVersions.spec_hash, input.hash)))
          .returning();
        return rows.find((row) => row.version === input.version);
      });
    },

    /** Version metadata, newest first (no spec text). */
    async listAppVersions(appId: number): Promise<TableAppVersionSummaryRow[]> {
      return db
        .select(versionSummaryColumns)
        .from(tableAppVersions)
        .where(eq(tableAppVersions.app_id, appId))
        .orderBy(desc(tableAppVersions.version));
    },

    /** One version with its spec text, hash verified (throws on a mismatch). */
    async getAppVersion(appId: number, version: number): Promise<TableAppVersionRow | undefined> {
      const [row] = await db
        .select()
        .from(tableAppVersions)
        .where(and(eq(tableAppVersions.app_id, appId), eq(tableAppVersions.version, version)))
        .limit(1);
      if (row) verifiedAppVersionSpec(row);
      return row;
    },

    /** The live version of an app (hash verified), or undefined before its first publish. */
    async getPublishedAppVersion(appId: number): Promise<TableAppVersionRow | undefined> {
      const app = await service.getApp(appId);
      return app?.published_version ? service.getAppVersion(appId, app.published_version) : undefined;
    },

    /** The live versions of many apps in one query (hash verified); apps never published have none. */
    async listPublishedAppVersions(appIds: readonly number[]): Promise<TableAppVersionRow[]> {
      if (appIds.length === 0) return [];
      const rows = await db
        .select(getTableColumns(tableAppVersions))
        .from(tableAppVersions)
        .innerJoin(
          tableApps,
          and(eq(tableApps.id, tableAppVersions.app_id), eq(tableApps.published_version, tableAppVersions.version)),
        )
        .where(inArray(tableAppVersions.app_id, [...new Set(appIds)]));
      for (const row of rows) verifiedAppVersionSpec(row);
      return rows;
    },

    /** Copy a version's spec into the draft (draft CAS). Publishing it makes a new, higher version (D5). */
    async restoreAppVersion(
      appId: number,
      input: { version: number; draftRevision: number },
    ): Promise<RestoreTableAppVersionResult> {
      const version = await service.getAppVersion(appId, input.version);
      if (!version) {
        return (await service.getApp(appId))
          ? { ok: false, reason: 'version_not_found' }
          : { ok: false, reason: 'not_found' };
      }
      return service.saveAppDraft(appId, { spec: version.spec, draftRevision: input.draftRevision });
    },

    async archiveApp(appId: number): Promise<TableAppRow | undefined> {
      const now = nowIso();
      const [row] = await db
        .update(tableApps)
        .set({ status: 'archived', archived_at: now, featured: false, updated_at: now })
        .where(and(eq(tableApps.id, appId), isNull(tableApps.archived_at)))
        .returning();
      return row;
    },

    async setAppFeatured(appId: number, featured: boolean): Promise<TableAppRow | undefined> {
      const [row] = await db
        .update(tableApps)
        .set({ featured, updated_at: nowIso() })
        .where(and(eq(tableApps.id, appId), isNull(tableApps.archived_at)))
        .returning();
      return row;
    },

    /** Hand the app to another responsible person (the caller checks they may manage it). */
    async transferApp(appId: number, ownerId: string): Promise<TableAppRow | undefined> {
      const [row] = await db
        .update(tableApps)
        .set({ owner_id: ownerId, updated_at: nowIso() })
        .where(and(eq(tableApps.id, appId), isNull(tableApps.archived_at)))
        .returning();
      return row;
    },

    // ─── Audiences ────────────────────────────────────────

    async listAppAudiences(appId: number): Promise<TableAppAudienceRow[]> {
      return db
        .select()
        .from(tableAppAudiences)
        .where(eq(tableAppAudiences.app_id, appId))
        .orderBy(asc(tableAppAudiences.id));
    },

    /**
     * Replace every audience row if the app is still at `audiencesRevision`.
     * Duplicate principals are refused (one person / group / team row each).
     */
    async replaceAppAudiences(
      appId: number,
      input: {
        entries: readonly TableAppAudienceInput[];
        audiencesRevision: number;
        createdBy: string;
        publishedVersion?: number | null;
      },
    ): Promise<ReplaceTableAppAudiencesResult> {
      if (input.entries.length > MAX_AUDIENCE_ENTRIES) {
        throw new TablesValidationError(`An app has at most ${MAX_AUDIENCE_ENTRIES} audience entries`);
      }
      const seen = new Set<string>();
      for (const entry of input.entries) {
        const key = principalKey(entry);
        if (seen.has(key)) throw new TablesValidationError('Each person, group and the team may appear once');
        seen.add(key);
      }
      return db.transaction(async (tx) => {
        const app = await lockApp(tx, appId);
        if (!app) return { ok: false, reason: 'not_found' } as const;
        if (app.archived_at) return { ok: false, reason: 'archived' } as const;
        if (input.publishedVersion !== undefined && app.published_version !== input.publishedVersion) {
          return { ok: false, reason: 'publication_changed' } as const;
        }
        if (app.audiences_revision !== input.audiencesRevision) {
          return { ok: false, reason: 'conflict', current: app.audiences_revision } as const;
        }
        const now = nowIso();
        const values = input.entries.map((entry) => audienceValues(appId, entry, input.createdBy, now));
        await tx.delete(tableAppAudiences).where(eq(tableAppAudiences.app_id, appId));
        const audiences = values.length > 0 ? await tx.insert(tableAppAudiences).values(values).returning() : [];
        const [updated] = await tx
          .update(tableApps)
          .set({ audiences_revision: app.audiences_revision + 1, updated_at: now })
          .where(eq(tableApps.id, appId))
          .returning();
        return { ok: true, app: updated!, audiences: audiences.sort((a, b) => a.id - b.id) } as const;
      });
    },

    /**
     * The audience rows of one app that reach one person: their own row, the
     * rows of groups they are listed in (`group_members`), the team row. The
     * gateway picks the role from these (person > group in spec role order >
     * team, D3).
     */
    async listAudienceMatches(appId: number, userId: string): Promise<TableAppAudienceRow[]> {
      return service.listAudienceMatchesForApps([appId], userId);
    },

    /** `listAudienceMatches` for many apps in one query (a shelf resolves every app's role at once). */
    async listAudienceMatchesForApps(appIds: readonly number[], userId: string): Promise<TableAppAudienceRow[]> {
      if (appIds.length === 0) return [];
      return db
        .select()
        .from(tableAppAudiences)
        .where(
          and(
            inArray(tableAppAudiences.app_id, [...new Set(appIds)]),
            or(
              and(eq(tableAppAudiences.principal_type, 'user'), eq(tableAppAudiences.user_id, userId)),
              and(
                eq(tableAppAudiences.principal_type, 'group'),
                inArray(
                  tableAppAudiences.group_id,
                  db.select({ id: groupMembers.group_id }).from(groupMembers).where(eq(groupMembers.user_id, userId)),
                ),
              ),
              eq(tableAppAudiences.principal_type, 'team'),
            ),
          ),
        )
        .orderBy(asc(tableAppAudiences.id));
    },

    // ─── What a person sees ───────────────────────────────

    /**
     * Apps on live Bases the person may manage or answers for: the app's owner,
     * the Base owner, or an owner / builder member row. Candidates only — the
     * API still resolves the Base level (super, archived, kernel scope).
     */
    async listManagedApps(userId: string, options: { includeArchived?: boolean } = {}): Promise<TableAppSummaryRow[]> {
      return summaries()
        .where(
          and(
            isNull(tableBases.archived_at),
            options.includeArchived ? undefined : isNull(tableApps.archived_at),
            or(eq(tableApps.owner_id, userId), managesBase(userId)),
          ),
        )
        .orderBy(desc(tableApps.updated_at), desc(tableApps.id));
    },

    /** Published, live apps some audience row of which reaches the person. */
    async listAppsSharedWith(userId: string): Promise<TableAppSummaryRow[]> {
      return summaries()
        .where(and(live(), audienceReaches(userId)))
        .orderBy(asc(tableApps.name), asc(tableApps.id));
    },

    /** Featured, published, live apps the person is in the audience of or manages (recommendations are audience-only). */
    async listFeaturedAppsFor(userId: string): Promise<TableAppSummaryRow[]> {
      return summaries()
        .where(and(live(), eq(tableApps.featured, true), or(audienceReaches(userId), managesBase(userId))))
        .orderBy(asc(tableApps.name), asc(tableApps.id));
    },

    // ─── Pins ─────────────────────────────────────────────

    async listAppPins(userId: string): Promise<TableAppPinRow[]> {
      return db
        .select()
        .from(tableAppPins)
        .where(eq(tableAppPins.user_id, userId))
        .orderBy(asc(tableAppPins.position), asc(tableAppPins.created_at));
    },

    /** Replace a person's pins with `appIds`, in that order (duplicates dropped, at most 50). */
    async setAppPins(userId: string, appIds: readonly number[]): Promise<TableAppPinRow[]> {
      const ids = [...new Set(appIds)];
      if (ids.length > MAX_PINS) throw new TablesValidationError(`At most ${MAX_PINS} apps can be pinned`);
      return db.transaction(async (tx) => {
        await tx.delete(tableAppPins).where(eq(tableAppPins.user_id, userId));
        if (ids.length === 0) return [];
        const now = nowIso();
        const rows = await tx
          .insert(tableAppPins)
          .values(ids.map((appId, position) => ({ user_id: userId, app_id: appId, position, created_at: now })))
          .returning();
        return rows.sort((a, b) => a.position - b.position);
      });
    },
  };
  return service;
}
