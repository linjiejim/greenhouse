type Validator = (key: string, value: string) => string | null;
const validators: Validator[] = [];
export function registerWorkspaceSettingValidators(entries: Validator[]) {
  validators.push(...entries);
}
export function workspaceSettingValidators(): readonly Validator[] {
  return validators;
}

type RawValidator = (key: string, value: unknown) => import('./workspace-config.js').ValidationResult | null;
let rawValidators: RawValidator[] = [];
export function registerWorkspaceSettingValueValidators(entries: RawValidator[]) {
  rawValidators = entries;
}
export function workspaceSettingValueValidators() {
  return rawValidators;
}
