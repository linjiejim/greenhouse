import { getPlatformRuntime, humanActor, userHasFeature, type DriveScopeDef } from '@greenhouse/api/extension-kit';
import { services } from './services.js';
export const tablesDriveScope: DriveScopeDef = {
  scope: 'tables',
  validatePlacement: (i) => i.base_id != null && i.owner_key == null && i.visibility == null && i.owner_user_id == null,
  placement: (input) =>
    input.base_id
      ? { base_id: input.base_id, visibility: null, owner_user_id: null, owner_key: null }
      : { error: 'base_id is required for tables scope' },
  authorize: async () => null,
  authorizeNode: async (node, ctx) => {
    if (!node.base_id || !(await userHasFeature(ctx.userId, ctx.userRole, 'tables', ctx.db))) return null;
    const actor = humanActor({ id: ctx.userId });
    const decision = await getPlatformRuntime().authorize(
      actor,
      ctx.operation === 'read' ? 'tables.data.read' : 'tables.data.update',
    );
    if (!decision.allowed) return null;
    const [base, member] = await Promise.all([
      services(ctx.db).tables.getBase(node.base_id),
      services(ctx.db).tables.getBaseMember(node.base_id, ctx.userId),
    ]);
    if (!base || base.archived_at) return null;
    if (ctx.userRole === 'super' || base.owner_id === ctx.userId) return 'owner';
    const role = member?.role ?? (base.visibility === 'team' ? 'viewer' : null);
    return role === 'owner'
      ? 'owner'
      : role === 'builder' || role === 'editor'
        ? 'editor'
        : role === 'viewer'
          ? 'reader'
          : null;
  },
};
