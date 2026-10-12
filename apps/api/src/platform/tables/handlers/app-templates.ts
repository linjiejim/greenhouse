/** Template lifecycle: immutable plans, review gates and guarded installation as the current member. */
import { effectiveUserId } from '@greenhouse/platform-kernel';
import {
  APP_ID_PATTERN,
  APP_TEMPLATE_LIMITS,
  APP_ICONS,
  APP_ACCENTS,
  type AppDraftView,
  type AppTemplateDetailView,
  type AppTemplatePublishInput,
} from '@greenhouse/types/apps';
import { nowIso } from '@greenhouse/utils/date';
import { isValidSemver } from '@greenhouse/utils/semver';
import { activeUserHasFeature } from '../../../auth/features.js';
import { requireAppManager } from '../access.js';
import { getPlatformRuntime } from '../../runtime.js';
import { tablesResource } from '../audit.js';
import { draftSchemaPlan } from '../schema-plan-draft.js';
import { applySchemaPlan } from '../schema-plan.js';
import { APP_TEMPLATE_KEYS, templateLocale } from '../app-templates/index.js';
import { checkTemplateContent, exportTemplateContent, sanitizeTemplateOperations } from '../app-templates/content.js';
import {
  readTemplateContent,
  syncBuiltinAppTemplates,
  templateInstallable,
  templateSummary,
  templateVersionView,
} from '../app-templates/lifecycle.js';
import {
  fail,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type HandlerRequest,
  type TablesHandlers,
} from './shared.js';

type Context = Parameters<Handler>[1];
async function identity(request: HandlerRequest, context: Context) {
  return context.db.users.getById(effectiveUserId(request.actor));
}
async function detail(
  request: HandlerRequest,
  context: Context,
  key: string,
): Promise<AppTemplateDetailView | undefined> {
  const user = await identity(request, context);
  const row = await context.db.tables.getAppTemplate(key);
  if (!user || !row || !row.latest_version) return;
  const canReview = user.role === 'super';
  const canManage = row.source === 'published' && (row.owner_id === user.id || canReview);
  const latest = await context.db.tables.getAppTemplateVersion(row.id, row.latest_version);
  if (!latest || (!canManage && !canReview && (row.status !== 'active' || !templateInstallable(latest)))) return;
  const owner = row.owner_id ? await context.db.users.getById(row.owner_id) : undefined;
  const versions = (await context.db.tables.listAppTemplateVersions(row.id)).filter(
    (version) => canManage || canReview || templateInstallable(version),
  );
  const requestedVersion = stringValue(payloadOf(request), 'version');
  const selected = requestedVersion ? await context.db.tables.getAppTemplateVersion(row.id, requestedVersion) : latest;
  const content = readTemplateContent(latest);
  const plan = content.plans[templateLocale(user.locale)];
  const tables = plan.operations.flatMap((op) =>
    op.op === 'base.create'
      ? [{ name: op.defaultTableName ?? 'Table', ref: op.defaultTableRef }]
      : op.op === 'table.create'
        ? [{ name: op.name, ref: op.ref }]
        : [],
  );
  return {
    template: {
      ...templateSummary(row, latest, user.locale),
      source: row.source,
      status: row.status,
      owner: owner ? { id: owner.id, name: owner.nickname } : null,
      canManage,
      canReview,
    },
    versions: await Promise.all(versions.map((version) => templateVersionView(context.db, version))),
    creates: {
      tables: tables.map((table) => ({
        name: table.name,
        fields: 1 + plan.operations.filter((op) => op.op === 'field.create' && op.tableRef === table.ref).length,
      })),
      automations: latest.automations,
      dashboards: plan.operations.filter((op) => op.op === 'dashboard.create').length,
      pages: (plan.operations.find((op) => op.op === 'app.create')?.spec.pages as unknown[] | undefined)?.length ?? 0,
    },
    ...((canManage || canReview) && selected
      ? { review: { version: selected.version, content: selected.content, scanFindings: selected.scan_findings ?? [] } }
      : {}),
  };
}
const safe =
  (handler: Handler): Handler =>
  async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return fail('INVALID_INPUT', error instanceof Error ? error.message : 'Invalid template');
    }
  };
const listAppTemplates: Handler = safe(async (request, context) => {
  await syncBuiltinAppTemplates(context.db);
  const user = await identity(request, context);
  if (!user) return fail('FORBIDDEN', 'Account unavailable');
  const templates = [];
  for (const row of await context.db.tables.listAppTemplates()) {
    if (row.status !== 'active' || !row.latest_version) continue;
    const version = await context.db.tables.getAppTemplateVersion(row.id, row.latest_version);
    if (!version || (!templateInstallable(version) && row.owner_id !== user.id && user.role !== 'super')) continue;
    templates.push(templateSummary(row, version, user.locale));
  }
  templates.sort((a, b) => {
    const ai = (APP_TEMPLATE_KEYS as readonly string[]).indexOf(a.key);
    const bi = (APP_TEMPLATE_KEYS as readonly string[]).indexOf(b.key);
    return (ai < 0 ? 1000 : ai) - (bi < 0 ? 1000 : bi) || a.name.localeCompare(b.name);
  });
  return ok({ templates });
});
const getAppTemplate: Handler = safe(async (request, context) => {
  await syncBuiltinAppTemplates(context.db);
  const view = await detail(request, context, stringValue(payloadOf(request), 'key') ?? '');
  return view ? ok(view) : fail('NOT_FOUND', 'Template not found');
});
const publishAppTemplate: Handler = safe(async (request, context) => {
  const user = await identity(request, context);
  if (!user) return fail('FORBIDDEN', 'Account unavailable');
  const payload = payloadOf(request);
  const appId = positiveInt(payload, 'appId');
  const app = appId ? await context.db.tables.getApp(appId) : undefined;
  const base = app && (await context.db.tables.getBase(app.base_id));
  if (!app || app.archived_at || !base || !(await requireAppManager(context, request.actor, base)))
    return fail('NOT_FOUND', 'App not found');
  const key = stringValue(payload, 'key') ?? '';
  const version = stringValue(payload, 'version') ?? '';
  if (!APP_ID_PATTERN.test(key) || key.length > APP_TEMPLATE_LIMITS.keyLength || !isValidSemver(version))
    return fail('INVALID_INPUT', 'A valid key and strict semver version are required');
  if ((APP_TEMPLATE_KEYS as readonly string[]).includes(key))
    return fail('FORBIDDEN', 'Builtin template keys are reserved');
  const existing = await context.db.tables.getAppTemplate(key);
  if (
    existing &&
    (existing.source !== 'published' ||
      existing.status !== 'active' ||
      (existing.owner_id !== user.id && user.role !== 'super'))
  )
    return fail('FORBIDDEN', 'You cannot publish this template');
  const changelog = stringValue(payload, 'changelog') ?? '';
  if ((existing && !changelog.trim()) || changelog.length > APP_TEMPLATE_LIMITS.changelogLength)
    return fail('INVALID_INPUT', 'A changelog is required for new versions (at most 2000 characters)');
  if (
    payload.sampleRecords !== undefined &&
    (!Array.isArray(payload.sampleRecords) || payload.sampleRecords.length > APP_TEMPLATE_LIMITS.sampleRecords)
  )
    return fail('INVALID_INPUT', 'At most 50 handwritten sample records are allowed');
  const name = stringValue(payload, 'name')?.trim() || app.name;
  const description = stringValue(payload, 'description') ?? app.description ?? '';
  if (name.length > 60 || description.length > 500) return fail('INVALID_INPUT', 'Name or description is too long');
  if (payload.icon !== undefined && !(APP_ICONS as readonly unknown[]).includes(payload.icon))
    return fail('INVALID_INPUT', 'Invalid icon');
  if (payload.accent !== undefined && !(APP_ACCENTS as readonly unknown[]).includes(payload.accent))
    return fail('INVALID_INPUT', 'Invalid accent');
  const input = { ...payload, appId: app.id, name, description, version } as unknown as AppTemplatePublishInput;
  const content = await exportTemplateContent(context.db, app, input);
  const checked = checkTemplateContent(content);
  const preview = await draftSchemaPlan(content.plans.en.operations, {
    userId: user.id,
    grantableGroups: async () => [],
    appsEnabled: () => activeUserHasFeature(user.id, 'apps', context.db),
    dispatch: (actionId, body, ids) =>
      getPlatformRuntime().dispatch({
        actor: request.actor,
        appId: 'tables',
        actionId,
        payload: body,
        resource: tablesResource(actionId, ids),
      }),
  });
  if (!preview.ok) return fail('INVALID_INPUT', 'Template plan is invalid', { problems: preview.problems });
  await context.db.tables.publishAppTemplateVersion(
    {
      key,
      source: 'published',
      name,
      description,
      icon: input.icon ?? app.icon,
      accent: input.accent ?? app.accent,
      owner_id: user.id,
      source_app_id: app.id,
      source_base_id: base.id,
    },
    {
      version,
      changelog,
      content: checked.content,
      custom_cards: checked.customCards,
      automations: checked.automations,
      scan_status: checked.scan.status,
      scan_findings: checked.scan.findings,
      scanned_at: nowIso(),
      review_status:
        checked.customCards || checked.automations || checked.scan.status !== 'clean' ? 'pending' : 'not_required',
      source_app_version: app.published_version,
      published_by: user.id,
    },
    existing?.latest_version ?? null,
  );
  return ok(await detail(request, context, key));
});
const reviewAppTemplate: Handler = safe(async (request, context) => {
  const user = await identity(request, context);
  if (user?.role !== 'super') return fail('FORBIDDEN', 'Only administrators may review templates');
  const payload = payloadOf(request);
  const row = await context.db.tables.getAppTemplate(stringValue(payload, 'key') ?? '');
  const version = row && (await context.db.tables.getAppTemplateVersion(row.id, stringValue(payload, 'version') ?? ''));
  if (!row || !version) return fail('NOT_FOUND', 'Template version not found');
  if (payload.decision !== 'approve' && payload.decision !== 'reject')
    return fail('INVALID_INPUT', 'Review decision is required');
  const note = stringValue(payload, 'note');
  if ((note?.length ?? 0) > 2000) return fail('INVALID_INPUT', 'Review note is too long');
  const reviewed = await context.db.tables.reviewAppTemplateVersion(row.id, version.version, {
    decision: payload.decision,
    userId: user.id,
    note,
  });
  return ok(await templateVersionView(context.db, reviewed!));
});
const archiveAppTemplate: Handler = safe(async (request, context) => {
  const key = stringValue(payloadOf(request), 'key') ?? '';
  const view = await detail(request, context, key);
  if (!view) return fail('NOT_FOUND', 'Template not found');
  if (!view.template.canManage) return fail('FORBIDDEN', 'You cannot archive this template');
  const row = await context.db.tables.getAppTemplate(key);
  await context.db.tables.archiveAppTemplate(row!.id);
  return ok(await detail(request, context, key));
});
const installAppTemplate: Handler = safe(async (request, context) => {
  await syncBuiltinAppTemplates(context.db);
  const user = await identity(request, context);
  if (!user || !(await activeUserHasFeature(user.id, 'tables', context.db)))
    return fail('FORBIDDEN', 'Tables is unavailable to your account');
  const row = await context.db.tables.getAppTemplate(stringValue(payloadOf(request), 'key') ?? '');
  if (!row || row.status !== 'active' || !row.latest_version) return fail('NOT_FOUND', 'Template not found');
  const version = await context.db.tables.getAppTemplateVersion(row.id, row.latest_version);
  if (!version || !templateInstallable(version))
    return fail('FORBIDDEN', 'This template version requires administrator approval');
  if (version.custom_cards > 0 && !(await activeUserHasFeature(user.id, 'apps_custom_code', context.db)))
    return fail('FORBIDDEN', 'Enable custom code before installing this template');
  const content = readTemplateContent(version);
  checkTemplateContent(content);
  const operations = sanitizeTemplateOperations(content.plans[templateLocale(user.locale)].operations);
  const requestedName = payloadOf(request).name;
  if (requestedName !== undefined) {
    if (typeof requestedName !== 'string' || !requestedName.trim() || requestedName.trim().length > 60)
      return fail('INVALID_INPUT', 'Application name must contain 1 to 60 characters');
    for (const operation of operations)
      if (operation.op === 'base.create' || operation.op === 'app.create') operation.name = requestedName.trim();
  }
  const dispatch: Parameters<typeof applySchemaPlan>[1] = (actionId, payload, ids) =>
    getPlatformRuntime().dispatch({
      actor: request.actor,
      appId: 'tables',
      actionId,
      payload,
      resource: tablesResource(actionId, ids),
    });
  const preview = await draftSchemaPlan(operations, {
    userId: user.id,
    dispatch,
    grantableGroups: async () => [],
    appsEnabled: () => activeUserHasFeature(user.id, 'apps', context.db),
  });
  if (!preview.ok) return fail('INVALID_INPUT', 'Template cannot be installed', { problems: preview.problems });
  const applied = await applySchemaPlan(operations, dispatch);
  const appId = applied.refs?.[content.appRef]?.id;
  if (!appId || !applied.baseId || applied.results.some((result) => result.status !== 'applied'))
    return fail('INTERNAL_ERROR', 'Template installation did not finish', { results: applied.results });
  for (const sample of content.samples ?? []) {
    const tableId = applied.refs?.[sample.tableRef]?.id;
    const values = sample.values.map((value) => ({ fieldId: applied.refs?.[value.fieldRef]?.id, value: value.value }));
    if (!tableId || values.some((value) => !value.fieldId))
      return fail('INTERNAL_ERROR', 'Invalid template sample reference');
    const result = await dispatch(
      'createRecord',
      { tableId, values: Object.fromEntries(values.map((value) => [String(value.fieldId), value.value])) },
      { tableId },
    );
    if (!result.ok) return result;
  }
  const draft = await dispatch('getAppDraft', { appId }, { appId });
  return draft.ok ? ok({ app: (draft.data as AppDraftView).app, baseId: applied.baseId }) : draft;
});
export const appTemplateHandlers = {
  listAppTemplates,
  getAppTemplate,
  publishAppTemplate,
  reviewAppTemplate,
  installAppTemplate,
  archiveAppTemplate,
} satisfies TablesHandlers;
