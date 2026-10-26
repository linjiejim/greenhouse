/** Kept outside the tool catalog so catalog construction cannot recurse into itself. */
export const UNATTENDED_TOOL_DENYLIST = new Set(['automation_mutation']);
export function registerUnattendedDeniedTools(ids: readonly string[]) {
  UNATTENDED_TOOL_DENYLIST.clear();
  UNATTENDED_TOOL_DENYLIST.add('automation_mutation');
  for (const id of ids) UNATTENDED_TOOL_DENYLIST.add(id);
}
