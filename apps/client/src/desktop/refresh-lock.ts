export function withRefreshLock(_station: string | null, refresh: () => Promise<boolean>): Promise<boolean> {
  return refresh();
}
