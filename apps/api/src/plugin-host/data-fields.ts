import { fieldPolicyFor, type EntityDefinition, type EntityPolicy } from '@greenhouse/platform-kernel';
import type { DataEntity } from './data-types.js';

/** Storage metadata is never client input, including when a column has a different field id. */
export function dataFieldIsSystem(key: string, config: DataEntity): boolean {
  const system = /^(?:id|created_?at|updated_?at|deleted_?at)$/i;
  return system.test(key) || system.test(config.columns?.[key] ?? key);
}

export function dataFieldAcceptsInput(entity: EntityDefinition, config: DataEntity, key: string): boolean {
  const field = Object.hasOwn(entity.fields, key) ? entity.fields[key] : undefined;
  if (!field || dataFieldIsSystem(key, config) || field.writable === false) return false;
  if (field.classification && field.classification !== 'public') return false;
  return key === config.ownerField || key === config.memberField ? field.writable === true : true;
}

export function dataWritableFields(entity: EntityDefinition, config: DataEntity, policy: EntityPolicy): string[] {
  return Object.keys(entity.fields).filter(
    (key) => dataFieldAcceptsInput(entity, config, key) && fieldPolicyFor(policy, key).write,
  );
}
