import { describe, expect, it } from 'vitest';

import {
  canAccessRecord,
  capabilityMatches,
  fieldPolicyFor,
  isCapabilityPattern,
  projectReadableFields,
  resolveCapability,
  resolveEntityPolicy,
  validateEntityPolicy,
  type EntityPolicy,
} from '../authz.js';
import type { ActorContext } from '../contract.js';

const actor: ActorContext = {
  actorId: 'oauth-client-1',
  actorType: 'agent',
  onBehalfOfUserId: 'user-1',
  clientId: 'oauth-client-1',
  orgId: 'default',
  requestId: 'request-1',
  authMethod: 'oauth',
};

describe('resolveCapability', () => {
  const roleGrants = [
    { source: 'role' as const, roleId: 'member', capability: 'projects.project.*' },
    { source: 'role' as const, roleId: 'crm-reader', capability: 'crm.deal.read' },
  ];

  it('uses exact and terminal wildcard matches only', () => {
    expect(isCapabilityPattern('*')).toBe(true);
    expect(isCapabilityPattern('crm.*')).toBe(true);
    expect(isCapabilityPattern('crm.deal.*')).toBe(true);
    expect(isCapabilityPattern('crm.*.read')).toBe(false);
    expect(capabilityMatches('*', 'crm.deal.read')).toBe(true);
    expect(capabilityMatches('crm.*', 'crm.deal.read')).toBe(true);
    expect(capabilityMatches('crm.deal.*', 'crm.deal.read')).toBe(true);
    expect(capabilityMatches('crm.*.read', 'crm.deal.read')).toBe(false);
    expect(capabilityMatches('crm.deal.read', 'crm.deal.readAll')).toBe(false);
  });

  it('allows through a matching role grant and defaults to deny', () => {
    expect(resolveCapability({ capability: 'crm.deal.read', roleGrants })).toMatchObject({
      allowed: true,
      reason: 'role-allow',
      sourceId: 'crm-reader',
    });
    expect(resolveCapability({ capability: 'crm.deal.delete', roleGrants })).toMatchObject({
      allowed: false,
      reason: 'default-deny',
    });
  });
});

describe('entity policies', () => {
  const memberPolicy: EntityPolicy = {
    scopes: [{ kind: 'own' }, { kind: 'collaborating' }],
    fields: {
      title: { read: 'full', write: true, export: true },
      budget: { read: 'masked', write: false, export: false },
    },
  };
  const managerPolicy: EntityPolicy = {
    scopes: [{ kind: 'department', departmentIds: ['sales'] }],
    fields: {
      budget: { read: 'full', write: true, export: false },
    },
  };

  it('merges role scopes and chooses the most permissive field policy', () => {
    const policy = resolveEntityPolicy([memberPolicy, managerPolicy]);

    expect(policy.scopes).toHaveLength(3);
    expect(fieldPolicyFor(policy, 'budget')).toEqual({ read: 'full', write: true, export: false });
    expect(fieldPolicyFor(policy, 'missing')).toEqual({ read: 'none', write: false, export: false });
  });

  it('evaluates record access against the effective user, including agents', () => {
    const policy = resolveEntityPolicy([memberPolicy]);

    expect(canAccessRecord(actor, { ownerId: 'user-1' }, policy)).toBe(true);
    expect(canAccessRecord(actor, { collaboratorIds: ['user-1'] }, policy)).toBe(true);
    expect(canAccessRecord(actor, { ownerId: 'user-2' }, policy)).toBe(false);
  });

  it('projects and masks fields without leaking denied fields', () => {
    const output = projectReadableFields(
      { title: 'Launch', budget: 100_000, secret: 'hidden' },
      memberPolicy,
      (_field, value) => (typeof value === 'number' ? '***' : value),
    );

    expect(output).toEqual({ title: 'Launch', budget: '***' });
  });

  it('rejects malformed persisted scopes and field policies at runtime', () => {
    expect(() =>
      validateEntityPolicy({
        scopes: [{ kind: 'department', departmentIds: 'sales' }],
        fields: {},
      }),
    ).toThrow(/departmentIds 必须是字符串数组/);

    expect(() =>
      validateEntityPolicy({
        scopes: [{ kind: 'all' }],
        fields: { budget: { read: 'full', write: 'yes', export: false } },
      }),
    ).toThrow(/字段策略 budget 格式非法/);
  });
});
