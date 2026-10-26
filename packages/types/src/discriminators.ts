/** Open persisted discriminators: validate new writes, preserve historical reads. */
import { RUNTIME_RUN_KINDS } from './runtime.js';
export interface DiscriminatorValues {
  shareResources?: readonly string[];
  fileLinkTargets?: readonly string[];
  folderScopes?: readonly string[];
  auditApps?: readonly string[];
  runKinds?: readonly string[];
  artifactKinds?: readonly string[];
}
export type Discriminator = keyof DiscriminatorValues;
const core: Required<DiscriminatorValues> = {
  shareResources: ['folder', 'file'],
  fileLinkTargets: ['message'],
  folderScopes: [],
  auditApps: ['platform', 'drive', 'connectors'],
  runKinds: RUNTIME_RUN_KINDS,
  artifactKinds: ['task_capture'],
};
const registered = new Map<Discriminator, Set<string>>();
export function registerDiscriminators(values: DiscriminatorValues): void {
  for (const key of Object.keys(values) as Discriminator[]) {
    const set = registered.get(key) ?? new Set<string>();
    for (const value of values[key] ?? []) {
      if (!/^[a-z][a-z0-9_.:-]*$/.test(value)) throw new Error(`Invalid ${key} value: ${value}`);
      set.add(value);
    }
    registered.set(key, set);
  }
}
export function isRegisteredDiscriminator(key: Discriminator, value: string): boolean {
  return core[key].includes(value) || registered.get(key)?.has(value) === true;
}
export function assertDiscriminator(key: Discriminator, value: string): void {
  if (!isRegisteredDiscriminator(key, value)) throw new Error(`Unregistered ${key} value: ${value}`);
}
export function _resetDiscriminators(): void {
  registered.clear();
}

export interface DrivePlacementInput {
  scope: string;
  base_id?: string | number | null;
  visibility?: string | null;
  owner_user_id?: string | null;
  owner_key?: string | null;
}
const validators = new Map<string, (input: DrivePlacementInput) => boolean>();
export function registerDrivePlacements(
  defs: readonly { scope: string; validate: (input: DrivePlacementInput) => boolean }[],
): void {
  for (const def of defs) validators.set(def.scope, def.validate);
}
export function assertDrivePlacement(input: DrivePlacementInput): void {
  assertDiscriminator('folderScopes', input.scope);
  const valid =
    validators.get(input.scope)?.(input) ??
    (input.owner_key != null && input.base_id == null && input.visibility == null && input.owner_user_id == null);
  if (!valid) throw new Error(`Invalid placement for drive scope: ${input.scope}`);
}
