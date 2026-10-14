import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import {
  isComputedType,
  type AppDraft,
  type AppSpec,
  type Base,
  type AppTemplate,
  type Page,
} from '@greenhouse/contract';
import {
  apps,
  appVersions,
  baseFieldDeps,
  bases,
  baseTemplates,
  baseTemplateVersions,
  baseTables,
  getDb,
  newId,
  transaction,
  type AppRow,
} from '@greenhouse/db';
import { audit } from '../../audit.js';
import { conflict, forbidden, notFound } from '../../http/errors.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { TablesService } from '../tables/service.js';
import { TEMPLATE_VERSIONS } from '../tables/templates.js';
import { checkSpec, readSpec } from './spec.js';
import { createHash } from 'node:crypto';

type Snapshot = {
  base: Pick<Base, 'id' | 'tables' | 'views'>;
  spec: AppSpec;
  deps: Array<{ field: string; on: string }>;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Rewrite references, including object keys and computed field expressions, into the new base. */
export function remap<T>(value: T, ids: Map<string, string>): T {
  if (typeof value === 'string') {
    if (ids.has(value)) return ids.get(value) as T;
    return value.replace(/\{#(col_[0-9A-Z]+)\}/g, (match, id: string) =>
      ids.has(id) ? `{#${ids.get(id)}}` : match,
    ) as T;
  }
  if (Array.isArray(value)) return value.map((v) => remap(v, ids)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [ids.get(key) ?? key, remap(v, ids)])) as T;
  return value;
}

export function createTemplates(deps: {
  tables: TablesService;
  readerOf(memberId: string): Promise<{ admin: boolean }>;
  draft(memberId: string, appId: string): Promise<AppDraft>;
  rowAt(memberId: string, appId: string, edit?: boolean): Promise<{ app: AppRow }>;
  published(app: AppRow): Promise<typeof appVersions.$inferSelect>;
}) {
  async function builtin(memberId: string) {
    await transaction(async () => {
      const [template] = await getDb()
        .insert(baseTemplates)
        .values({
          id: newId('baseTemplate'),
          key: 'project',
          source: 'builtin',
          name: '项目',
          description: '项目、任务、里程碑、负责人、日期和依赖',
          ownerId: memberId,
          latestVersion: TEMPLATE_VERSIONS.project,
        })
        .onConflictDoNothing()
        .returning();
      if (!template) return;
      const content = JSON.stringify({ builtin: 'project' });
      await getDb()
        .insert(baseTemplateVersions)
        .values({
          id: newId('baseTemplateVersion'),
          templateId: template.id,
          version: TEMPLATE_VERSIONS.project,
          content,
          contentHash: hash(content),
          reviewStatus: 'approved',
        });
    });
  }
  async function versionAt(memberId: string, templateId: string) {
    const reader = await deps.readerOf(memberId);
    const [row] = await getDb()
      .select({ template: baseTemplates, version: baseTemplateVersions })
      .from(baseTemplates)
      .innerJoin(
        baseTemplateVersions,
        and(
          eq(baseTemplateVersions.templateId, baseTemplates.id),
          eq(baseTemplateVersions.version, baseTemplates.latestVersion),
        ),
      )
      .where(and(eq(baseTemplates.id, templateId), isNull(baseTemplates.archivedAt)));
    if (!row || (row.version.reviewStatus !== 'approved' && row.template.ownerId !== memberId && !reader.admin))
      throw notFound('Template');
    return { ...row, reader };
  }
  function view(row: Awaited<ReturnType<typeof versionAt>>): AppTemplate {
    return {
      id: row.template.id,
      key: row.template.key,
      source: row.template.source,
      name: row.template.name,
      description: row.template.description,
      version: row.version.version,
      review_status: row.version.reviewStatus,
      owner_id: row.template.ownerId,
    };
  }
  return {
    async list(memberId: string, query: { cursor?: string; limit: number }): Promise<Page<AppTemplate>> {
      const reader = await deps.readerOf(memberId);
      await builtin(memberId);
      const after = decodeCursor(query.cursor);
      const rows = await getDb()
        .select({ template: baseTemplates, version: baseTemplateVersions })
        .from(baseTemplates)
        .innerJoin(
          baseTemplateVersions,
          and(
            eq(baseTemplateVersions.templateId, baseTemplates.id),
            eq(baseTemplateVersions.version, baseTemplates.latestVersion),
          ),
        )
        .where(
          and(
            isNull(baseTemplates.archivedAt),
            after ? gt(baseTemplates.id, after) : undefined,
            reader.admin
              ? undefined
              : or(eq(baseTemplateVersions.reviewStatus, 'approved'), eq(baseTemplates.ownerId, memberId)),
          ),
        )
        .orderBy(asc(baseTemplates.id))
        .limit(query.limit + 1);
      return toPage(
        rows.map((r) => ({ ...r, id: r.template.id, reader })),
        query.limit,
        view,
      );
    },
    async save(memberId: string, appId: string, input: { name: string; description: string; changelog: string }) {
      const { app } = await deps.rowAt(memberId, appId, true);
      const published = await deps.published(app);
      const base = await deps.tables.get(memberId, app.baseId);
      const fieldIds = base.tables.flatMap((t) => t.fields.map((f) => f.id));
      const edges = fieldIds.length
        ? await getDb()
            .select({ field: baseFieldDeps.fieldId, on: baseFieldDeps.dependsOnFieldId })
            .from(baseFieldDeps)
            .where(inArray(baseFieldDeps.fieldId, fieldIds))
        : [];
      // The snapshot contains schema and a published spec only: no records, shares, credentials or automation recipients.
      const spec = await checkSpec(app.baseId, readSpec(published.spec));
      const content = JSON.stringify({
        base: { id: base.id, tables: base.tables, views: base.views.filter((v) => !v.personal) },
        spec,
        deps: edges,
      } satisfies Snapshot);
      if (/"(?:mbr|rec|fil|agt)_[0-9A-Z]{26}"/.test(content))
        throw conflict(
          'template_invalid',
          'Replace fixed member, record and file references with portable values before saving a template.',
        );
      const templateId = newId('baseTemplate');
      await transaction(async () => {
        await getDb().insert(baseTemplates).values({
          id: templateId,
          key: templateId,
          source: 'published',
          name: input.name,
          description: input.description,
          ownerId: memberId,
          latestVersion: '1.0.0',
          sourceAppId: appId,
          sourceBaseId: app.baseId,
        });
        await getDb()
          .insert(baseTemplateVersions)
          .values({
            id: newId('baseTemplateVersion'),
            templateId,
            version: '1.0.0',
            changelog: input.changelog,
            content,
            contentHash: hash(content),
            reviewStatus: 'pending',
          });
        await audit({
          actorId: memberId,
          action: 'base_template.save',
          resourceType: 'base_template',
          resourceId: templateId,
          summary: 'schema, published spec',
        });
      });
      return view(await versionAt(memberId, templateId));
    },
    async review(memberId: string, templateId: string, decision: 'approved' | 'rejected') {
      const row = await versionAt(memberId, templateId);
      if (!row.reader.admin) throw forbidden('Only admins review templates.');
      if (row.template.source === 'builtin') throw forbidden('Built-in templates are reviewed in the repository.');
      await transaction(async () => {
        await getDb()
          .update(baseTemplateVersions)
          .set({ reviewStatus: decision, reviewedBy: memberId, reviewedAt: new Date().toISOString() })
          .where(eq(baseTemplateVersions.id, row.version.id));
        await audit({
          actorId: memberId,
          action: 'base_template.review',
          resourceType: 'base_template',
          resourceId: templateId,
          summary: 'review_status',
        });
      });
      return view(await versionAt(memberId, templateId));
    },
    async get(memberId: string, templateId: string) {
      const row = await versionAt(memberId, templateId);
      return {
        template: view(row),
        content: JSON.parse(row.version.content) as unknown,
        content_hash: row.version.contentHash,
        changelog: row.version.changelog,
      };
    },
    async install(memberId: string, templateId: string, name?: string): Promise<{ base: Base; app: AppDraft | null }> {
      const row = await versionAt(memberId, templateId);
      if (row.version.reviewStatus !== 'approved' || row.version.scanStatus !== 'passed')
        throw conflict('template_unavailable', 'This template needs admin approval.');
      return transaction(async () => {
        if (row.template.source === 'builtin') {
          const base = await deps.tables.create(memberId, { template: 'project', ...(name ? { name } : {}) });
          return { base, app: null };
        }
        const snapshot = JSON.parse(row.version.content) as Snapshot;
        const base = await deps.tables.create(memberId, { name: name ?? row.template.name });
        // Remove only the new empty table created by create(); the snapshot supplies every table.
        await getDb().delete(baseTables).where(eq(baseTables.id, base.tables[0]!.id));
        const ids = new Map<string, string>([[snapshot.base.id, base.id]]);
        const pending = [];
        for (const table of snapshot.base.tables) {
          const made = await deps.tables.createTable(memberId, base.id, table.name);
          ids.set(table.id, made.id);
          const primary = table.fields.find((f) => f.is_primary)!;
          const title = made.fields.find((f) => f.is_primary)!;
          ids.set(primary.id, title.id);
          await deps.tables.updateField(memberId, title.id, {
            schema_revision: made.schema_revision,
            name: primary.name,
            required: primary.required,
          });
          for (const field of table.fields.filter((f) => !f.is_primary)) pending.push(field);
        }
        while (pending.length) {
          const ready = pending.findIndex(
            (f) => !isComputedType(f.type) || snapshot.deps.filter((d) => d.field === f.id).every((d) => ids.has(d.on)),
          );
          if (ready < 0) throw conflict('template_invalid', 'The template contains a field dependency cycle.');
          const field = pending.splice(ready, 1)[0]!;
          const made = await deps.tables.createField(memberId, ids.get(field.table_id)!, {
            name: field.name,
            type: field.type,
            config: remap(field.config, ids),
            required: field.required,
          });
          ids.set(field.id, made.id);
        }
        for (const table of snapshot.base.tables) {
          const installed = (await deps.tables.get(memberId, base.id)).tables.find((t) => t.id === ids.get(table.id))!;
          for (const field of table.fields)
            await deps.tables.updateField(memberId, ids.get(field.id)!, {
              schema_revision: (await deps.tables.get(memberId, base.id)).tables.find((t) => t.id === installed.id)!
                .schema_revision,
              position: field.position,
            });
        }
        // Shared views are installed with their new references; their automatic empty grids can be reused.
        for (const source of snapshot.base.views) {
          if (!source.table_id) {
            const view = await deps.tables.cards.createDashboard(memberId, base.id, { name: source.name });
            await deps.tables.updateView(memberId, view.id, {
              revision: view.revision,
              config: remap(source.config, ids),
            });
          } else {
            const fresh = await deps.tables.get(memberId, base.id);
            const existing = fresh.views.find(
              (v) => v.table_id === ids.get(source.table_id!) && v.type === source.type && v.name === source.name,
            );
            const view =
              existing ??
              (await deps.tables.createView(memberId, ids.get(source.table_id)!, {
                name: source.name,
                type: source.type as Exclude<typeof source.type, 'dashboard'>,
                personal: false,
              }));
            await deps.tables.updateView(memberId, view.id, {
              revision: view.revision,
              config: remap(source.config, ids),
            });
          }
        }
        await getDb()
          .update(bases)
          .set({ templateKey: row.template.key, templateVersion: row.version.version })
          .where(eq(bases.id, base.id));
        const appId = newId('app');
        await getDb()
          .insert(apps)
          .values({
            id: appId,
            baseId: base.id,
            ownerId: memberId,
            name: name ?? row.template.name,
            draftSpec: JSON.stringify(remap(snapshot.spec, ids)),
          });
        await audit({
          actorId: memberId,
          action: 'base_template.install',
          resourceType: 'base_template',
          resourceId: templateId,
          summary: 'new base, app draft',
        });
        return { base: await deps.tables.get(memberId, base.id), app: await deps.draft(memberId, appId) };
      });
    },
  };
}
