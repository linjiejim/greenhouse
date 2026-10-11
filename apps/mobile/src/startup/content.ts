/** The focused launch surface, not every screen mounted underneath a deep link. */
export class StartupContent {
  private owner: object | null = null;
  private ready = false;
  private listeners = new Set<() => void>();

  getSnapshot = (): boolean => this.ready;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  report(owner: object, ready: boolean): () => void {
    this.owner = owner;
    this.setReady(ready);
    return () => {
      // A forwarder / previous screen may unmount after its replacement reports.
      if (this.owner !== owner) return;
      this.owner = null;
      this.setReady(false);
    };
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    for (const listener of this.listeners) listener();
  }
}

/** Other deep-linked pages keep their own loading UI; never wait for the home below them. */
export function waitsForHome(segments: readonly string[]): boolean {
  const [group, page] = segments;
  return !group || group === '(drawer)' || group === 'chat' || (group === 'bots' && (!page || page === 'index'));
}

/** Extra grace after auth/fonts and the mark are ready, not a new minimum launch duration. */
export const STARTUP_CONTENT_GRACE_MS = 1500;
