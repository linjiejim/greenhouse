import type { DatabaseProvider } from '@greenhouse/db';
type FieldPolicy = { read: 'full' | 'masked' | 'none'; write: boolean; export: boolean };

interface RestrictedRoleChange {
  /** The new role's capabilities, given the baseline team role's. */
  capabilities?: (team: string[]) => string[];
  /** Replace one entity policy of the copied team role. */
  entityPolicy?: {
    app_id: string;
    module_id: string;
    entity_id: string;
    scopes: Array<{ kind: 'all' }>;
    field_policies: Record<string, FieldPolicy>;
  };
}

let counter = 0;

/**
 * Move a user from the baseline team role to a copy of it with fewer
 * capabilities or one changed entity policy. Per-user overrides are gone in
 * 3.0, so roles are the only way a test can narrow one member's permissions.
 */
export async function moveToRestrictedRole(
  db: DatabaseProvider,
  userId: string,
  change: RestrictedRoleChange,
): Promise<void> {
  const team = await db.platform.getRoleByCode('default', 'team');
  if (!team) throw new Error('Platform baseline role "team" is missing');
  const teamCapabilities = (await db.platform.listRoleCapabilities([team.id])).map((row) => row.capability);
  counter += 1;
  const role = await db.platform.createRole({ code: `restricted_test_${Date.now()}_${counter}`, name: 'Restricted' });
  await db.platform.replaceRoleCapabilities(role.id, change.capabilities?.(teamCapabilities) ?? teamCapabilities);
  const replaced = change.entityPolicy;
  for (const policy of await db.platform.listRoleEntityPolicies([team.id])) {
    if (replaced && policy.app_id === replaced.app_id && policy.entity_id === replaced.entity_id) continue;
    await db.platform.upsertRoleEntityPolicy(role.id, {
      app_id: policy.app_id,
      module_id: policy.module_id,
      entity_id: policy.entity_id,
      scopes: policy.scopes,
      field_policies: policy.field_policies,
    } as Parameters<DatabaseProvider['platform']['upsertRoleEntityPolicy']>[1]);
  }
  if (replaced) await db.platform.upsertRoleEntityPolicy(role.id, replaced);
  const others = (await db.platform.listRoleBindings([team.id]))
    .map((binding) => binding.user_id)
    .filter((id) => id !== userId);
  await db.platform.replaceRoleBindings(team.id, others);
  await db.platform.bindRole(role.id, userId);
}

/** Every capability of the team role except `denied` (wildcards expanded through `expand`). */
export function withoutCapability(denied: string, expand: Record<string, readonly string[]>) {
  return (team: string[]) =>
    team.flatMap((capability) => expand[capability] ?? [capability]).filter((capability) => capability !== denied);
}
