/**
 * Apps (应用) — the management actions (docs/specs/20261011-tables-apps.md §4).
 *
 * Who may do what (D2): the Base's owners and builders **manage** an app —
 * create it, edit the name and the draft, read versions and audiences, restore
 * a version into the draft, preview as a role. Only the Base **owner (or a
 * super)** publishes a version and changes audiences: publishing grants access
 * to people who need not be Base members, and only the owner grants access to
 * a Base. Featuring is a super's call. Every check resolves the Base level
 * through `access.ts` (`requireBase` with entity `app`), so an archived Base,
 * a lost grant or a kernel deny answers 404 like a missing app.
 *
 * Drafts and audiences are written under CAS (`draftRevision` /
 * `audiencesRevision` → 409 with the current revision). Specs go through
 * `app-spec.ts`: a draft save needs a valid shape and reports schema problems
 * without refusing (a draft may be mid-edit); publish refuses while any remain.
 *
 * The gateway actions (card queries, records, actions, activity, comments,
 * options, files, usage) and the viewer side of `getApp` live in
 * `./app-gateway.ts`.
 */

import { effectiveUserId, type ActorContext } from '@greenhouse/platform-kernel';
import type { DatabaseProvider, TableAppAudienceInput, TableAppRow, TableAppSummaryRow } from '@greenhouse/db';
import {
  APP_ID_PATTERN,
  type AppAudienceEntry,
  type AppAudienceEntryView,
  type AppAudiencesView,
  type AppDraftView,
  type AppListView,
  type AppSpec,
  type AppSummary,
  type AppVersionSummary,
} from '@greenhouse/types/apps';
import { tableRoleAtLeast } from '@greenhouse/types/table-access';
import { requireBase, resolveBaseAccess, type BaseAccessGrant } from '../access.js';
import { viewerRolesForApps } from '../app-audience.js';
import { loadAppSpecSchema, parseStoredAppSpec, revalidateSpec, validateAppSpec } from '../app-spec.js';
import { appRuntimeView, appSummary } from '../app-view.js';
import { appGatewayHandlers, roleAppView, viewerSummary } from './app-gateway.js';
import {
  fail,
  nullableString,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type HandlerRequest,
  type TablesHandlers,
} from './shared.js';

type Context = Parameters<Handler>[1];

/** A starter spec for an app created without one: one page, one role that sees it. */
function starterSpec(): AppSpec {
  return {
    version: 1,
    pages: [
      {
        id: 'home',
        title: 'Home',
        cards: [{ id: 'intro', kind: 'text', layout: { x: 0, y: 0, w: 12, h: 3 }, markdown: '' }],
      },
    ],
    roles: [{ key: 'member', name: 'Member', pages: 'all', tables: [] }],
  };
}

// ─── Access ───────────────────────────────────────────────

interface AppGrant {
  app: TableAppRow;
  grant: BaseAccessGrant;
  /** Base owner level (owner or super): may publish, change audiences, archive. */
  canPublish: boolean;
}

/**
 * The app and the caller's standing on its Base, when it is at least
 * `required` (`builder` = manage, `owner` = publish). Undefined = 404.
 */
async function appWithAccess(
  ctx: Context,
  actor: ActorContext,
  appId: number | undefined,
  required: 'builder' | 'owner',
): Promise<AppGrant | undefined> {
  if (!appId) return undefined;
  const app = await ctx.db.tables.getApp(appId);
  if (!app) return undefined;
  const grant = await requireBase(ctx, actor, app.base_id, 'app', required);
  if (!grant) return undefined;
  return { app, grant, canPublish: grant.access.level === 'owner' };
}

/** Per-Base management standing of the caller, resolved once per Base. */
function managerLookup(ctx: Context, actor: ActorContext) {
  const cache = new Map<number, Promise<BaseAccessGrant | undefined>>();
  return (baseId: number) => {
    let found = cache.get(baseId);
    if (!found) {
      found = requireBase(ctx, actor, baseId, 'app', 'builder');
      cache.set(baseId, found);
    }
    return found;
  };
}

async function isSuper(db: DatabaseProvider, actor: ActorContext): Promise<boolean> {
  return (await db.users.getById(effectiveUserId(actor)))?.role === 'super';
}

async function pinnedIds(db: DatabaseProvider, userId: string): Promise<Set<number>> {
  return new Set((await db.tables.listAppPins(userId)).map((pin) => pin.app_id));
}

async function summaryFor(ctx: Context, actor: ActorContext, access: AppGrant): Promise<AppSummary> {
  const pins = await pinnedIds(ctx.db, effectiveUserId(actor));
  return appSummary(access.app, { canManage: true, canPublish: access.canPublish, pinned: pins.has(access.app.id) });
}

/**
 * What the caller can open: apps they manage, plus live published apps shared
 * with them — only those where a role resolves for them (D3 through
 * `viewerRolesForApps`, the gateway's own rule): an audience tier that names a
 * role the live version dropped grants nothing (D4), so the app is not on
 * their shelves either. Recommendations follow the same rule (managers always
 * see theirs).
 */
async function visibleApps(ctx: Context, actor: ActorContext) {
  const userId = effectiveUserId(actor);
  const manager = managerLookup(ctx, actor);
  const [candidates, shared, featured, pins] = await Promise.all([
    ctx.db.tables.listManagedApps(userId),
    ctx.db.tables.listAppsSharedWith(userId),
    ctx.db.tables.listFeaturedAppsFor(userId),
    pinnedIds(ctx.db, userId),
  ]);
  const flags = async (row: TableAppSummaryRow) => {
    const grant = await manager(row.base_id);
    return {
      canManage: Boolean(grant),
      canPublish: grant?.access.level === 'owner',
      pinned: pins.has(row.id),
    };
  };
  const summarize = (rows: TableAppSummaryRow[]) =>
    Promise.all(rows.map(async (row) => appSummary(row, await flags(row))));
  const managed = (await summarize(candidates)).filter((app) => app.canManage);
  const managedIds = new Set(managed.map((app) => app.id));
  const [sharedViews, featuredViews] = await Promise.all([summarize(shared), summarize(featured)]);
  const viewerApps = [...sharedViews, ...featuredViews].filter((app) => !app.canManage).map((app) => app.id);
  const roles = await viewerRolesForApps(ctx.db, [...new Set(viewerApps)], userId);
  return {
    managed,
    // A manager opens every app on their Base (a super in the audience is not a managed-list candidate).
    shared: sharedViews.filter((app) => !managedIds.has(app.id) && (app.canManage || roles.has(app.id))),
    featured: featuredViews.filter((app) => app.canManage || roles.has(app.id)),
    pins,
  };
}

// ─── Wire views ───────────────────────────────────────────

async function userNames(db: DatabaseProvider): Promise<Map<string, string>> {
  return new Map((await db.users.list()).map((user) => [user.id, user.nickname]));
}

async function draftView(ctx: Context, actor: ActorContext, access: AppGrant): Promise<AppDraftView> {
  const spec = parseStoredAppSpec(access.app.draft_spec);
  const summary = await summaryFor(ctx, actor, access);
  if (!spec) {
    return {
      app: summary,
      spec: { version: 1, pages: [], roles: [] },
      draftRevision: access.app.draft_revision,
      errors: [{ path: '', message: 'The stored draft is not a valid app spec' }],
    };
  }
  const checked = await validateAppSpec(spec, await loadAppSpecSchema(ctx.db, access.app.base_id));
  return {
    app: summary,
    spec,
    draftRevision: access.app.draft_revision,
    errors: checked.ok ? [] : checked.errors,
  };
}

/** The roles of the live version, else of the draft. */
async function liveRoles(
  db: DatabaseProvider,
  app: TableAppRow,
): Promise<{ live: AppSpec | undefined; draft: AppSpec | undefined }> {
  const version = app.published_version ? await db.tables.getAppVersion(app.id, app.published_version) : undefined;
  return {
    live: version ? parseStoredAppSpec(version.spec) : undefined,
    draft: parseStoredAppSpec(app.draft_spec),
  };
}

async function audiencesView(db: DatabaseProvider, app: TableAppRow): Promise<AppAudiencesView> {
  const [rows, names, specs] = await Promise.all([
    db.tables.listAppAudiences(app.id),
    userNames(db),
    liveRoles(db, app),
  ]);
  const liveKeys = new Set((specs.live?.roles ?? []).map((role) => role.key));
  const entries: AppAudienceEntryView[] = [];
  for (const row of rows) {
    const dangling = !liveKeys.has(row.role_key);
    if (row.principal_type === 'user' && row.user_id) {
      entries.push({
        principal: { type: 'user', userId: row.user_id },
        roleKey: row.role_key,
        name: names.get(row.user_id) ?? row.user_id,
        ...(dangling ? { dangling } : {}),
      });
    } else if (row.principal_type === 'group' && row.group_id) {
      const group = await db.groups.getById(row.group_id);
      entries.push({
        principal: { type: 'group', groupId: row.group_id },
        roleKey: row.role_key,
        name: group?.name ?? `#${row.group_id}`,
        ...(group
          ? { managedBy: { id: group.created_by, name: names.get(group.created_by) ?? group.created_by } }
          : {}),
        ...(dangling ? { dangling } : {}),
      });
    } else {
      entries.push({
        principal: { type: 'team' },
        roleKey: row.role_key,
        name: 'everyone',
        ...(dangling ? { dangling } : {}),
      });
    }
  }
  const roles = (specs.live ?? specs.draft)?.roles ?? [];
  return {
    entries,
    audiencesRevision: app.audiences_revision,
    roles: roles.map((role) => ({ key: role.key, name: role.name })),
  };
}

function versionSummary(
  row: {
    version: number;
    notes: string | null;
    published_by: string;
    published_at: string;
    draft_revision: number;
    spec_hash: string;
  },
  names: Map<string, string>,
): AppVersionSummary {
  return {
    version: row.version,
    notes: row.notes,
    publishedBy: { id: row.published_by, name: names.get(row.published_by) ?? row.published_by },
    publishedAt: row.published_at,
    draftRevision: row.draft_revision,
    specHash: row.spec_hash,
  };
}

// ─── Management handlers ──────────────────────────────────

/** `GET /api/apps`: managed, shared with me, recommended. */
const listApps: Handler = async (request, context) => {
  const { managed, shared, featured } = await visibleApps(context, request.actor);
  return ok({ managed, shared, featured } satisfies AppListView);
};

/**
 * Open an app. A manager gets the published version (or, with `draft: true`
 * or before the first publish, the draft) in full, with field metadata and
 * today's D6 issues — or, with `previewRole`, exactly what that role receives.
 * Anyone else opens the live version as their one role (D3) — the role-trimmed
 * spec without what the role cannot read (`../app-viewer.ts`); no role → 404.
 */
const getApp: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const appId = positiveInt(payload, 'appId');
  const access = await appWithAccess(context, request.actor, appId, 'builder');
  const previewRole = stringValue(payload, 'previewRole');
  if (!access || previewRole) {
    return roleAppView(request, context, payload, appId, (session) =>
      access ? summaryFor(context, request.actor, access) : viewerSummary(context, session),
    );
  }
  const { app } = access;
  const useDraft = payload.draft === true || !app.published_version;
  const text = useDraft
    ? app.draft_spec
    : (await context.db.tables.getAppVersion(app.id, app.published_version!))?.spec;
  const spec = text ? parseStoredAppSpec(text) : undefined;
  if (!spec) return fail('INVALID_INPUT', 'The stored spec is not a valid app spec');
  const schema = await loadAppSpecSchema(context.db, app.base_id);
  const view = await appRuntimeView({
    app: await summaryFor(context, request.actor, access),
    version: useDraft ? 0 : app.published_version!,
    draft: useDraft,
    spec,
    schema,
    issues: await revalidateSpec(spec, schema),
  });
  return view ? ok(view) : fail('INVALID_INPUT', 'The stored spec is not a valid app spec');
};

const createApp: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  const name = stringValue(payload, 'name');
  if (!baseId || !name) return fail('INVALID_INPUT', 'baseId and name are required');
  const grant = await requireBase(context, request.actor, baseId, 'app', 'builder');
  if (!grant) return fail('NOT_FOUND', 'Base not found');
  const checked = await validateAppSpec(payload.spec ?? starterSpec(), await loadAppSpecSchema(context.db, baseId));
  if (!checked.ok && !checked.spec)
    return fail('INVALID_INPUT', 'spec_invalid', { reason: 'spec_invalid', errors: checked.errors });
  const userId = effectiveUserId(request.actor);
  const app = await context.db.tables.createApp({
    base_id: baseId,
    name,
    description: nullableString(payload, 'description'),
    icon: stringValue(payload, 'icon') as AppSummary['icon'] | undefined,
    accent: stringValue(payload, 'accent') as AppSummary['accent'] | undefined,
    owner_id: userId,
    draft_spec: JSON.stringify(checked.spec),
    created_by: userId,
  });
  const access: AppGrant = { app, grant, canPublish: grant.access.level === 'owner' };
  return ok(await draftView(context, request.actor, access));
};

const updateApp: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const access = await appWithAccess(context, request.actor, positiveInt(payload, 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  const app = await context.db.tables.updateApp(access.app.id, {
    name: stringValue(payload, 'name'),
    description: nullableString(payload, 'description'),
    icon: stringValue(payload, 'icon') as AppSummary['icon'] | undefined,
    accent: stringValue(payload, 'accent') as AppSummary['accent'] | undefined,
  });
  if (!app) return fail('NOT_FOUND', 'App not found');
  return ok({ app: await summaryFor(context, request.actor, { ...access, app }) });
};

const getAppDraft: Handler = async (request, context) => {
  const access = await appWithAccess(context, request.actor, positiveInt(payloadOf(request), 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  return ok(await draftView(context, request.actor, access));
};

/** Replace the draft (CAS). A bad shape is refused; schema problems come back as `errors` and the draft is saved. */
const saveAppDraft: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const draftRevision = positiveInt(payload, 'draftRevision');
  if (!draftRevision) return fail('INVALID_INPUT', 'draftRevision is required');
  const access = await appWithAccess(context, request.actor, positiveInt(payload, 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  const checked = await validateAppSpec(payload.spec, await loadAppSpecSchema(context.db, access.app.base_id));
  if (!checked.spec) {
    return fail('INVALID_INPUT', 'spec_invalid', { reason: 'spec_invalid', errors: checked.ok ? [] : checked.errors });
  }
  const saved = await context.db.tables.saveAppDraft(access.app.id, {
    spec: JSON.stringify(checked.spec),
    draftRevision,
  });
  if (!saved.ok) {
    return saved.reason === 'conflict'
      ? fail('CONFLICT', 'The draft changed since you loaded it', {
          reason: 'draft_conflict',
          currentRevision: saved.current,
        })
      : fail('NOT_FOUND', 'App not found');
  }
  return ok({
    app: await summaryFor(context, request.actor, { ...access, app: saved.value }),
    spec: checked.spec,
    draftRevision: saved.value.draft_revision,
    errors: checked.ok ? [] : checked.errors,
  } satisfies AppDraftView);
};

/** Owner / super: publish the draft (still at `draftRevision`) as the next version, if it has no problems today. */
const publishApp: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const draftRevision = positiveInt(payload, 'draftRevision');
  if (!draftRevision) return fail('INVALID_INPUT', 'draftRevision is required');
  const appId = positiveInt(payload, 'appId');
  const access = await appWithAccess(context, request.actor, appId, 'owner');
  if (!access) return forbiddenIfManager(request, context, appId, 'Only the Base owner can publish an app');
  if (access.app.draft_revision !== draftRevision) {
    return fail('CONFLICT', 'The draft changed since you loaded it', {
      reason: 'draft_conflict',
      currentRevision: access.app.draft_revision,
    });
  }
  const spec = parseStoredAppSpec(access.app.draft_spec);
  const checked = spec
    ? await validateAppSpec(spec, await loadAppSpecSchema(context.db, access.app.base_id))
    : undefined;
  if (!checked?.ok) {
    return fail('INVALID_INPUT', 'spec_invalid', {
      reason: 'spec_invalid',
      errors:
        checked && !checked.ok ? checked.errors : [{ path: '', message: 'The stored draft is not a valid app spec' }],
    });
  }
  const published = await context.db.tables.publishApp(access.app.id, {
    draftRevision,
    notes: nullableString(payload, 'notes'),
    publishedBy: effectiveUserId(request.actor),
  });
  if (!published.ok) {
    return published.reason === 'conflict'
      ? fail('CONFLICT', 'The draft changed since you loaded it', {
          reason: 'draft_conflict',
          currentRevision: published.current,
        })
      : fail('NOT_FOUND', 'App not found');
  }
  const names = await userNames(context.db);
  return ok({
    app: await summaryFor(context, request.actor, { ...access, app: published.app }),
    version: versionSummary(published.version, names),
  });
};

const listAppVersions: Handler = async (request, context) => {
  const access = await appWithAccess(context, request.actor, positiveInt(payloadOf(request), 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  const [rows, names] = await Promise.all([context.db.tables.listAppVersions(access.app.id), userNames(context.db)]);
  return ok({ versions: rows.map((row) => versionSummary(row, names)) });
};

/** Copy a version into the draft (CAS); publishing it makes a new version (D5). */
const restoreAppVersion: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const version = positiveInt(payload, 'version');
  const draftRevision = positiveInt(payload, 'draftRevision');
  if (!version || !draftRevision) return fail('INVALID_INPUT', 'version and draftRevision are required');
  const access = await appWithAccess(context, request.actor, positiveInt(payload, 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  const restored = await context.db.tables.restoreAppVersion(access.app.id, { version, draftRevision });
  if (!restored.ok) {
    if (restored.reason === 'conflict') {
      return fail('CONFLICT', 'The draft changed since you loaded it', {
        reason: 'draft_conflict',
        currentRevision: restored.current,
      });
    }
    return fail('NOT_FOUND', restored.reason === 'version_not_found' ? 'Version not found' : 'App not found');
  }
  return ok(await draftView(context, request.actor, { ...access, app: restored.value }));
};

const listAppAudiences: Handler = async (request, context) => {
  const access = await appWithAccess(context, request.actor, positiveInt(payloadOf(request), 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  return ok(await audiencesView(context.db, access.app));
};

/** One entry → its row, or the reason it is refused. Groups newly named must be ones the granter may grant (D12). */
async function audienceRow(
  db: DatabaseProvider,
  actor: ActorContext,
  raw: unknown,
  keys: ReadonlySet<string>,
  keptGroups: ReadonlySet<number>,
): Promise<TableAppAudienceInput | string> {
  const entry = raw as Partial<AppAudienceEntry> | null;
  if (!entry || typeof entry !== 'object' || !entry.principal || typeof entry.principal !== 'object') {
    return 'Each entry needs a principal and a roleKey';
  }
  const roleKey = typeof entry.roleKey === 'string' ? entry.roleKey : '';
  if (!APP_ID_PATTERN.test(roleKey) || !keys.has(roleKey)) return `Role "${roleKey}" is not a role of this app`;
  const principal = entry.principal;
  if (principal.type === 'team') return { principal_type: 'team', role_key: roleKey };
  if (principal.type === 'user') {
    const user = typeof principal.userId === 'string' ? await db.users.getById(principal.userId) : undefined;
    if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
      return 'Audience people must be active internal users';
    }
    return { principal_type: 'user', user_id: user.id, role_key: roleKey };
  }
  if (principal.type === 'group') {
    const groupId = principal.groupId;
    if (typeof groupId !== 'number' || !Number.isInteger(groupId) || groupId <= 0) return 'group_not_found';
    const group = await db.groups.getById(groupId);
    if (!group) return 'group_not_found';
    if (!keptGroups.has(groupId)) {
      const userId = effectiveUserId(actor);
      const granter = await db.users.getById(userId);
      const visible =
        group.created_by === userId || granter?.role === 'super' || (await db.groups.isMember(groupId, userId));
      if (!visible) return 'group_not_found';
    }
    return { principal_type: 'group', group_id: groupId, role_key: roleKey };
  }
  return 'Each entry needs a person, a group, or the team';
}

/**
 * Owner / super: replace who the app is shared with (CAS on
 * `audiencesRevision`). Role keys must be roles of the live version or the
 * draft; a group not already on the app must be one the owner may grant —
 * its creator, a member, or a super (D12) — else 404 `group_not_found`.
 */
const setAppAudiences: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const audiencesRevision = positiveInt(payload, 'audiencesRevision');
  if (!audiencesRevision) return fail('INVALID_INPUT', 'audiencesRevision is required');
  if (!Array.isArray(payload.entries)) return fail('INVALID_INPUT', 'entries must be a list');
  const appId = positiveInt(payload, 'appId');
  const access = await appWithAccess(context, request.actor, appId, 'owner');
  if (!access)
    return forbiddenIfManager(request, context, appId, 'Only the Base owner can change who an app is shared with');
  const specs = await liveRoles(context.db, access.app);
  const keys = new Set([...(specs.live?.roles ?? []), ...(specs.draft?.roles ?? [])].map((role) => role.key));
  const keptGroups = new Set(
    (await context.db.tables.listAppAudiences(access.app.id)).flatMap((row) => (row.group_id ? [row.group_id] : [])),
  );
  const rows: TableAppAudienceInput[] = [];
  for (const raw of payload.entries) {
    const row = await audienceRow(context.db, request.actor, raw, keys, keptGroups);
    if (row === 'group_not_found') return fail('NOT_FOUND', 'Group not found', { reason: 'group_not_found' });
    if (typeof row === 'string') return fail('INVALID_INPUT', row);
    rows.push(row);
  }
  const replaced = await context.db.tables.replaceAppAudiences(access.app.id, {
    entries: rows,
    audiencesRevision,
    createdBy: effectiveUserId(request.actor),
  });
  if (!replaced.ok) {
    return replaced.reason === 'conflict'
      ? fail('CONFLICT', 'The audience changed since you loaded it', {
          reason: 'audiences_conflict',
          currentRevision: replaced.current,
        })
      : fail('NOT_FOUND', 'App not found');
  }
  return ok(await audiencesView(context.db, replaced.app));
};

/**
 * Hand the app to another responsible person: the Base owner / super, or the
 * current app owner while they still manage it. The new owner must manage the
 * Base (owner or builder) — someone who cannot edit it cannot answer for it.
 */
const transferApp: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const userId = stringValue(payload, 'userId');
  if (!userId) return fail('INVALID_INPUT', 'userId is required');
  const access = await appWithAccess(context, request.actor, positiveInt(payload, 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  if (!access.canPublish && access.app.owner_id !== effectiveUserId(request.actor)) {
    return fail('FORBIDDEN', 'Only the Base owner or the app owner can hand the app over');
  }
  const [target, base] = await Promise.all([
    context.db.users.getById(userId),
    context.db.tables.getBase(access.app.base_id),
  ]);
  const level = base ? (await resolveBaseAccess(context, target, base)).level : 'none';
  if (level === 'none' || level === 'custom' || !tableRoleAtLeast(level, 'builder')) {
    return fail('INVALID_INPUT', 'The new owner must be an owner or builder of the Base');
  }
  const app = await context.db.tables.transferApp(access.app.id, userId);
  if (!app) return fail('NOT_FOUND', 'App not found');
  return ok({ app: await summaryFor(context, request.actor, { ...access, app }) });
};

/** The Base owner / super archives any app; a manager may archive one that was never published. */
const archiveApp: Handler = async (request, context) => {
  const access = await appWithAccess(context, request.actor, positiveInt(payloadOf(request), 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  if (!access.canPublish && access.app.published_version !== null) {
    return fail('FORBIDDEN', 'Only the Base owner can archive a published app');
  }
  const app = await context.db.tables.archiveApp(access.app.id);
  if (!app) return fail('NOT_FOUND', 'App not found');
  return ok({ app: await summaryFor(context, request.actor, { ...access, app }) });
};

/** Super: recommend a published app to its audience (or stop). */
const featureApp: Handler = async (request, context) => {
  const payload = payloadOf(request);
  if (typeof payload.featured !== 'boolean') return fail('INVALID_INPUT', 'featured must be true or false');
  if (!(await isSuper(context.db, request.actor))) return fail('FORBIDDEN', 'Only an administrator can feature apps');
  const access = await appWithAccess(context, request.actor, positiveInt(payload, 'appId'), 'builder');
  if (!access) return fail('NOT_FOUND', 'App not found');
  if (payload.featured && access.app.status !== 'published') {
    return fail('INVALID_INPUT', 'Only a published app can be featured');
  }
  const app = await context.db.tables.setAppFeatured(access.app.id, payload.featured);
  if (!app) return fail('NOT_FOUND', 'App not found');
  return ok({ app: await summaryFor(context, request.actor, { ...access, app }) });
};

/** The caller's pinned apps that they can still open, in their order. */
const listAppPins: Handler = async (request, context) => {
  const visible = await visibleApps(context, request.actor);
  const byId = new Map([...visible.managed, ...visible.shared].map((app) => [app.id, app]));
  const pins = await context.db.tables.listAppPins(effectiveUserId(request.actor));
  return ok({ apps: pins.flatMap((pin) => (byId.has(pin.app_id) ? [byId.get(pin.app_id)!] : [])) });
};

/** Replace the caller's pins (order = sidebar order). Every app must be one they can open. */
const setAppPins: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const appIds = payload.appIds;
  if (!Array.isArray(appIds) || !appIds.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0)) {
    return fail('INVALID_INPUT', 'appIds must be a list of app ids');
  }
  const visible = await visibleApps(context, request.actor);
  const byId = new Map([...visible.managed, ...visible.shared].map((app) => [app.id, app]));
  if (!appIds.every((id) => byId.has(id))) return fail('NOT_FOUND', 'App not found');
  const pins = await context.db.tables.setAppPins(effectiveUserId(request.actor), appIds as number[]);
  return ok({ apps: pins.map((pin) => ({ ...byId.get(pin.app_id)!, pinned: true })) });
};

/**
 * A publish / audience call by someone below owner: 403 when they manage the
 * app (they can see it — a 404 would lie), 404 otherwise.
 */
async function forbiddenIfManager(
  request: HandlerRequest,
  context: Context,
  appId: number | undefined,
  message: string,
) {
  return (await appWithAccess(context, request.actor, appId, 'builder'))
    ? fail('FORBIDDEN', message, { reason: 'owner_only' })
    : fail('NOT_FOUND', 'App not found');
}

export const appHandlers = {
  listApps,
  getApp,
  createApp,
  updateApp,
  getAppDraft,
  saveAppDraft,
  publishApp,
  listAppVersions,
  restoreAppVersion,
  listAppAudiences,
  setAppAudiences,
  transferApp,
  archiveApp,
  featureApp,
  listAppPins,
  setAppPins,
  // The gateway: card queries, records, actions, activity, comments, options, files, usage.
  ...appGatewayHandlers,
} satisfies TablesHandlers;
