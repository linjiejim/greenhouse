/**
 * Which parts of the hub a member sees. React-free (./modules.test.ts). The sidebar's places are fixed
 * (首页 · 搜索 · 知识库 · 云盘 · 项目, src/shell/sidebar-content.tsx); Tables is a segment of 云盘 shown only to members with
 * the `tables` feature (supers always have it), as the server's `requireFeature('tables')` decides.
 */

export function hasTables(user: { role: string; features?: Record<string, boolean> } | null | undefined): boolean {
  return !!user && (user.role === 'super' || user.features?.tables === true);
}
