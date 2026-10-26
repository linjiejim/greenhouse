type Validator = (key: string, value: string) => string | null;
const validators: Validator[] = [];
export function registerWorkspaceSettingValidators(entries: Validator[]) {
  validators.push(...entries);
}
export function workspaceSettingValidators(): readonly Validator[] {
  return validators;
}
