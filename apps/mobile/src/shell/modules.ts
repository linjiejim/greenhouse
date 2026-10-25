/**
 * Which parts of the hub a member sees. React-free (./modules.test.ts). The tabs are fixed
 * (首页 · 知识库 · 云盘 · 项目; search opens from home); Tables is a segment of 云盘 shown only to members with
 * the `tables` feature (supers always have it), as the server's `requireFeature('tables')` decides.
 */

export function hasTables(user: { role: string; features?: Record<string, boolean> } | null | undefined): boolean {
  return !!user && (user.role === 'super' || user.features?.tables === true);
}
