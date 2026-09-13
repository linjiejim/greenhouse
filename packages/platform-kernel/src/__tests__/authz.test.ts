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

  it('applies user deny before every allow', () => {
    const decision = resolveCapability({
      capability: 'projects.project.read',
      roleGrants,
      userOverrides: [
        { source: 'user', capability: 'projects.project.read', effect: 'allow' },
        { source: 'user', capability: 'projects.*', effect: 'deny' },
      ],
    });

    expect(decision).toMatchObject({ allowed: false, reason: 'user-deny' });
  });

  it('applies user allow before role allow and defaults to deny', () => {
    expect(
      resolveCapability({
        capability: 'knowledge.document.read',
        roleGrants,
        userOverrides: [{ source: 'user', capability: 'knowledge.*', effect: 'allow' }],
      }),
    ).toMatchObject({ allowed: true, reason: 'user-allow' });

    expect(
      resolveCapability({
        capability: 'crm.deal.read',
        roleGrants,
        userOverrides: [],
      }),
    ).toMatchObject({ allowed: true, reason: 'role-allow', sourceId: 'crm-reader' });

    expect(
      resolveCapability({
        capability: 'crm.deal.delete',
        roleGrants,
        userOverrides: [],
      }),
    ).toMatchObject({ allowed: false, reason: 'default-deny' });
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

  it('lets a user deny replace all role entity access', () => {
    expect(resolveEntityPolicy([memberPolicy], { effect: 'deny' })).toEqual({ scopes: [], fields: {} });
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
