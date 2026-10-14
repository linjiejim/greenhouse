import { createHash } from 'node:crypto';
import { and, asc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import {
  roleAtLeast,
  type AppAudience,
  type AppCard,
  type AppDraft,
  type AppRuntime,
  type AppSpec,
  type AppSummary,
  type AppVersion,
  type Page,
  type RecordValues,
} from '@greenhouse/contract';
import {
  apps,
  appVersions,
  baseTables,
  bases,
  getDb,
  groups,
  members,
  newId,
  pins,
  shares,
  transaction,
  type AppRow,
} from '@greenhouse/db';
import { audit } from '../../audit.js';
import { conflict, forbidden, invalidInput, notFound } from '../../http/errors.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import { principalMatch } from '../knowledge/access.js';
import { effectiveModules } from '../members/service.js';
import {
  audienceOf,
  baseAt,
  combineRoles,
  loadReader,
  readableBases,
  withBaseRestriction,
  type CustomAccess,
  type CustomTableRules,
} from '../tables/access.js';
import { scopeOf } from '../tables/scope.js';
import { fieldsOf, tableAt } from '../tables/load.js';
import type { TablesService } from '../tables/service.js';
import type { NotificationsService } from '../notifications/service.js';
import { actionsIn, checkSpec, fieldsIn, readSpec, trimCard } from './spec.js';
import { createTemplates } from './templates.js';

export const hashContent = (text: string) => createHash('sha256').update(text).digest('hex');
const stale = () => conflict('stale_revision', 'Someone changed this draft. Reload it before saving.');

export function createAppsService(deps: { tables: TablesService; notifications: NotificationsService }) {
  async function readerOf(memberId: string) {
    const [member] = await getDb()
      .select({ modules: members.modules, role: members.role, status: members.status })
      .from(members)
      .where(eq(members.id, memberId));
    if (!member || member.status !== 'active' || !effectiveModules(member.modules).apps)
      throw forbidden('Apps are turned off for you.');
    return { ...(await loadReader(memberId)), admin: member.role === 'admin' };
  }
  async function rowAt(memberId: string, appId: string, edit = false) {
    const reader = await readerOf(memberId);
    const [app] = await getDb()
      .select()
      .from(apps)
      .where(and(eq(apps.id, appId), isNull(apps.archivedAt)));
    if (!app) throw notFound('App');
    const { role } = await baseAt(reader, app.baseId, 'viewer');
    const editable = app.ownerId === memberId && roleAtLeast(role, 'builder');
    const grants = await getDb()
      .select()
      .from(shares)
      .where(and(eq(shares.resourceType, 'app'), eq(shares.resourceId, app.id), principalMatch(reader)));
    if (!editable && app.status !== 'published') throw notFound('App');
    if (app.ownerId !== memberId && !grants.length) throw notFound('App');
    if (edit && !editable) throw forbidden('Only its owner with builder access edits this app.');
    return { app, reader, editable, grants };
  }
  async function summary(app: AppRow, editable: boolean, memberId: string): Promise<AppSummary> {
    const [pin] = await getDb()
      .select({ id: pins.targetId })
      .from(pins)
      .where(and(eq(pins.memberId, memberId), eq(pins.targetType, 'app'), eq(pins.targetId, app.id)));
    return {
      id: app.id,
      base_id: app.baseId,
      name: app.name,
      description: app.description,
      owner_id: app.ownerId,
      status: app.status,
      published_version: app.publishedVersion,
      editable,
      featured: app.featured,
      pinned: !!pin,
    };
  }
  async function draft(memberId: string, appId: string): Promise<AppDraft> {
    const { app, editable } = await rowAt(memberId, appId, true);
    const audience = await getDb()
      .select()
      .from(shares)
      .where(and(eq(shares.resourceType, 'app'), eq(shares.resourceId, appId)));
    return {
      app: await summary(app, editable, memberId),
      revision: app.draftRevision,
      spec: readSpec(app.draftSpec),
      audience: audience.map((s) => ({ principal_type: s.principalType, principal_id: s.principalId, role: s.role })),
    };
  }
  async function published(app: AppRow) {
    const [version] = await getDb()
      .select()
      .from(appVersions)
      .where(and(eq(appVersions.appId, app.id), eq(appVersions.version, app.publishedVersion ?? 0)));
    if (!version) throw notFound('Published app');
    return version;
  }
  async function session(memberId: string, appId: string, version?: number, previewRole?: string) {
    const at = await rowAt(memberId, appId, !!previewRole);
    const saved = previewRole ? null : await published(at.app);
    if (version !== undefined && (saved?.version ?? 0) !== version)
      throw conflict('stale_version', 'This app has changed. Reload it.');
    const spec = readSpec(saved?.spec ?? at.app.draftSpec);
    const roleIds = previewRole ? [previewRole] : at.grants.map((g) => g.role);
    // An unknown or removed role grants nothing; a plain audience grant uses only base access.
    const rules =
      (at.app.ownerId === memberId && !previewRole) || roleIds.includes('use')
        ? null
        : combineRoles(spec.roles.filter((r) => roleIds.includes(r.id)));
    return { ...at, spec, rules, version: saved?.version ?? 0 };
  }
  async function inSession<T>(
    memberId: string,
    appId: string,
    version: number,
    work: (ctx: Awaited<ReturnType<typeof session>>) => Promise<T>,
    previewRole?: string,
  ) {
    const ctx = await session(memberId, appId, version, previewRole);
    return withBaseRestriction(ctx.app.baseId, ctx.rules, () => work(ctx));
  }
  function findCard(spec: AppSpec, id: string) {
    const card = spec.pages.flatMap((p) => p.cards).find((c) => c.id === id);
    if (!card) throw notFound('Card');
    return card;
  }
  async function visibleCard(ctx: Awaited<ReturnType<typeof session>>, cardId: string) {
    const card = findCard(ctx.spec, cardId);
    if (card.kind === 'custom') throw forbidden('Custom HTML cards do not run.');
    const at = await tableAt(ctx.reader, card.table_id, 'viewer');
    const scope = await scopeOf(ctx.reader, at);
    const trimmed = trimCard(card, new Map(scope.fields.map((f) => [f.id, f])));
    if (!trimmed) throw notFound('Card');
    return { card: trimmed, scope };
  }
  /** Card fields and query narrow record detail and writes as well as the list. */
  async function inCard<T>(
    ctx: Awaited<ReturnType<typeof session>>,
    card: Exclude<AppCard, { kind: 'custom' }>,
    work: () => Promise<T>,
    constrainQuery = true,
  ) {
    const fields = await fieldsOf(card.table_id);
    const shown = new Set([
      ...fieldsIn(card),
      ...actionsIn(card).flatMap((a) => Object.keys(a.values)),
      ...fields.filter((f) => f.isPrimary).map((f) => f.id),
    ]);
    const existing = ctx.rules?.tables.get(card.table_id);
    const tables: Map<string, CustomTableRules> = ctx.rules
      ? new Map(ctx.rules.tables)
      : new Map(
          (
            await getDb()
              .select({ id: baseTables.id })
              .from(baseTables)
              .where(and(eq(baseTables.baseId, ctx.app.baseId), isNull(baseTables.archivedAt)))
          ).map((table) => [table.id, { access: 'edit' as const, rows: [], hidden: new Set<string>() }]),
        );
    // Keep access to permitted linked tables and computed inputs; project only this card's columns.
    tables.set(card.table_id, {
      access: existing?.access ?? 'edit',
      rows: existing?.rows ?? [],
      hidden: existing?.hidden ?? new Set(),
      presentation: shown,
      rowGroups: existing?.rowGroups,
      constraints: [
        ...(existing?.constraints ?? []),
        ...(constrainQuery && 'filter' in card && card.filter ? [card.filter] : []),
      ],
    });
    const rules: CustomAccess = { roles: ctx.rules?.roles ?? [], tables };
    return withBaseRestriction(ctx.app.baseId, rules, work);
  }
  type ActionInput = {
    version: number;
    card: string;
    action: string;
    record_id?: string;
    revision?: number;
    values: RecordValues;
  };
  async function resolveAction(ctx: Awaited<ReturnType<typeof session>>, input: ActionInput) {
    const memberId = ctx.reader.memberId;
    const { card, scope } = await visibleCard(ctx, input.card);
    if (card.kind === 'custom') throw forbidden('Custom HTML cards do not run.');
    const form = card.kind === 'form' && input.action === 'submit';
    const action = actionsIn(card).find((a) => a.id === input.action);
    if (!form && !action) throw notFound('Action');
    if (!form && Object.keys(input.values).length) throw invalidInput('A button uses only its saved action values.');
    if (form && Object.keys(input.values).some((id) => !card.fields.includes(id)))
      throw forbidden('This field is not in the form.');
    const values = form
      ? input.values
      : Object.fromEntries(
          Object.entries(action!.values).map(([id, v]) => [
            id,
            v === '$me' && scope.fields.find((f) => f.id === id)?.type === 'member' ? [memberId] : v,
          ]),
        );
    const updating = !form && action!.type === 'update';
    if (updating && (!input.record_id || !input.revision))
      throw invalidInput('An update needs a record and its revision.');
    if (updating)
      await inCard(ctx, card, async () => {
        const detail = await deps.tables.records.get(memberId, input.record_id!);
        if (detail.table_id !== card.table_id) throw notFound('Record');
      });
    return { card, values, updating, label: form ? card.title : action!.name };
  }
  async function validateAudience(spec: AppSpec, audience: AppAudience[]) {
    const keys = new Set<string>();
    for (const grant of audience) {
      const key = `${grant.principal_type}:${grant.principal_id}`;
      if (keys.has(key)) throw invalidInput('Each audience principal is listed once.');
      keys.add(key);
      if (grant.role !== 'use' && !spec.roles.some((r) => r.id === grant.role))
        throw invalidInput('The audience names a role of this app.');
      if (grant.principal_type === 'member') {
        const [member] = await getDb()
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.id, grant.principal_id!), eq(members.status, 'active')));
        if (!member) throw invalidInput('The audience member is not active.');
      }
      if (grant.principal_type === 'group') {
        const [group] = await getDb().select({ id: groups.id }).from(groups).where(eq(groups.id, grant.principal_id!));
        if (!group) throw invalidInput('The audience group is not there.');
      }
    }
  }

  const service = {
    draft,
    async list(memberId: string, query: { cursor?: string; limit: number; q?: string }): Promise<Page<AppSummary>> {
      const reader = await readerOf(memberId);
      const after = decodeCursor(query.cursor);
      const rows = await getDb()
        .select({ app: apps })
        .from(apps)
        .innerJoin(bases, eq(bases.id, apps.baseId))
        .where(
          and(
            isNull(apps.archivedAt),
            isNull(bases.archivedAt),
            readableBases(reader),
            or(
              eq(apps.ownerId, memberId),
              and(
                eq(apps.status, 'published'),
                sql`EXISTS (SELECT 1 FROM ${shares} WHERE ${shares.resourceType} = 'app' AND ${shares.resourceId} = ${apps.id} AND ${principalMatch(reader)})`,
              ),
            ),
            after ? gt(apps.id, after) : undefined,
            query.q ? ilike(apps.name, `%${query.q.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
          ),
        )
        .orderBy(asc(apps.id))
        .limit(query.limit + 1);
      const page = toPage(
        rows.map((r) => r.app),
        query.limit,
        (a) => a,
      );
      const items = [];
      for (const app of page.items) {
        const { role } = await baseAt(reader, app.baseId, 'viewer');
        const editable = app.ownerId === memberId && roleAtLeast(role, 'builder');
        if (app.status === 'draft' && !editable) continue;
        items.push(await summary(app, editable, memberId));
      }
      return { ...page, items };
    },
    async create(memberId: string, input: { base_id: string; name: string; description: string }) {
      const reader = await readerOf(memberId);
      await baseAt(reader, input.base_id, 'builder');
      const spec: AppSpec = { pages: [{ id: 'home', name: input.name, cards: [] }], roles: [] };
      const [app] = await getDb()
        .insert(apps)
        .values({
          id: newId('app'),
          baseId: input.base_id,
          ownerId: memberId,
          name: input.name,
          description: input.description,
          draftSpec: JSON.stringify(spec),
        })
        .returning();
      return draft(memberId, app!.id);
    },
    async save(
      memberId: string,
      appId: string,
      input: { revision: number; name: string; description: string; spec: AppSpec },
    ) {
      const { app } = await rowAt(memberId, appId, true);
      const spec = await checkSpec(app.baseId, input.spec);
      const [saved] = await getDb()
        .update(apps)
        .set({
          name: input.name,
          description: input.description,
          draftSpec: JSON.stringify(spec),
          draftRevision: sql`${apps.draftRevision} + 1`,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(apps.id, appId), eq(apps.draftRevision, input.revision)))
        .returning();
      if (!saved) throw stale();
      return draft(memberId, appId);
    },
    async publish(
      memberId: string,
      appId: string,
      input: { revision: number; notes: string; audience: AppAudience[] },
    ) {
      await rowAt(memberId, appId, true);
      await transaction(async () => {
        const [app] = await getDb().select().from(apps).where(eq(apps.id, appId)).for('update');
        if (!app || app.draftRevision !== input.revision) throw stale();
        await rowAt(memberId, appId, true);
        const spec = await checkSpec(app.baseId, readSpec(app.draftSpec));
        await validateAudience(spec, input.audience);
        const version = (app.publishedVersion ?? 0) + 1;
        const text = JSON.stringify(spec);
        await getDb()
          .insert(appVersions)
          .values({
            id: newId('appVersion'),
            appId,
            version,
            spec: text,
            specHash: hashContent(text),
            draftRevision: app.draftRevision,
            notes: input.notes,
            publishedBy: memberId,
          });
        await getDb()
          .update(apps)
          .set({
            publishedVersion: version,
            draftRevision: sql`${apps.draftRevision} + 1`,
            status: 'published',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(apps.id, appId));
        await getDb()
          .delete(shares)
          .where(and(eq(shares.resourceType, 'app'), eq(shares.resourceId, appId)));
        if (input.audience.length)
          await getDb()
            .insert(shares)
            .values(
              input.audience.map((g) => ({
                id: newId('share'),
                resourceType: 'app' as const,
                resourceId: appId,
                principalType: g.principal_type,
                principalId: g.principal_id,
                role: g.role,
                createdBy: memberId,
              })),
            );
        await audit({
          actorId: memberId,
          action: 'app.publish',
          resourceType: 'app',
          resourceId: appId,
          scopeType: 'base',
          scopeId: app.baseId,
          summary: 'spec, audience',
        });
        // Notify only members who actually reach both the app and its base.
        const [base] = await getDb().select().from(bases).where(eq(bases.id, app.baseId));
        const candidates = (await audienceOf(base!)).ids.map((id) => ({ id }));
        for (const member of candidates) {
          if (member.id === memberId) continue;
          if (!(await service.canRead(member.id, appId))) continue;
          await deps.notifications.publish({
            memberId: member.id,
            kind: 'share',
            title: app.name,
            targetType: 'app',
            targetId: appId,
            dedupeKey: `app:${appId}:${version}:${member.id}`,
          });
        }
      });
      return draft(memberId, appId);
    },
    async versions(
      memberId: string,
      appId: string,
      query: { cursor?: string; limit: number },
    ): Promise<Page<AppVersion>> {
      await rowAt(memberId, appId, true);
      const after = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(appVersions)
        .where(and(eq(appVersions.appId, appId), after ? gt(appVersions.id, after) : undefined))
        .orderBy(asc(appVersions.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, (r) => ({
        id: r.id,
        version: r.version,
        spec: readSpec(r.spec),
        spec_hash: r.specHash,
        notes: r.notes,
        published_by: r.publishedBy,
        published_at: r.publishedAt,
      }));
    },
    async restore(memberId: string, appId: string, input: { revision: number; version: number }) {
      await rowAt(memberId, appId, true);
      const [version] = await getDb()
        .select()
        .from(appVersions)
        .where(and(eq(appVersions.appId, appId), eq(appVersions.version, input.version)));
      if (!version) throw notFound('Version');
      const [saved] = await getDb()
        .update(apps)
        .set({
          draftSpec: version.spec,
          draftRevision: sql`${apps.draftRevision} + 1`,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(apps.id, appId), eq(apps.draftRevision, input.revision)))
        .returning();
      if (!saved) throw stale();
      return draft(memberId, appId);
    },
    async runtime(memberId: string, appId: string, previewRole?: string): Promise<AppRuntime> {
      const ctx = await session(memberId, appId, undefined, previewRole);
      return withBaseRestriction(ctx.app.baseId, ctx.rules, async () => {
        const base = { ...(await deps.tables.get(memberId, ctx.app.baseId)), views: [] };
        const pages = ctx.spec.pages.map((page) => ({
          ...page,
          cards: page.cards.flatMap((card) => {
            if (card.kind === 'custom') return [{ ...card, html: '' }];
            const table = base.tables.find((t) => t.id === card.table_id);
            if (!table) return [];
            const visible = new Map(table.fields.map((f) => [f.id, f]));
            const trimmed = trimCard(card, visible);
            return trimmed ? [trimmed] : [];
          }),
        }));
        return {
          app: await summary(ctx.app, ctx.editable, memberId),
          version: ctx.version,
          pages,
          base,
          preview: !!previewRole,
          preview_role: previewRole ?? null,
        };
      });
    },
    async card(
      memberId: string,
      appId: string,
      input: { version: number; card: string; cursor?: string; preview_role?: string },
    ) {
      return inSession(
        memberId,
        appId,
        input.version,
        async (ctx) => {
          const { card } = await visibleCard(ctx, input.card);
          if (card.kind === 'custom') throw forbidden('Custom HTML cards do not run.');
          if (['number', 'bar', 'line', 'pie', 'list'].includes(card.kind))
            return {
              kind: 'chart' as const,
              data: await deps.tables.cards.query(memberId, card as import('@greenhouse/contract').Card),
            };
          if ('fields' in card && card.kind !== 'form')
            return inCard(ctx, card, async () => ({
              kind: 'records' as const,
              data: await deps.tables.records.query(memberId, card.table_id, {
                limit: 200,
                count: true,
                cursor: input.cursor,
              }),
            }));
          return { kind: 'empty' as const };
        },
        input.preview_role,
      );
    },
    async record(
      memberId: string,
      appId: string,
      input: { version: number; card: string; preview_role?: string },
      recordId: string,
    ) {
      return inSession(
        memberId,
        appId,
        input.version,
        async (ctx) => {
          const { card } = await visibleCard(ctx, input.card);
          if (!('fields' in card) || card.kind === 'form') throw notFound('Record card');
          return inCard(ctx, card, async () => {
            const detail = await deps.tables.records.get(memberId, recordId);
            if (detail.record.table_id !== card.table_id) throw notFound('Record');
            return detail;
          });
        },
        input.preview_role,
      );
    },
    async inActionScope<T>(
      memberId: string,
      appId: string,
      version: number,
      cardId: string,
      work: (tableId: string) => Promise<T>,
    ) {
      await getDb().select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).for('update');
      return inSession(memberId, appId, version, async (ctx) => {
        const { card } = await visibleCard(ctx, cardId);
        if (card.kind === 'custom') throw forbidden('Custom HTML cards do not run.');
        return inCard(ctx, card, () => work(card.table_id), false);
      });
    },
    async actionPlan(
      memberId: string,
      appId: string,
      input: {
        version: number;
        card: string;
        action: string;
        record_id?: string;
        revision?: number;
        values: RecordValues;
      },
    ) {
      return inSession(memberId, appId, input.version, async (ctx) => {
        const { card, values, updating, label } = await resolveAction(ctx, input);
        return {
          action: updating ? ('update' as const) : ('create' as const),
          table_id: card.table_id,
          values,
          ...(updating ? { record_id: input.record_id!, revision: input.revision! } : {}),
          label,
        };
      });
    },
    async execute(
      memberId: string,
      appId: string,
      input: {
        version: number;
        card: string;
        action: string;
        record_id?: string;
        revision?: number;
        values: RecordValues;
      },
    ) {
      const result = await transaction(async () => {
        await getDb().select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).for('update');
        return inSession(memberId, appId, input.version, async (ctx) => {
          const { card, values, updating } = await resolveAction(ctx, input);
          // An action can move a record out of this card's query, but never out of the member's role.
          return inCard(
            ctx,
            card,
            () =>
              deps.tables.records.changeFrom(
                memberId,
                card.table_id,
                values,
                { type: 'app', id: appId },
                updating ? { id: input.record_id!, revision: input.revision! } : undefined,
              ),
            false,
          );
        });
      });
      await deps.tables.records.announce(result.at, [result.row]);
      return result.detail;
    },
    async pin(memberId: string, appId: string, value: boolean) {
      await rowAt(memberId, appId);
      if (value)
        await getDb().insert(pins).values({ memberId, targetType: 'app', targetId: appId }).onConflictDoNothing();
      else
        await getDb()
          .delete(pins)
          .where(and(eq(pins.memberId, memberId), eq(pins.targetType, 'app'), eq(pins.targetId, appId)));
    },
    async feature(memberId: string, appId: string, value: boolean) {
      const reader = await readerOf(memberId);
      if (!reader.admin) throw forbidden('Only admins feature apps.');
      const { app } = await rowAt(memberId, appId);
      await transaction(async () => {
        await getDb().update(apps).set({ featured: value }).where(eq(apps.id, appId));
        await audit({
          actorId: memberId,
          action: 'app.feature',
          resourceType: 'app',
          resourceId: appId,
          scopeType: 'base',
          scopeId: app.baseId,
          summary: 'featured',
        });
      });
    },
    async canRead(memberId: string, appId: string): Promise<boolean> {
      return rowAt(memberId, appId)
        .then(() => true)
        .catch(() => false);
    },
  };
  return { ...service, templates: createTemplates({ ...deps, readerOf, draft, published, rowAt }) };
}
export type AppsService = ReturnType<typeof createAppsService>;
