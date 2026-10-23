/**
 * "Only the latest one counts" for optimistic edits. React-free (./latest.test.ts): each change
 * takes a ticket; when its answer comes back, only the newest ticket may apply or roll back —
 * an older change's late failure must not undo a newer change the member already made.
 */
export class Latest {
  private n = 0;

  /** A new change: answers whether it is still the newest one. */
  begin(): () => boolean {
    const mine = ++this.n;
    return () => mine === this.n;
  }
}
