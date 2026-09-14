/**
 * Idempotent Platform Kernel bootstrap.
 *
 * It publishes/activates registered manifests, creates the protected internal
 * role bridge, adds only missing baseline grants/policies, and synchronizes
 * active internal users to exactly one system role. Custom roles and explicit
 * user overrides are never removed.
 */

import { randomUUID } from 'node:crypto';
import type { ApplicationManifest, DataScope, FieldPolicy } from '@greenhouse/platform-kernel';
import type { DatabaseProvider, PlatformRoleRow, UserRole } from '@greenhouse/db';
import { projectsManifest } from './manifests/projects.js';
import { knowledgeManifest } from './manifests/knowledge.js';
import { tablesManifest } from './manifests/tables.js';
import { PLATFORM_ORG_ID } from './runtime.js';
import { extensionApplicationPlans } from '../extensions/boot.js';

type InternalUserRole = Exclude<UserRole, 'external'>;

export interface PlatformBootstrapResult {
  appReleasesActivated: string[];
  rolesCreated: string[];
  capabilitiesAdded: number;
  entityPoliciesAdded: number;
  bindingsSynchronized: number;
}

/** Control-plane capabilities are not owned by a business application manifest. */
export const PLATFORM_CONTROL_CAPABILITIES = [
  'platform.app.read',
  'platform.app.release',
  'platform.role.read',
  'platform.role.manage',
  'platform.permission.read',
  'platform.permission.manage',
  'platform.audit.read',
  'platform.oauth.manageOwn',
  'platform.oauth.manageAll',
] as const;

interface ApplicationBootstrapPlan {
  manifest: ApplicationManifest;
  /** Baseline capabilities that preserve the current internal-user behavior. */
  teamCapabilities: readonly string[];
  /**
   * Entities the `team` role may export in full. Empty by default: bulk export
   * of a whole dataset is a deliberate grant, not something a new application
   * gets for free.
   */
  teamExportableEntities?: readonly string[];
}

const SYSTEM_ROLES: ReadonlyArray<{
  code: InternalUserRole;
  name: string;
  description: string;
}> = [
  {
    code: 'super',
    name: 'Super administrator',
    description: 'Protected legacy super role. Grants full platform access; explicit user deny still wins.',
  },
  {
    code: 'team',
    name: 'Team member',
    description: 'Protected baseline role for active internal team members.',
  },
];

const CORE_APPLICATIONS: readonly ApplicationBootstrapPlan[] = [
  {
    manifest: projectsManifest,
    teamCapabilities: ['projects.*'],
  },
  {
    manifest: knowledgeManifest,
    teamCapabilities: ['knowledge.*'],
  },
  {
    manifest: tablesManifest,
    teamCapabilities: ['tables.*'],
  },
];

/** Core applications followed by the ones active extensions own. */
const APPLICATIONS: readonly ApplicationBootstrapPlan[] = [...CORE_APPLICATIONS, ...extensionApplicationPlans()];

function fullFieldPolicy(
  manifest: ApplicationManifest,
  entityId: string,
  write: boolean,
  exportable: boolean,
): Record<string, FieldPolicy> {
  const entity = manifest.entities[entityId];
  if (!entity) return {};
  return Object.fromEntries(
    Object.keys(entity.fields).map((fieldId) => [
      fieldId,
      {
        read: 'full' as const,
        write,
        export: exportable,
      },
    ]),
  );
}

function declaredScopes(manifest: ApplicationManifest, entityId: string): DataScope[] {
  const entity = manifest.entities[entityId];
  if (!entity) return [];
  return entity.accessScopes.map((kind) => {
    if (kind === 'department' || kind === 'departmentTree') return { kind, departmentIds: [] };
    return { kind };
  });
}

async function ensureSystemRoles(
  db: DatabaseProvider,
  result: PlatformBootstrapResult,
): Promise<Record<InternalUserRole, PlatformRoleRow>> {
  const roles = {} as Record<InternalUserRole, PlatformRoleRow>;
  for (const definition of SYSTEM_ROLES) {
    const existing = await db.platform.getRoleByCode(PLATFORM_ORG_ID, definition.code);
    const role = await db.platform.ensureRole({
      org_id: PLATFORM_ORG_ID,
      code: definition.code,
      name: definition.name,
      description: definition.description,
      system_protected: true,
    });
    roles[definition.code] = role;
    if (!existing) result.rolesCreated.push(definition.code);
  }
  return roles;
}

async function addBaselineCapabilities(
  db: DatabaseProvider,
  roles: Record<InternalUserRole, PlatformRoleRow>,
  result: PlatformBootstrapResult,
): Promise<void> {
  const roleIds = Object.values(roles).map((role) => role.id);
  const existing = await db.platform.listRoleCapabilities(roleIds);
  const byRole = new Map<string, Set<string>>();
  for (const row of existing) {
    const values = byRole.get(row.role_id) ?? new Set<string>();
    values.add(row.capability);
    byRole.set(row.role_id, values);
  }

  const defaults: Array<[PlatformRoleRow, readonly string[]]> = [
    [roles.super, ['*']],
    [roles.team, [...APPLICATIONS.flatMap((application) => application.teamCapabilities), 'platform.oauth.manageOwn']],
  ];
  for (const [role, required] of defaults) {
    const current = byRole.get(role.id) ?? new Set<string>();
    const merged = new Set(current);
    for (const capability of required) {
      if (!merged.has(capability)) result.capabilitiesAdded += 1;
      merged.add(capability);
    }
    if (merged.size !== current.size) {
      await db.platform.replaceRoleCapabilities(role.id, [...merged]);
    }
  }
}

async function addBaselineEntityPolicies(
  db: DatabaseProvider,
  roles: Record<InternalUserRole, PlatformRoleRow>,
  result: PlatformBootstrapResult,
): Promise<void> {
  const existing = await db.platform.listRoleEntityPolicies([roles.super.id, roles.team.id]);
  const keys = new Set(existing.map((row) => `${row.role_id}:${row.app_id}:${row.entity_id}`));

  // The system roles' baseline policies are DERIVED from the manifest (super = full;
  // team = declared scopes with export disabled unless the capability is explicitly
  // committed below), not admin-customized (custom roles + user overrides live in
  // separate rows). So we re-upsert them every boot: this keeps their
  // field_policies in lockstep with the manifest when a new app version adds fields.
  // Without this, a field added to an already-bootstrapped app is denied on write and
  // silently dropped on read. `entityPoliciesAdded` still counts only brand-new keys,
  // preserving the idempotent "no changes on unchanged re-bootstrap" contract.
  for (const application of APPLICATIONS) {
    for (const entity of Object.values(application.manifest.entities)) {
      await db.platform.upsertRoleEntityPolicy(roles.super.id, {
        app_id: application.manifest.id,
        module_id: entity.module,
        entity_id: entity.id,
        scopes: [{ kind: 'all' }],
        field_policies: fullFieldPolicy(application.manifest, entity.id, true, true),
      });
      const superKey = `${roles.super.id}:${application.manifest.id}:${entity.id}`;
      if (!keys.has(superKey)) result.entityPoliciesAdded += 1;

      await db.platform.upsertRoleEntityPolicy(roles.team.id, {
        app_id: application.manifest.id,
        module_id: entity.module,
        entity_id: entity.id,
        scopes: declaredScopes(application.manifest, entity.id),
        field_policies: fullFieldPolicy(
          application.manifest,
          entity.id,
          entity.id !== 'activity',
          application.teamExportableEntities?.includes(entity.id) ?? false,
        ),
      });
      const teamKey = `${roles.team.id}:${application.manifest.id}:${entity.id}`;
      if (!keys.has(teamKey)) result.entityPoliciesAdded += 1;
    }
  }
}

async function publishApplications(db: DatabaseProvider, result: PlatformBootstrapResult): Promise<void> {
  const active = await db.platform.listActiveAppReleases();
  const activeByApp = new Map(active.map((row) => [row.app_id, row]));
  for (const application of APPLICATIONS) {
    const release = await db.platform.publishAppRelease({ manifest: application.manifest });
    if (activeByApp.get(application.manifest.id)?.id !== release.id) {
      await db.platform.activateAppRelease(release.id);
      result.appReleasesActivated.push(`${application.manifest.id}@${application.manifest.version}`);
    }
  }
}

async function synchronizeLegacyBindings(
  db: DatabaseProvider,
  roles: Record<InternalUserRole, PlatformRoleRow>,
  result: PlatformBootstrapResult,
): Promise<void> {
  const users = await db.users.list();
  for (const role of SYSTEM_ROLES) {
    const userIds = users.filter((user) => user.status === 'active' && user.role === role.code).map((user) => user.id);
    await db.platform.replaceRoleBindings(roles[role.code].id, userIds);
  }
  result.bindingsSynchronized = users.filter(
    (user) => user.status === 'active' && (user.role === 'super' || user.role === 'team'),
  ).length;
}

export async function bootstrapPlatform(db: DatabaseProvider): Promise<PlatformBootstrapResult> {
  const result: PlatformBootstrapResult = {
    appReleasesActivated: [],
    rolesCreated: [],
    capabilitiesAdded: 0,
    entityPoliciesAdded: 0,
    bindingsSynchronized: 0,
  };

  await db.platform.ensureOrganization({
    id: PLATFORM_ORG_ID,
    code: PLATFORM_ORG_ID,
    name: 'Greenhouse',
  });
  const roles = await ensureSystemRoles(db, result);
  await publishApplications(db, result);
  await addBaselineCapabilities(db, roles, result);
  await addBaselineEntityPolicies(db, roles, result);
  await synchronizeLegacyBindings(db, roles, result);

  if (
    result.appReleasesActivated.length > 0 ||
    result.rolesCreated.length > 0 ||
    result.capabilitiesAdded > 0 ||
    result.entityPoliciesAdded > 0
  ) {
    await db.platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: 'platform-bootstrap',
      actorType: 'migration',
      requestId: randomUUID(),
      resource: { appId: 'platform' },
      actionId: 'bootstrap',
      capability: 'platform.system.bootstrap',
      result: 'success',
      summary: { ...result },
    });
  }

  return result;
}
