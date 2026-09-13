import { effectiveUserId, type ActorContext } from './contract.js';

const EXACT_CAPABILITY_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){2,}$/;
const WILDCARD_CAPABILITY_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*\.\*$/;

export type CapabilityEffect = 'allow' | 'deny';

export interface RoleCapabilityGrant {
  source: 'role';
  roleId: string;
  capability: string;
}

export interface UserCapabilityOverride {
  source: 'user';
  capability: string;
  effect: CapabilityEffect;
}

export interface CapabilityResolutionInput {
  capability: string;
  roleGrants: readonly RoleCapabilityGrant[];
  userOverrides: readonly UserCapabilityOverride[];
}

export interface CapabilityDecision {
  allowed: boolean;
  capability: string;
  reason: 'user-deny' | 'user-allow' | 'role-allow' | 'default-deny';
  matchedPattern?: string;
  sourceId?: string;
}

export function isExactCapability(value: string): boolean {
  return EXACT_CAPABILITY_PATTERN.test(value);
}

export function isCapabilityPattern(value: string): boolean {
  return value === '*' || isExactCapability(value) || WILDCARD_CAPABILITY_PATTERN.test(value);
}

/**
 * Match an exact capability or a terminal wildcard (`crm.*`,
 * `crm.deal.*`, or `*`). Middle-segment wildcards are intentionally rejected.
 */
export function capabilityMatches(pattern: string, capability: string): boolean {
  if (!isCapabilityPattern(pattern) || !isExactCapability(capability)) return false;
  if (pattern === '*') return true;
  if (!pattern.endsWith('.*')) return pattern === capability;
  const prefix = pattern.slice(0, -1);
  return capability.startsWith(prefix);
}

/**
 * Resolve one capability using the platform precedence contract:
 * user deny > user allow > role allow > default deny.
 */
export function resolveCapability(input: CapabilityResolutionInput): CapabilityDecision {
  const matchingOverrides = input.userOverrides.filter((item) => capabilityMatches(item.capability, input.capability));
  const userDeny = matchingOverrides.find((item) => item.effect === 'deny');
  if (userDeny) {
    return {
      allowed: false,
      capability: input.capability,
      reason: 'user-deny',
      matchedPattern: userDeny.capability,
    };
  }

  const userAllow = matchingOverrides.find((item) => item.effect === 'allow');
  if (userAllow) {
    return {
      allowed: true,
      capability: input.capability,
      reason: 'user-allow',
      matchedPattern: userAllow.capability,
    };
  }

  const roleAllow = input.roleGrants.find((item) => capabilityMatches(item.capability, input.capability));
  if (roleAllow) {
    return {
      allowed: true,
      capability: input.capability,
      reason: 'role-allow',
      matchedPattern: roleAllow.capability,
      sourceId: roleAllow.roleId,
    };
  }

  return {
    allowed: false,
    capability: input.capability,
    reason: 'default-deny',
  };
}

export type DataScope =
  | { kind: 'own' }
  | { kind: 'collaborating' }
  | { kind: 'assigned' }
  | { kind: 'department'; departmentIds: readonly string[] }
  | { kind: 'departmentTree'; departmentIds: readonly string[] }
  | { kind: 'all' };

export type FieldReadPolicy = 'full' | 'masked' | 'none';

export interface FieldPolicy {
  read: FieldReadPolicy;
  write: boolean;
  export: boolean;
}

export interface EntityPolicy {
  scopes: readonly DataScope[];
  fields: Readonly<Record<string, FieldPolicy>>;
}

export interface UserEntityPolicyOverride {
  effect: CapabilityEffect;
  policy?: EntityPolicy;
}

export interface RecordAccessFacts {
  ownerId?: string | null;
  collaboratorIds?: readonly string[];
  assigneeId?: string | null;
  departmentId?: string | null;
  departmentAncestorIds?: readonly string[];
}

const NO_FIELD_ACCESS: Readonly<FieldPolicy> = Object.freeze({ read: 'none', write: false, export: false });
const READ_RANK: Record<FieldReadPolicy, number> = { none: 0, masked: 1, full: 2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateScope(value: unknown, index: number): DataScope {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new PolicyValidationError(`scopes[${index}] 格式非法`);
  }
  if (value.kind === 'own' || value.kind === 'collaborating' || value.kind === 'assigned' || value.kind === 'all') {
    return { kind: value.kind };
  }
  if (value.kind === 'department' || value.kind === 'departmentTree') {
    if (!Array.isArray(value.departmentIds) || !value.departmentIds.every((id) => typeof id === 'string')) {
      throw new PolicyValidationError(`scopes[${index}].departmentIds 必须是字符串数组`);
    }
    return { kind: value.kind, departmentIds: [...value.departmentIds] };
  }
  throw new PolicyValidationError(`scopes[${index}].kind "${value.kind}" 不受支持`);
}

/** Runtime validation at persistence and authorization boundaries. */
export function validateEntityPolicy(value: unknown): EntityPolicy {
  if (!isRecord(value) || !Array.isArray(value.scopes) || !isRecord(value.fields)) {
    throw new PolicyValidationError('实体策略必须包含 scopes 数组和 fields 对象');
  }
  const fields: Record<string, FieldPolicy> = {};
  for (const [fieldId, policy] of Object.entries(value.fields)) {
    if (
      !isRecord(policy) ||
      (policy.read !== 'full' && policy.read !== 'masked' && policy.read !== 'none') ||
      typeof policy.write !== 'boolean' ||
      typeof policy.export !== 'boolean'
    ) {
      throw new PolicyValidationError(`字段策略 ${fieldId} 格式非法`);
    }
    fields[fieldId] = {
      read: policy.read,
      write: policy.write,
      export: policy.export,
    };
  }
  return {
    scopes: value.scopes.map(validateScope),
    fields,
  };
}

function mergeFieldPolicies(current: FieldPolicy | undefined, incoming: FieldPolicy): FieldPolicy {
  if (!current) return { ...incoming };
  return {
    read: READ_RANK[incoming.read] > READ_RANK[current.read] ? incoming.read : current.read,
    write: current.write || incoming.write,
    export: current.export || incoming.export,
  };
}

/**
 * Role policies are additive. A user entity override replaces the merged role
 * policy; a deny override produces an empty policy.
 */
export function resolveEntityPolicy(
  rolePolicies: readonly EntityPolicy[],
  userOverride?: UserEntityPolicyOverride,
): EntityPolicy {
  if (userOverride?.effect === 'deny') {
    return { scopes: [], fields: {} };
  }
  if (userOverride?.effect === 'allow') {
    return userOverride.policy ? validateEntityPolicy(userOverride.policy) : { scopes: [], fields: {} };
  }

  const scopes: DataScope[] = [];
  const seenScopes = new Set<string>();
  const fields: Record<string, FieldPolicy> = {};
  for (const inputPolicy of rolePolicies) {
    const policy = validateEntityPolicy(inputPolicy);
    for (const scope of policy.scopes) {
      const key = JSON.stringify(scope);
      if (!seenScopes.has(key)) {
        seenScopes.add(key);
        scopes.push(scope);
      }
    }
    for (const [fieldId, fieldPolicy] of Object.entries(policy.fields)) {
      fields[fieldId] = mergeFieldPolicies(fields[fieldId], fieldPolicy);
    }
  }
  return { scopes, fields };
}

export function canAccessRecord(actor: ActorContext, facts: RecordAccessFacts, policy: EntityPolicy): boolean {
  const userId = effectiveUserId(actor);
  return policy.scopes.some((scope) => {
    switch (scope.kind) {
      case 'all':
        return true;
      case 'own':
        return facts.ownerId === userId;
      case 'collaborating':
        return facts.collaboratorIds?.includes(userId) ?? false;
      case 'assigned':
        return facts.assigneeId === userId;
      case 'department':
        return facts.departmentId ? scope.departmentIds.includes(facts.departmentId) : false;
      case 'departmentTree': {
        const recordDepartments = [
          ...(facts.departmentId ? [facts.departmentId] : []),
          ...(facts.departmentAncestorIds ?? []),
        ];
        return recordDepartments.some((id) => scope.departmentIds.includes(id));
      }
    }
  });
}

export function fieldPolicyFor(policy: EntityPolicy, fieldId: string): Readonly<FieldPolicy> {
  return policy.fields[fieldId] ?? NO_FIELD_ACCESS;
}

export function projectReadableFields<T extends Record<string, unknown>>(
  input: T,
  policy: EntityPolicy,
  mask: (fieldId: string, value: unknown) => unknown,
): Partial<T> {
  const output: Partial<T> = {};
  for (const [fieldId, value] of Object.entries(input)) {
    const fieldPolicy = fieldPolicyFor(policy, fieldId);
    if (fieldPolicy.read === 'full') {
      output[fieldId as keyof T] = value as T[keyof T];
    } else if (fieldPolicy.read === 'masked') {
      output[fieldId as keyof T] = mask(fieldId, value) as T[keyof T];
    }
  }
  return output;
}

export class AuthorizationDeniedError extends Error {
  readonly code = 'AUTHORIZATION_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationDeniedError';
  }
}

export class PolicyValidationError extends Error {
  readonly code = 'INVALID_AUTHORIZATION_POLICY';

  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}
