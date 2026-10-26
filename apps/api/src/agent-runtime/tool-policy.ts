/** Kept outside the tool catalog so catalog construction cannot recurse into itself. */
export const UNATTENDED_TOOL_DENYLIST = new Set(['automation_mutation']);
export function registerUnattendedDeniedTools(ids: readonly string[]) {
  UNATTENDED_TOOL_DENYLIST.clear();
  UNATTENDED_TOOL_DENYLIST.add('automation_mutation');
  for (const id of ids) UNATTENDED_TOOL_DENYLIST.add(id);
}

export const DISPATCH_TOOL_IDS: string[] = ['task_capture'];
export function registerInteractiveTools(ids: readonly string[]): void {
  for (const id of ids) if (!DISPATCH_TOOL_IDS.includes(id)) DISPATCH_TOOL_IDS.push(id);
}
